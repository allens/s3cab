#!/usr/bin/env python3
"""s3cab-backup.py -- a clean-room backup writer for the s3cab repository format.

    python s3cab-backup.py <bucket> <set> <dir>...

Walks the member directories, stores every file's content at objects/<sha256>,
then uploads the snapshot that names them to snapshots/<set>/<YYYYMMDDTHHMM>.tsv.gz,
claiming snapshots/<set>.info for this machine on the set's first backup.

Written from the format spec alone (format.md, spec of 2026-10-30). Standard
library plus boto3 only. Correct rather than fast: no caches, no parallelism.

State kept between runs, beside this file: s3cab-backup.state.json, holding the
OWNER/CLAIMED pair written to each set's .info (the spec says a writer keeps it).

Environment knobs (none change the command line):
    S3CAB_BACKUP_TAKEOVER=1      take the set over (rewrite .info) when it is held by
                                 another holder, or has snapshots and no .info
    S3CAB_BACKUP_PART_THRESHOLD  bytes; files at or above this go up as a multipart
                                 upload (default 256 MiB; S3's single PUT limit is 5 GiB)

Exit status: 0 snapshot uploaded with no #error rows; 1 snapshot uploaded but it
holds #error rows, or the run stopped and nothing was uploaded; 2 bad usage.
"""

import base64
import errno
import getpass
import gzip
import hashlib
import io
import json
import os
import re
import socket
import stat
import sys
import time

try:
    import boto3
    from botocore.config import Config
    from botocore.exceptions import ClientError
except ImportError:  # pragma: no cover
    sys.stderr.write("s3cab-backup: boto3 is required (pip install boto3)\n")
    sys.exit(2)

# ----------------------------------------------------------------------------
# Constants fixed by the spec
# ----------------------------------------------------------------------------

SPEC_DATE = "2026-10-30"
FORMAT_URL = "https://s3cab.plantegral.com/guide/format"
CLIENT_NAME = "s3cab-backup-py"
CLIENT_VERSION = "0.1.0"

COL2_WIDTH = 64
COL3_WIDTH = 12
COL4_WIDTH = 24

EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"

SNAPSHOT_KEY_RE = re.compile(r"^[0-9]{8}T[0-9]{4}\.tsv\.gz$")
SET_NAME_RE = re.compile(r"^[a-z0-9]+(-[a-z0-9]+)*$")
HEX64_RE = re.compile(r"^[0-9a-f]{64}$")

WINDOWS = os.name == "nt"
SEP = os.sep

PART_SIZE = 16 * 1024 * 1024
DEFAULT_PART_THRESHOLD = 256 * 1024 * 1024
SINGLE_PUT_MAX = 5 * 1024 * 1024 * 1024

CONTROL_PICTURES = {"\t": "␉", "\r": "␍", "\n": "␊"}


class Stop(Exception):
    """The run stops without a snapshot; the message says why."""


# ----------------------------------------------------------------------------
# Output helpers
# ----------------------------------------------------------------------------

def _reconfigure_streams():
    for s in (sys.stdout, sys.stderr):
        try:
            s.reconfigure(encoding="utf-8", errors="backslashreplace")
        except (AttributeError, ValueError):
            pass


def show(text):
    """A path or value made safe to print: control characters escaped."""
    out = []
    for ch in text:
        o = ord(ch)
        if o < 0x20 or 0x7F <= o < 0xA0 or 0xD800 <= o <= 0xDFFF:
            out.append("\\x%02x" % o if o < 0x100 else "\\u%04x" % o)
        else:
            out.append(ch)
    return "".join(out)


def log(msg):
    sys.stderr.write(msg + "\n")
    sys.stderr.flush()


# ----------------------------------------------------------------------------
# Time: everything stays in integer nanoseconds / milliseconds, never datetime,
# so the years 0000 and 9999 and times before 1970 behave (spec: Rounding a
# modification time).
# ----------------------------------------------------------------------------

def ns_round_half_up_to_ms(ns):
    """Nearest millisecond, a tie to the later one (spec: stored mtime)."""
    return (ns + 500_000) // 1_000_000


def ns_floor_to_ms(ns):
    """Cut down to the millisecond (spec: START, .info instants)."""
    return ns // 1_000_000


def ns_ceil_to_ms(ns):
    """Rounded up (spec: FINISH is an upper bound)."""
    return -((-ns) // 1_000_000)


def civil_from_days(z):
    """Proleptic Gregorian date for a day count since 1970-01-01 (Howard Hinnant)."""
    z += 719468
    era = z // 146097  # floor division: Python needs no C-style negative adjustment
    doe = z - era * 146097
    yoe = (doe - doe // 1460 + doe // 36524 - doe // 146096) // 365
    y = yoe + era * 400
    doy = doe - (365 * yoe + yoe // 4 - yoe // 100)
    mp = (5 * doy + 2) // 153
    d = doy - (153 * mp + 2) // 5 + 1
    m = mp + 3 if mp < 10 else mp - 9
    if m <= 2:
        y += 1
    return y, m, d


def ms_to_fields(ms):
    days, rem = divmod(ms, 86_400_000)
    y, mo, d = civil_from_days(days)
    h, rem = divmod(rem, 3_600_000)
    mi, rem = divmod(rem, 60_000)
    s, frac = divmod(rem, 1000)
    return y, mo, d, h, mi, s, frac


def ms_to_instant(ms):
    """The 24-character form YYYY-MM-DDTHH:MM:SS.sssZ, or None outside the years 0000..9999."""
    y, mo, d, h, mi, s, frac = ms_to_fields(ms)
    if y < 0 or y > 9999:
        return None
    return "%04d-%02d-%02dT%02d:%02d:%02d.%03dZ" % (y, mo, d, h, mi, s, frac)


def ms_to_basic_instant(ms):
    """ISO 8601 basic form with milliseconds, for a lock id: 20261027T140205.123Z."""
    y, mo, d, h, mi, s, frac = ms_to_fields(ms)
    return "%04d%02d%02dT%02d%02d%02d.%03dZ" % (y, mo, d, h, mi, s, frac)


def local_minute_name(epoch_seconds):
    """Snapshot name YYYYMMDDTHHMM from local wall-clock time."""
    lt = time.localtime(epoch_seconds)
    return "%04d%02d%02dT%02d%02d" % (lt.tm_year, lt.tm_mon, lt.tm_mday, lt.tm_hour, lt.tm_min)


def local_zone_name():
    """Best available name for the local time zone (free text, for people)."""
    tz = os.environ.get("TZ", "")
    if tz and not tz.startswith(":") and ("/" in tz or tz in ("UTC", "GMT", "Etc/UTC")):
        return tz
    if not WINDOWS:
        try:
            target = os.path.realpath("/etc/localtime")
            marker = "zoneinfo" + os.sep
            idx = target.rfind(marker)
            if idx >= 0:
                name = target[idx + len(marker):]
                if name:
                    return name
        except OSError:
            pass
    else:
        try:
            import ctypes
            icu = ctypes.windll.LoadLibrary("icu.dll")
            buf = ctypes.create_unicode_buffer(128)
            status = ctypes.c_int(0)
            n = icu.ucal_getDefaultTimeZone(buf, 128, ctypes.byref(status))
            if status.value <= 0 and n > 0:
                return buf.value
        except Exception:
            pass
    names = time.tzname
    return names[time.localtime().tm_isdst > 0 and len(names) > 1] or "local"


def duration_text(ms):
    s = max(0, ms) // 1000
    if s < 60:
        return "%ds" % s
    if s < 3600:
        return "%dm %02ds" % (s // 60, s % 60)
    return "%dh %02dm" % (s // 3600, (s % 3600) // 60)


# ----------------------------------------------------------------------------
# Row layout (canonical form)
# ----------------------------------------------------------------------------

def spell_controls(text):
    """Tab, CR and LF as the Unicode Control Pictures, everywhere but a file row's path."""
    return "".join(CONTROL_PICTURES.get(ch, ch) for ch in text)


def row(c1, c2="", c3="", c4="", c5=""):
    return "%s\t%s\t%s\t%s\t%s\n" % (c1, c2.ljust(COL2_WIDTH), c3.rjust(COL3_WIDTH), c4.ljust(COL4_WIDTH), c5)


HEADING_ROW = row("@S3CAB", "FORMAT", "size", "time", FORMAT_URL)


def readable_size(n):
    """`999B`, `999.9kB`, `1.0MB`: one decimal, half up, smallest unit under 1000.0."""
    if n < 1000:
        return "%dB" % n
    units = ["kB", "MB", "GB", "TB", "PB"]
    for i, unit in enumerate(units):
        base = 1000 ** (i + 1)
        tenths = (n * 10 + base // 2) // base
        if tenths < 10000 or unit == "PB":
            return "%d.%d%s" % (tenths // 10, tenths % 10, unit)
    raise AssertionError("unreachable")


# ----------------------------------------------------------------------------
# Paths
# ----------------------------------------------------------------------------

def long_path(p):
    """On Windows, the \\\\?\\ form so a trailing dot or space and long paths are honoured."""
    if not WINDOWS:
        return p
    if p.startswith("\\\\?\\"):
        return p
    if p.startswith("\\\\"):
        return "\\\\?\\UNC\\" + p[2:]
    return "\\\\?\\" + p


def short_path(p):
    """Strip the \\\\?\\ prefix Windows APIs hand back."""
    if not WINDOWS:
        return p
    if p.startswith("\\\\?\\UNC\\"):
        return "\\\\" + p[8:]
    if p.startswith("\\\\?\\"):
        return p[4:]
    return p


def split_root(p):
    """(root, rest) for an absolute path of this OS's kind."""
    if WINDOWS:
        if p.startswith("\\\\"):
            parts = p[2:].split("\\")
            if len(parts) >= 2 and parts[0] and parts[1]:
                root = "\\\\" + parts[0] + "\\" + parts[1] + "\\"
                return root, p[len(root):] if len(p) > len(root) - 1 else ""
            return None, p
        if len(p) >= 3 and p[1] == ":" and p[2] in "\\/":
            return p[0].upper() + ":\\", p[3:]
        return None, p
    if p.startswith("/"):
        return "/", p[1:]
    return None, p


def segments(p):
    root, rest = split_root(p)
    seps = "\\/" if WINDOWS else "/"
    segs = []
    cur = ""
    for ch in rest:
        if ch in seps:
            if cur:
                segs.append(cur)
            cur = ""
        else:
            cur += ch
    if cur:
        segs.append(cur)
    return root, segs


def path_within(path, directory):
    """True when `path` equals `directory` or lies inside it, compared by whole segments exactly."""
    r1, s1 = segments(path)
    r2, s2 = segments(directory)
    if r1 is None or r2 is None or r1 != r2:
        return False
    return len(s1) >= len(s2) and s1[: len(s2)] == s2


def spell_as_disk(p):
    """Re-spell each name of a resolved absolute path as its parent's listing has it.

    os.path.realpath keeps the case as typed on macOS and in a case-insensitive Linux
    directory (spec: Paths), so each name is looked up in its parent by identity.
    """
    root, segs = segments(p)
    if root is None:
        return p
    cur = root
    for seg in segs:
        candidate = os.path.join(cur, seg)
        try:
            st = os.lstat(long_path(candidate))
            names = os.listdir(long_path(cur))
        except OSError:
            cur = candidate
            continue
        if seg in names:
            cur = candidate
            continue
        found = None
        for name in names:
            try:
                if os.path.samestat(st, os.lstat(long_path(os.path.join(cur, name)))):
                    found = name
                    break
            except OSError:
                continue
        cur = os.path.join(cur, found if found is not None else seg)
    return cur


def true_real_path(p):
    """The real path, every link and alias resolved, spelled as the filesystem reports it.

    Raises OSError (FileNotFoundError and friends) when it can't be resolved.
    """
    if WINDOWS:
        ap = p if os.path.isabs(p) else os.path.join(os.getcwd(), p)
        ap = os.path.normpath(ap)
        rp = short_path(os.path.realpath(long_path(ap), strict=True))
        if len(rp) >= 2 and rp[1] == ":":
            rp = rp[0].upper() + rp[1:]
    else:
        rp = os.path.realpath(p, strict=True)
    rp = spell_as_disk(rp)
    if sys.platform == "darwin":
        # Where a parent couldn't be listed, F_GETPATH on the open file or directory
        # gives its path as the disk spells it (spec hint, On macOS).
        try:
            import fcntl
            fd = os.open(rp, os.O_RDONLY | getattr(os, "O_NONBLOCK", 0))
            try:
                raw = fcntl.fcntl(fd, fcntl.F_GETPATH, b"\0" * 1024)
                st_fd = os.fstat(fd)
            finally:
                os.close(fd)
            got = os.fsdecode(raw.split(b"\0", 1)[0])
            if got and os.path.samestat(st_fd, os.stat(got)):
                rp = got
        except (OSError, AttributeError, ImportError):
            pass
    return rp


def with_trailing_sep(p):
    return p if p.endswith(SEP) else p + SEP


def utf8_form(name):
    """The name's UTF-8 spelling, or None when it has none; and its U+FFFD rendering."""
    try:
        name.encode("utf-8")
        return name
    except UnicodeEncodeError:
        return None


def replacement_spelling(name):
    if WINDOWS:
        return name.encode("utf-8", "surrogatepass").decode("utf-8", "replace")
    return os.fsencode(name).decode("utf-8", "replace")


def has_row_breakers(text):
    return "\t" in text or "\r" in text or "\n" in text


# ----------------------------------------------------------------------------
# Processes (for lock cleanup)
# ----------------------------------------------------------------------------

def pid_alive(pid):
    if pid == os.getpid():
        return True
    if WINDOWS:
        import ctypes
        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
        handle = kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, int(pid))
        if not handle:
            return ctypes.get_last_error() == 5  # ERROR_ACCESS_DENIED: it exists
        try:
            code = ctypes.c_ulong()
            if kernel32.GetExitCodeProcess(handle, ctypes.byref(code)):
                return code.value == 259  # STILL_ACTIVE
            return True
        finally:
            kernel32.CloseHandle(handle)
    try:
        os.kill(int(pid), 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def pid_namespace():
    if sys.platform.startswith("linux"):
        try:
            return os.readlink("/proc/self/ns/pid")
        except OSError:
            return None
    return None


def user_at_machine():
    try:
        user = getpass.getuser()
    except Exception:
        user = os.environ.get("USER") or os.environ.get("USERNAME") or "unknown"
    machine = socket.gethostname() or "unknown"
    return "%s@%s" % (user, machine)


# ----------------------------------------------------------------------------
# KEY=value files (.info and locks)
# ----------------------------------------------------------------------------

def parse_kv(data):
    text = data.decode("utf-8", "replace")
    if text.startswith("﻿"):
        text = text[1:]
    out = {}
    for line in text.split("\n"):
        if line.endswith("\r"):
            line = line[:-1]
        if "=" not in line:
            continue
        k, v = line.split("=", 1)
        out[k] = v
    return out


def format_kv(pairs):
    return "".join("%s=%s\n" % (k, v) for k, v in pairs).encode("utf-8")


# ----------------------------------------------------------------------------
# State kept beside the program
# ----------------------------------------------------------------------------

STATE_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "s3cab-backup.state.json")


def load_state():
    try:
        with open(STATE_PATH, "rb") as f:
            return json.loads(f.read().decode("utf-8"))
    except FileNotFoundError:
        return {"holders": {}}
    except (OSError, ValueError) as e:
        raise Stop("can't read the state file %s: %s" % (STATE_PATH, e))


def save_state(state):
    tmp = STATE_PATH + ".tmp"
    with open(tmp, "wb") as f:
        f.write(json.dumps(state, indent=2, sort_keys=True).encode("utf-8") + b"\n")
    os.replace(tmp, STATE_PATH)


# ----------------------------------------------------------------------------
# S3
# ----------------------------------------------------------------------------

def b64_digest(hex_digest):
    return base64.b64encode(bytes.fromhex(hex_digest)).decode("ascii")


def sha256_b64(data):
    return base64.b64encode(hashlib.sha256(data).digest()).decode("ascii")


class HashingReader:
    """A file-like body that hashes what botocore actually reads.

    botocore reads a put_object body more than once; the digest starts again on a
    seek back to 0 so the final digest is of the last pass -- the one on the wire.
    """

    def __init__(self, f):
        self._f = f
        self._h = hashlib.sha256()
        self._tainted = False
        self.passes = 0

    def read(self, n=-1):
        data = self._f.read(n)
        if data:
            self._h.update(data)
        return data

    def seek(self, offset, whence=os.SEEK_SET):
        r = self._f.seek(offset, whence)
        if self._f.tell() == 0:
            self._h = hashlib.sha256()
            self._tainted = False
            self.passes += 1
        else:
            self._tainted = True
        return r

    def tell(self):
        return self._f.tell()

    def hexdigest(self):
        return None if self._tainted else self._h.hexdigest()


class ErrorCode:
    @staticmethod
    def of(exc):
        return exc.response.get("Error", {}).get("Code", "")

    @staticmethod
    def status(exc):
        return exc.response.get("ResponseMetadata", {}).get("HTTPStatusCode")


class Repo:
    def __init__(self, bucket):
        self.bucket = bucket
        cfg = Config(
            retries={"mode": "standard", "max_attempts": 5},
            connect_timeout=10,
            read_timeout=30,
        )
        self.s3 = boto3.client("s3", config=cfg)
        self.endpoint = os.environ.get("AWS_ENDPOINT_URL_S3") or os.environ.get("AWS_ENDPOINT_URL") or ""
        self.is_aws = not self.endpoint

    # --- listing ---------------------------------------------------------------
    def list_folder(self, prefix):
        """Keys directly in a folder (delimiter /), and the folders below it."""
        keys, folders = [], []
        paginator = self.s3.get_paginator("list_objects_v2")
        for page in paginator.paginate(Bucket=self.bucket, Prefix=prefix, Delimiter="/"):
            for item in page.get("Contents", []):
                keys.append(item["Key"])
            for cp in page.get("CommonPrefixes", []):
                folders.append(cp["Prefix"])
        return keys, folders

    def snapshot_names(self, set_name):
        keys, _ = self.list_folder("snapshots/%s/" % set_name)
        names = []
        for k in keys:
            base = k[len("snapshots/%s/" % set_name):]
            if SNAPSHOT_KEY_RE.match(base):
                names.append(base[:-len(".tsv.gz")])
        return names

    def stored_hashes(self):
        keys, _ = self.list_folder("objects/")
        return {k[len("objects/"):] for k in keys if HEX64_RE.match(k[len("objects/"):])}

    # --- small objects -------------------------------------------------------
    def get(self, key):
        try:
            resp = self.s3.get_object(Bucket=self.bucket, Key=key)
        except ClientError as e:
            if ErrorCode.of(e) in ("NoSuchKey", "NotFound", "404"):
                return None
            raise
        return resp["Body"].read()

    def head(self, key):
        try:
            return self.s3.head_object(Bucket=self.bucket, Key=key)
        except ClientError as e:
            if ErrorCode.of(e) in ("NoSuchKey", "NotFound", "404") or ErrorCode.status(e) == 404:
                return None
            raise

    def put_small(self, key, data, conditional=True):
        """PUT bytes; returns True when written, False on 412 (already there)."""
        kwargs = dict(Bucket=self.bucket, Key=key, Body=data, ContentLength=len(data), ChecksumSHA256=sha256_b64(data))
        if self.is_aws:
            kwargs["ServerSideEncryption"] = "AES256"
        if conditional:
            kwargs["IfNoneMatch"] = "*"
        try:
            self.s3.put_object(**kwargs)
            return True
        except ClientError as e:
            if ErrorCode.status(e) == 412 or ErrorCode.of(e) == "PreconditionFailed":
                return False
            raise

    def delete(self, key):
        self.s3.delete_object(Bucket=self.bucket, Key=key)

    # --- objects -------------------------------------------------------------
    def put_object_file(self, key, path, expect_hex, size):
        """Single PUT of a file as `key`, S3 checking the bytes against the key's digest.

        Returns 'uploaded', 'stored' (412: already there) or raises Stop when the bytes
        sent didn't hash to the key (nothing is stored then: S3 refuses a bad digest).
        """
        open_flags = os.O_RDONLY | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0)
        fd = os.open(long_path(path), open_flags)
        with os.fdopen(fd, "rb", buffering=0) as f:
            body = HashingReader(f)
            kwargs = dict(Bucket=self.bucket, Key=key, Body=body, ContentLength=size,
                          ChecksumSHA256=b64_digest(expect_hex), IfNoneMatch="*")
            if self.is_aws:
                kwargs["ServerSideEncryption"] = "AES256"
            try:
                resp = self.s3.put_object(**kwargs)
            except ClientError as e:
                code = ErrorCode.of(e)
                if ErrorCode.status(e) == 412 or code == "PreconditionFailed":
                    return "stored"
                if code in ("BadDigest", "InvalidRequest", "XAmzContentSHA256Mismatch") and ErrorCode.status(e) == 400:
                    raise Stop("%s changed while it was being sent: the bytes sent don't hash to %s "
                               "(S3 refused them, nothing stored)" % (show(path), expect_hex))
                raise
            sent = body.hexdigest()
            if sent is None or sent != expect_hex:
                # S3 accepted the body, so by its own check the bytes hash to the key;
                # a disagreement here means the local accounting is wrong, not the store.
                raise Stop("internal: local digest of the bytes sent for %s (%s) disagrees with the key %s"
                           % (show(path), sent, expect_hex))
            if resp.get("ChecksumSHA256") != b64_digest(expect_hex):
                raise Stop("S3 did not confirm the SHA-256 of %s (response %r)" % (key, resp.get("ChecksumSHA256")))
            return "uploaded"

    def put_object_multipart(self, key, path, expect_hex, size):
        """Multipart upload with S3 checking each part; completed only if the whole hashes to the key."""
        if self.head(key) is not None:
            return "stored"
        kwargs = dict(Bucket=self.bucket, Key=key, ChecksumAlgorithm="SHA256")
        if self.is_aws:
            kwargs["ServerSideEncryption"] = "AES256"
        upload_id = self.s3.create_multipart_upload(**kwargs)["UploadId"]
        whole = hashlib.sha256()
        parts = []
        try:
            open_flags = os.O_RDONLY | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0)
            fd = os.open(long_path(path), open_flags)
            total = 0
            with os.fdopen(fd, "rb", buffering=0) as f:
                number = 0
                while True:
                    chunk = f.read(PART_SIZE)
                    if not chunk:
                        break
                    number += 1
                    total += len(chunk)
                    whole.update(chunk)
                    part_b64 = sha256_b64(chunk)
                    resp = self.s3.upload_part(Bucket=self.bucket, Key=key, UploadId=upload_id, PartNumber=number,
                                               Body=chunk, ContentLength=len(chunk), ChecksumSHA256=part_b64)
                    parts.append({"PartNumber": number, "ETag": resp["ETag"], "ChecksumSHA256": part_b64})
            if total != size or whole.hexdigest() != expect_hex or not parts:
                self.s3.abort_multipart_upload(Bucket=self.bucket, Key=key, UploadId=upload_id)
                raise Stop("%s changed while it was being sent: the bytes sent hash to %s, not %s "
                           "(multipart upload aborted, nothing stored)" % (show(path), whole.hexdigest(), expect_hex))
            try:
                self.s3.complete_multipart_upload(Bucket=self.bucket, Key=key, UploadId=upload_id,
                                                  MultipartUpload={"Parts": parts}, IfNoneMatch="*")
            except ClientError as e:
                if ErrorCode.status(e) == 412 or ErrorCode.of(e) == "PreconditionFailed":
                    self.s3.abort_multipart_upload(Bucket=self.bucket, Key=key, UploadId=upload_id)
                    return "stored"
                raise
            return "uploaded"
        except Stop:
            raise
        except BaseException:
            try:
                self.s3.abort_multipart_upload(Bucket=self.bucket, Key=key, UploadId=upload_id)
            except Exception:
                pass
            raise


# ----------------------------------------------------------------------------
# The walk
# ----------------------------------------------------------------------------

class Entry:
    """A per-path row waiting to be written."""
    __slots__ = ("kind", "path", "message", "is_dir")

    def __init__(self, kind, path, message="", is_dir=False):
        self.kind = kind          # 'file' (to hash) or 'error'
        self.path = path
        self.message = message
        self.is_dir = is_dir


def errno_text(exc):
    code = errno.errorcode.get(exc.errno, "E%s" % exc.errno) if exc.errno is not None else "ERROR"
    if WINDOWS and getattr(exc, "winerror", None):
        return "%s (winerror %d): %s" % (code, exc.winerror, exc.strerror or str(exc))
    return "%s: %s" % (code, exc.strerror or str(exc))


def is_broken_link_error(exc):
    if isinstance(exc, (FileNotFoundError, NotADirectoryError)):
        return True
    if exc.errno == errno.ELOOP:
        return True
    if WINDOWS and getattr(exc, "winerror", None) in (2, 3, 1921):
        return True
    return False


def entry_is_link(entry):
    try:
        if entry.is_symlink():
            return True
    except OSError:
        pass
    if WINDOWS:
        is_junction = getattr(entry, "is_junction", None)
        if is_junction is not None:
            try:
                return bool(is_junction())
            except OSError:
                pass
        else:
            try:
                st = entry.stat(follow_symlinks=False)
                return getattr(st, "st_reparse_tag", 0) == 0xA0000003
            except OSError:
                pass
    return False


class Walker:
    def __init__(self, member_dirs):
        self.member_dirs = member_dirs      # real paths, no trailing separator
        self.pre_rows = []                  # '#' rows known at walk time (links out, type errors)
        self.files = []                     # Entry('file')

    def walk(self):
        for d in self.member_dirs:
            self._walk_dir(d)

    @staticmethod
    def _list(directory):
        try:
            with os.scandir(long_path(directory)) as it:
                return list(it)
        except OSError as e:
            raise Stop("can't list the directory %s: %s" % (show(directory), errno_text(e)))

    def _walk_dir(self, top):
        # Depth-first in listing order, with an explicit stack so a very deep tree
        # can't exhaust Python's recursion limit.
        stack = [(top, iter(self._list(top)))]
        while stack:
            directory, entries = stack[-1]
            entry = next(entries, None)
            if entry is None:
                stack.pop()
                continue
            name = entry.name
            if utf8_form(name) is None:
                raise Stop("the name %s in %s has no UTF-8 form, so it can't be recorded; rename it "
                           "or leave it out" % (show(replacement_spelling(name)), show(directory)))
            path = os.path.join(directory, name)
            try:
                if entry_is_link(entry):
                    self._link(path)
                    continue
                if entry.is_dir(follow_symlinks=False):
                    stack.append((path, iter(self._list(path))))
                    continue
                if entry.is_file(follow_symlinks=False):
                    if has_row_breakers(path):
                        raise Stop("the file %s has a tab, CR or LF in its path; the format can't record it. "
                                   "Rename it or leave it out and run again" % show(path))
                    self.files.append(Entry("file", path))
                    continue
                # a pipe, socket or device: no row
            except FileNotFoundError:
                # vanished between being listed and its type being known: nothing to record
                continue
            except Stop:
                raise
            except OSError as e:
                self.pre_rows.append(Entry("error", path, errno_text(e)))

    def _link(self, path):
        try:
            target_text = os.readlink(long_path(path))
        except OSError as e:
            if isinstance(e, FileNotFoundError):
                return
            self.pre_rows.append(Entry("error", path, "link: " + errno_text(e)))
            return
        if WINDOWS:
            target_text = short_path(target_text)
        # Where does it lead? stat follows every link in the chain.
        try:
            st = os.stat(long_path(path))
        except OSError as e:
            if is_broken_link_error(e):
                return  # broken: no row
            self.pre_rows.append(Entry("error", path, "link to %s can't be resolved here: %s"
                                       % (spell_controls(target_text), errno_text(e))))
            return
        if stat.S_ISFIFO(st.st_mode) or stat.S_ISSOCK(st.st_mode) or stat.S_ISCHR(st.st_mode) or stat.S_ISBLK(st.st_mode):
            return
        is_dir = stat.S_ISDIR(st.st_mode)
        try:
            real = true_real_path(path)
        except OSError as e:
            if is_broken_link_error(e):
                return
            self.pre_rows.append(Entry("error", path, "link to %s can't be resolved here: %s"
                                       % (spell_controls(target_text), errno_text(e))))
            return
        for member in self.member_dirs:
            if path_within(real, member):
                return  # into the backup: the target is recorded where it lies
        what = "a folder " if is_dir else ""
        self.pre_rows.append(Entry("error", path, "link to %s%s leads out of the backup"
                                   % (what, spell_controls(target_text)), is_dir=is_dir))


# ----------------------------------------------------------------------------
# Hashing
# ----------------------------------------------------------------------------

class FileRow:
    __slots__ = ("hash", "size", "mtime_ms", "mtime", "path")

    def __init__(self, hash_hex, size, mtime_ms, mtime, path):
        self.hash = hash_hex
        self.size = size
        self.mtime_ms = mtime_ms
        self.mtime = mtime
        self.path = path


def open_for_hash(path):
    flags = os.O_RDONLY | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0)
    return os.open(long_path(path), flags)


def hash_file(path):
    """Returns a FileRow, or a str error message."""
    try:
        if WINDOWS:
            # No O_NOFOLLOW there: refuse a path that became a link or junction since it was listed.
            st0 = os.lstat(long_path(path))
            if stat.S_ISLNK(st0.st_mode) or getattr(st0, "st_reparse_tag", 0) in (0xA000000C, 0xA0000003):
                return "became a link after it was listed"
        fd = open_for_hash(path)
    except OSError as e:
        if WINDOWS and isinstance(e, PermissionError) and getattr(e, "winerror", None) == 32:
            return "EBUSY (winerror 32): the file is open in another program without sharing"
        return errno_text(e)
    try:
        with os.fdopen(fd, "rb", buffering=0) as f:
            st = os.fstat(f.fileno())
            if not stat.S_ISREG(st.st_mode):
                return "not a regular file any more (mode %o)" % stat.S_IFMT(st.st_mode)
            size = st.st_size
            mtime_ns = st.st_mtime_ns
            h = hashlib.sha256()
            total = 0
            while True:
                chunk = f.read(1024 * 1024)
                if not chunk:
                    break
                h.update(chunk)
                total += len(chunk)
    except OSError as e:
        return errno_text(e)
    if total != size:
        return "read %d bytes where the file reported %d" % (total, size)
    ms = ns_round_half_up_to_ms(mtime_ns)
    instant = ms_to_instant(ms)
    if instant is None:
        return "modification time %d ms since 1970 is outside the years 0000 to 9999" % ms
    return FileRow(h.hexdigest(), size, ms, instant, path)


# ----------------------------------------------------------------------------
# The backup run
# ----------------------------------------------------------------------------

def validate_set_name(name):
    if not SET_NAME_RE.match(name):
        raise Stop("the set name %r is not one or more of a-z and 0-9 with single hyphens between" % name)


def resolve_member_dirs(args):
    reals = []
    for arg in args:
        try:
            real = true_real_path(arg)
        except FileNotFoundError:
            raise Stop("the member directory %s doesn't exist" % show(arg))
        except OSError as e:
            raise Stop("the member directory %s can't be resolved: %s" % (show(arg), errno_text(e)))
        if not os.path.isdir(long_path(real)):
            raise Stop("the member directory %s isn't a directory (it is %s)" % (show(arg), show(real)))
        if WINDOWS:
            root, _ = split_root(real)
            if root is None:
                raise Stop("the member directory %s resolves to %s, which has no drive letter and no share; "
                           "no path a reader accepts can name it" % (show(arg), show(real)))
        reals.append(real)
    for i, a in enumerate(reals):
        for j, b in enumerate(reals):
            if i != j and path_within(a, b):
                if a == b:
                    raise Stop("the member directories %s and %s are the same directory %s"
                               % (show(args[i]), show(args[j]), show(a)))
                raise Stop("the member directory %s (%s) is inside %s (%s); the same files would turn up twice"
                           % (show(args[i]), show(a), show(args[j]), show(b)))
    return reals


class Lock:
    def __init__(self, repo, set_name, start_ms, by):
        self.repo = repo
        self.set_name = set_name
        self.by = by
        self.os = sys.platform
        self.pidns = pid_namespace()
        self.key = None
        self.body = None
        self._start_ms = start_ms

    def _content(self, instant_ms):
        pairs = [("COMMAND", "backup"), ("SET", self.set_name), ("BY", self.by), ("OS", self.os)]
        if self.pidns:
            pairs.append(("PIDNS", self.pidns))
        pairs.append(("PID", str(os.getpid())))
        pairs.append(("STARTED", ms_to_instant(instant_ms)))
        return format_kv(pairs)

    def acquire(self):
        instant_ms = self._start_ms
        for _ in range(50):
            key = "locks/upload-%s" % ms_to_basic_instant(instant_ms)
            body = self._content(instant_ms)
            if self.repo.put_small(key, body, conditional=True):
                self.key, self.body = key, body
                return
            existing = self.repo.get(key)
            if existing == body:
                self.key, self.body = key, body
                return
            instant_ms = ns_floor_to_ms(time.time_ns())
            if instant_ms <= self._start_ms:
                instant_ms = self._start_ms + 1
            self._start_ms = instant_ms
        raise Stop("couldn't write an upload lock: every instant tried was taken")

    def check_others(self):
        """Remove this machine's dead locks; refuse on any delete- lock left."""
        keys, _ = self.repo.list_folder("locks/")
        delete_locks = []
        for key in keys:
            if key == self.key:
                continue
            lock_id = key[len("locks/"):]
            kind = lock_id.split("-", 1)[0]
            if kind not in ("upload", "delete"):
                continue
            data = self.repo.get(key)
            if data is None:
                continue
            kv = parse_kv(data)
            mine = (kv.get("BY") == self.by and kv.get("OS") == self.os and kv.get("OS") is not None
                    and (kv.get("PIDNS") or None) == (self.pidns or None))
            if mine:
                pid = kv.get("PID", "")
                if pid.isdigit() and not pid_alive(int(pid)):
                    log("removing the lock %s: its process %s on this machine is gone" % (lock_id, pid))
                    self.repo.delete(key)
                    continue
            if kind == "delete":
                delete_locks.append(lock_id)
        if delete_locks:
            raise Stop("a delete is running (lock %s); uploads and deletes take turns" % ", ".join(delete_locks))

    def release(self):
        if self.key is None:
            return
        try:
            self.repo.delete(self.key)
            self.key = None
        except Exception as e:
            log("couldn't remove the lock %s: %s -- remove it by hand once this run is known to be over"
                % (self.key[len("locks/"):], e))


class Holder:
    """The OWNER/CLAIMED pair for a set, kept in the state file beside the program."""

    def __init__(self, repo, set_name, by, state):
        self.repo = repo
        self.set_name = set_name
        self.by = by
        self.state = state
        self.key = "snapshots/%s.info" % set_name
        self.state_key = "%s/%s" % (repo.bucket, set_name)

    def kept(self):
        return self.state.setdefault("holders", {}).get(self.state_key)

    def keep(self, owner, claimed):
        self.state.setdefault("holders", {})[self.state_key] = {"OWNER": owner, "CLAIMED": claimed}
        save_state(self.state)

    def forget(self):
        if self.state_key in self.state.get("holders", {}):
            del self.state["holders"][self.state_key]
            save_state(self.state)

    def read(self):
        data = self.repo.get(self.key)
        return None if data is None else parse_kv(data)

    def matches(self, info):
        pair = self.kept()
        return bool(pair) and info is not None and info.get("OWNER") == pair["OWNER"] and info.get("CLAIMED") == pair["CLAIMED"]

    def ensure(self, takeover):
        info = self.read()
        if info is not None and self.matches(info):
            return "held"
        now = ms_to_instant(ns_floor_to_ms(time.time_ns()))
        if info is not None:
            if not takeover:
                if self.kept():
                    self.forget()
                raise Stop("the set %s is held by %s (claimed %s), not by this machine's pair; set "
                           "S3CAB_BACKUP_TAKEOVER=1 to take it over"
                           % (self.set_name, show(info.get("OWNER", "")), show(info.get("CLAIMED", ""))))
            created = info.get("CREATED") or now
            body = format_kv([("OWNER", self.by), ("CLAIMED", now), ("CREATED", created)])
            self.repo.put_small(self.key, body, conditional=False)
            self.keep(self.by, now)
            return "taken over"
        names = self.repo.snapshot_names(self.set_name)
        if names and not takeover:
            if self.kept():
                self.forget()
            raise Stop("the set %s has %d snapshot(s) but no %s: it has no holder until one takes it "
                       "over; set S3CAB_BACKUP_TAKEOVER=1 to do that" % (self.set_name, len(names), self.key))
        body = format_kv([("OWNER", self.by), ("CLAIMED", now), ("CREATED", now)])
        if not self.repo.put_small(self.key, body, conditional=True):
            raise Stop("another machine claimed %s between this run's check and its claim; run again" % self.key)
        self.keep(self.by, now)
        return "taken over" if names else "claimed"

    def check_before_publish(self):
        info = self.read()
        if info is None:
            self.forget()
            raise Stop("%s is gone: the set has no holder, so the snapshot isn't uploaded" % self.key)
        if not self.matches(info):
            self.forget()
            raise Stop("%s now names %s (claimed %s): another machine holds the set, so the snapshot isn't uploaded"
                       % (self.key, show(info.get("OWNER", "")), show(info.get("CLAIMED", ""))))


def build_snapshot_text(bucket, set_name, member_dirs, snapshot_name, by, start_ms, zone,
                        pre_rows, file_rows, finish_ms_holder):
    """All the rows, in s3cab's order, as one str. finish_ms_holder is a 1-list filled in here."""
    out = [HEADING_ROW]
    out.append(row("@S3CAB", "SPEC", "", "", SPEC_DATE))
    out.append(row("@CLIENT", "NAME", "", "", CLIENT_NAME))
    out.append(row("@CLIENT", "VERSION", "", "", CLIENT_VERSION))
    out.append(row("@SET", "NAME", "", "", set_name))
    out.append(row("@SET", "BUCKET", "", "", "s3://" + bucket))
    for d in member_dirs:
        out.append(row("@SET", "DIR", "", "", spell_controls(with_trailing_sep(d))))
    out.append(row("@SNAPSHOT", "NAME", "", "", snapshot_name))
    out.append(row("@SNAPSHOT", "BY", "", "", by))
    out.append(row("@SNAPSHOT", "START", "", ms_to_instant(start_ms), zone))
    for e in pre_rows:
        p = spell_controls(with_trailing_sep(e.path) if e.is_dir else e.path)
        out.append(row("#error", spell_controls(e.message), "", "", p))
    count = 0
    total = 0
    for item in file_rows:
        if isinstance(item, FileRow):
            out.append(row("-", item.hash, str(item.size), item.mtime, item.path))
            count += 1
            total += item.size
        else:
            out.append(row("#error", spell_controls(item.message), "", "", spell_controls(item.path)))
    finish_ms = ns_ceil_to_ms(time.time_ns())
    finish_ms_holder[0] = finish_ms
    out.append(row("@SNAPSHOT", "FILES", "", "", str(count)))
    out.append(row("@SNAPSHOT", "SIZE", "", "", "%d (%s)" % (total, readable_size(total))))
    out.append(row("@SNAPSHOT", "FINISH", "", ms_to_instant(finish_ms), duration_text(finish_ms - start_ms)))
    out.append(".\n")
    return "".join(out), count, total


def self_check_snapshot(text):
    """Refuse to upload anything a reader would refuse whole (spec: Uploading)."""
    data = text.encode("utf-8")
    data.decode("utf-8")  # strict
    if "\r" in text:
        raise Stop("internal: a CR got into the snapshot text")
    lines = text.split("\n")
    if lines[-1] != "":
        raise Stop("internal: the snapshot doesn't end in LF")
    lines = lines[:-1]
    if not lines or lines[0] + "\n" != HEADING_ROW:
        raise Stop("internal: the snapshot doesn't start with the heading row")
    if lines[-1] != ".":
        raise Stop("internal: the snapshot doesn't end with the `.`")
    seen_paths = set()
    for line in lines[:-1]:
        if line == "":
            raise Stop("internal: blank line in the snapshot")
        fields = line.split("\t", 4)
        if len(fields) != 5:
            raise Stop("internal: a row without five fields: %r" % line)
        kind = fields[0]
        if not (kind == "-" or kind.startswith("@") or kind.startswith("#")):
            raise Stop("internal: unknown row type %r" % kind)
        if kind == "-" or kind.startswith("#"):
            if fields[4] in seen_paths:
                raise Stop("internal: the path %s has two rows" % show(fields[4]))
            seen_paths.add(fields[4])
        if kind == "-":
            if not HEX64_RE.match(fields[1].strip()) or not fields[2].strip().isdigit() or len(fields[3].strip()) != 24:
                raise Stop("internal: malformed file row %r" % line)
    return data


def gzip_single_stream(data):
    buf = io.BytesIO()
    with gzip.GzipFile(filename="", mode="wb", fileobj=buf, mtime=0, compresslevel=9) as gz:
        gz.write(data)
    return buf.getvalue()


def run(bucket, set_name, dir_args):
    validate_set_name(set_name)
    takeover = os.environ.get("S3CAB_BACKUP_TAKEOVER", "") not in ("", "0")
    part_threshold = int(os.environ.get("S3CAB_BACKUP_PART_THRESHOLD", DEFAULT_PART_THRESHOLD))
    by = user_at_machine()

    # Cheap local checks first: a missing member directory needs no lock to be refused.
    member_dirs = resolve_member_dirs(dir_args)

    # One clock reading mints the name (local minute) and START (UTC millisecond).
    start_ns = time.time_ns()
    start_ms = ns_floor_to_ms(start_ns)
    snapshot_name = local_minute_name(start_ns // 1_000_000_000)
    zone = local_zone_name()
    snapshot_key = "snapshots/%s/%s.tsv.gz" % (set_name, snapshot_name)

    repo = Repo(bucket)
    state = load_state()
    lock = Lock(repo, set_name, start_ms, by)
    exit_code = 0
    lock.acquire()
    try:
        lock.check_others()

        holder = Holder(repo, set_name, by, state)
        how = holder.ensure(takeover)
        log("set %s: %s (%s)" % (set_name, how, by))

        # Refuse a second snapshot in the same minute before doing any work.
        if snapshot_name in repo.snapshot_names(set_name):
            raise Stop("a snapshot named %s already exists for %s; a second one in the same minute is refused"
                       % (snapshot_name, set_name))

        # Walk, then hash, in directory-listing order.
        walker = Walker(member_dirs)
        walker.walk()
        file_rows = []
        for entry in walker.files:
            result = hash_file(entry.path)
            if isinstance(result, FileRow):
                file_rows.append(result)
            else:
                file_rows.append(Entry("error", entry.path, result))
        finish_holder = [0]
        text, count, total = build_snapshot_text(bucket, set_name, member_dirs, snapshot_name, by, start_ms,
                                                 zone, walker.pre_rows, file_rows, finish_holder)
        data = self_check_snapshot(text)
        gz = gzip_single_stream(data)
        n_errors = sum(1 for e in walker.pre_rows) + sum(1 for r in file_rows if not isinstance(r, FileRow))
        log("snapshot %s: %d file rows, %d bytes, %d #error rows" % (snapshot_name, count, total, n_errors))

        # Objects first. Only the bucket's word says what is already stored.
        stored = repo.stored_hashes()
        first_path = {}
        for r in file_rows:
            if isinstance(r, FileRow) and r.hash not in first_path:
                first_path[r.hash] = r
        uploaded = skipped = 0
        for hash_hex, r in first_path.items():
            key = "objects/" + hash_hex
            if hash_hex in stored:
                skipped += 1
                continue
            # Just before sending: the file must still be what its row says, to the millisecond.
            try:
                st = os.stat(long_path(r.path), follow_symlinks=False)
            except OSError as e:
                raise Stop("%s can't be checked before sending (%s); the snapshot would name content the "
                           "repository doesn't hold" % (show(r.path), errno_text(e)))
            if not stat.S_ISREG(st.st_mode) or st.st_size != r.size or ns_round_half_up_to_ms(st.st_mtime_ns) != r.mtime_ms:
                raise Stop("%s changed since it was hashed (size %d -> %d, mtime %s -> %s); not sent, and the "
                           "snapshot isn't uploaded. Run again." % (show(r.path), r.size, st.st_size, r.mtime,
                                                                     ms_to_instant(ns_round_half_up_to_ms(st.st_mtime_ns))))
            if r.size >= part_threshold or r.size > SINGLE_PUT_MAX:
                outcome = repo.put_object_multipart(key, r.path, hash_hex, r.size)
            else:
                outcome = repo.put_object_file(key, r.path, hash_hex, r.size)
            if outcome == "uploaded":
                uploaded += 1
            else:
                skipped += 1
        log("objects: %d uploaded, %d already stored" % (uploaded, skipped))

        # Snapshot last: holder check immediately before, never over an existing one.
        holder.check_before_publish()
        existing = repo.get(snapshot_key)
        if existing is not None:
            if existing == gz:
                log("%s is already there with the same bytes" % snapshot_key)
            else:
                raise Stop("%s already exists with different bytes: a second snapshot in the same minute is refused"
                           % snapshot_key)
        elif not repo.put_small(snapshot_key, gz, conditional=True):
            raise Stop("%s appeared while this run was uploading; refused rather than overwritten" % snapshot_key)
        sys.stdout.write("s3://%s/%s\n" % (bucket, snapshot_key))
        sys.stdout.write("files=%d size=%d errors=%d objects_uploaded=%d objects_already_stored=%d\n"
                         % (count, total, n_errors, uploaded, skipped))
        sys.stdout.flush()
        if n_errors:
            for e in walker.pre_rows:
                log("#error %s\t%s" % (show(e.message), show(e.path)))
            for r in file_rows:
                if not isinstance(r, FileRow):
                    log("#error %s\t%s" % (show(r.message), show(r.path)))
            exit_code = 1
    finally:
        lock.release()
    return exit_code


def main(argv):
    _reconfigure_streams()
    if sys.version_info < (3, 10):
        log("s3cab-backup: Python 3.10 or later is needed (os.path.realpath strict=True)")
        return 2
    if len(argv) < 4:
        log("usage: python s3cab-backup.py <bucket> <set> <dir>...")
        return 2
    bucket, set_name, dirs = argv[1], argv[2], argv[3:]
    try:
        return run(bucket, set_name, dirs)
    except Stop as e:
        log("s3cab-backup: stopped, no snapshot written: %s" % e)
        return 1
    except ClientError as e:
        log("s3cab-backup: S3 request failed: %s" % e)
        return 1
    except KeyboardInterrupt:
        log("s3cab-backup: interrupted")
        return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
