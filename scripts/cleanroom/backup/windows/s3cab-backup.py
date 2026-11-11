#!/usr/bin/env python3
"""s3cab-backup.py: a clean-room backup writer for the s3cab repository format.

Written from the format spec dated 2026-10-30 and nothing else.

    python s3cab-backup.py <bucket> <set> <dir>... [--take-over]

Walks the member directories, uploads every file's content to objects/<sha256>,
then uploads the snapshot that names them to snapshots/<set>/<YYYYMMDDTHHMM>.tsv.gz.
Claims snapshots/<set>.info for this machine on the set's first backup and keeps the
OWNER/CLAIMED pair it wrote in s3cab-backup-state/holders.json beside this file.
Holds an upload lock under locks/ for the whole run.

Needs Python 3.10 or later (os.path.realpath(strict=True)) and boto3.
Exit status: 0 when the snapshot was uploaded and holds no #error row; 1 otherwise.
"""

import base64
import ctypes
import errno
import gzip
import hashlib
import io
import json
import os
import re
import stat
import sys
import time

import boto3
from botocore.config import Config
from botocore.exceptions import BotoCoreError, ClientError

CLIENT_NAME = "cleanroom-backup"
CLIENT_VERSION = "0.1.0"
SPEC_DATE = "2026-10-30"
FORMAT_URL = "https://s3cab.plantegral.com/guide/format"

MULTIPART_THRESHOLD = 16 * 1024 * 1024   # a file this big or bigger goes up in parts
PART_SIZE = 16 * 1024 * 1024
READ_CHUNK = 1024 * 1024

WINDOWS = sys.platform == "win32"
SEP = "\\" if WINDOWS else "/"
EXT_PREFIX = "\\\\?\\"

SET_NAME_RE = re.compile(r"^[a-z0-9]+(-[a-z0-9]+)*$")
SNAPSHOT_KEY_RE = re.compile(r"^[0-9]{8}T[0-9]{4}\.tsv\.gz$")
HEX64_RE = re.compile(r"^[0-9a-f]{64}$")
PID_RE = re.compile(r"^[1-9][0-9]*$")

HERE = os.path.dirname(os.path.abspath(__file__))
STATE_DIR = os.path.join(HERE, "s3cab-backup-state")
HOLDERS_FILE = os.path.join(STATE_DIR, "holders.json")


# ----------------------------------------------------------------------------
# small helpers: output, text, time
# ----------------------------------------------------------------------------

def _setup_stdio():
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="backslashreplace")
        except (AttributeError, ValueError):
            pass


def show(s):
    """A path or message for a terminal: control characters spelled out."""
    out = []
    for ch in s:
        o = ord(ch)
        if o < 0x20 or 0x7F <= o <= 0x9F:
            out.append("\\x%02X" % o)
        elif 0xD800 <= o <= 0xDFFF:
            out.append("\\u%04X" % o)
        else:
            out.append(ch)
    return "".join(out)


def say(msg):
    print(msg, flush=True)


def warn(msg):
    print(msg, file=sys.stderr, flush=True)


def spell(s):
    """Spell a tab, CR or LF as the Control Pictures, for every field but a file row's path."""
    return s.replace("\t", "␉").replace("\r", "␍").replace("\n", "␊")


def name_with_fffd(name):
    """A name that has no UTF-8 form, with U+FFFD for each part that doesn't decode."""
    if WINDOWS:
        return name.encode("utf-8", "surrogatepass").decode("utf-8", "replace")
    return os.fsencode(name).decode("utf-8", "replace")


def utf8_ok(name):
    try:
        name.encode("utf-8")
        return True
    except UnicodeEncodeError:
        return False


def civil_from_days(z):
    """Proleptic Gregorian date from days since 1970-01-01 (Howard Hinnant's algorithm)."""
    z += 719468
    era = z // 146097
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


def instant_from_ms(ms):
    """The 24-character form for a count of milliseconds since the epoch, or None if the
    year is outside 0000..9999."""
    days, rem = divmod(ms, 86_400_000)
    y, mo, d = civil_from_days(days)
    if y < 0 or y > 9999:
        return None
    hh, rem = divmod(rem, 3_600_000)
    mi, rem = divmod(rem, 60_000)
    ss, mss = divmod(rem, 1000)
    return "%04d-%02d-%02dT%02d:%02d:%02d.%03dZ" % (y, mo, d, hh, mi, ss, mss)


def ns_to_ms_nearest(ns):
    """Round a nanosecond count to the nearest millisecond, a tie to the later one."""
    return (ns + 500_000) // 1_000_000


def ns_to_ms_down(ns):
    return ns // 1_000_000


def ns_to_ms_up(ns):
    return -((-ns) // 1_000_000)


def basic_instant(instant24):
    """2026-10-27T14:02:05.123Z -> 20261027T140205.123Z"""
    return instant24.replace("-", "").replace(":", "")


def readable_size(n):
    if n < 1000:
        return "%dB" % n
    unit = 1000
    for suffix in ("kB", "MB", "GB", "TB", "PB"):
        tenths = (n * 10 + unit // 2) // unit     # one decimal place, rounded half up
        if tenths < 10000 or suffix == "PB":
            return "%d.%d%s" % (tenths // 10, tenths % 10, suffix)
        unit *= 1000
    raise AssertionError("unreachable")


def duration_text(ms):
    s = ms // 1000
    if s < 60:
        return "%ds" % s
    if s < 3600:
        return "%dm %02ds" % (s // 60, s % 60)
    return "%dh %02dm" % (s // 3600, (s % 3600) // 60)


def local_zone_name():
    """The best name we have for the local time zone; written for people only."""
    tz = os.environ.get("TZ")
    if tz:
        return tz
    if WINDOWS:
        try:
            icu = ctypes.WinDLL("icu.dll")
            buf = ctypes.create_unicode_buffer(256)
            status = ctypes.c_int(0)
            n = icu.ucal_getDefaultTimeZone(buf, 256, ctypes.byref(status))
            if status.value <= 0 and n > 0 and buf.value:
                return buf.value
        except OSError:
            pass
    else:
        try:
            target = os.path.realpath("/etc/localtime")
            marker = "zoneinfo/"
            i = target.find(marker)
            if i >= 0:
                return target[i + len(marker):]
        except OSError:
            pass
    lt = time.localtime()
    try:
        return time.tzname[1 if lt.tm_isdst > 0 else 0]
    except (IndexError, AttributeError):
        return "local"


def user_at_machine():
    user = os.environ.get("USER") or os.environ.get("USERNAME")
    if not user:
        try:
            import getpass
            user = getpass.getuser()
        except Exception:
            user = "unknown"
    import socket
    host = socket.gethostname() or "unknown"
    return "%s@%s" % (user, host)


def pid_namespace():
    if sys.platform.startswith("linux"):
        try:
            return os.readlink("/proc/self/ns/pid")
        except OSError:
            return None
    return None


def process_alive(pid):
    """True if a process with this pid is alive, False if it is gone, None if we can't tell."""
    if WINDOWS:
        k32 = ctypes.WinDLL("kernel32", use_last_error=True)
        PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
        k32.OpenProcess.restype = ctypes.c_void_p
        h = k32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
        if not h:
            err = ctypes.get_last_error()
            if err == 87:        # ERROR_INVALID_PARAMETER: no such process
                return False
            if err == 5:         # ERROR_ACCESS_DENIED: alive, another user's
                return True
            return None
        try:
            code = ctypes.c_ulong(0)
            ok = k32.GetExitCodeProcess(ctypes.c_void_p(h), ctypes.byref(code))
            if not ok:
                return None
            return code.value == 259  # STILL_ACTIVE
        finally:
            k32.CloseHandle(ctypes.c_void_p(h))
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    except OSError:
        return None


# ----------------------------------------------------------------------------
# paths
# ----------------------------------------------------------------------------

def is_windows_path(p):
    if len(p) >= 3 and p[0].isascii() and p[0].isalpha() and p[1] == ":" and p[2] in "\\/":
        return True
    return len(p) >= 2 and p[0] in "\\/" and p[1] in "\\/"


def path_segments(p):
    """(root, [segments]) for a path, by the spec's rules for its kind."""
    if is_windows_path(p):
        if p[1] == ":":
            root = p[0].upper() + ":\\"
            rest = p[3:]
        else:
            root = "\\\\"
            rest = p[2:]
        segs = [s for s in re.split(r"[\\/]", rest) if s != ""]
        return root, segs
    segs = [s for s in p.split("/") if s != ""]
    return "/", segs


def path_within(child, parent):
    """Does child equal parent or lie inside it? Whole segments, compared exactly."""
    cr, cs = path_segments(child)
    pr, ps = path_segments(parent)
    return cr == pr and cs[:len(ps)] == ps


def access_path(p):
    """The path to hand the operating system: on Windows through the \\\\?\\ prefix."""
    if not WINDOWS:
        return p
    if p.startswith(EXT_PREFIX):
        return p
    if p.startswith("\\\\"):
        return EXT_PREFIX + "UNC\\" + p[2:]
    return EXT_PREFIX + p


def strip_ext_prefix(p):
    if not WINDOWS:
        return p
    if p.startswith(EXT_PREFIX + "UNC\\"):
        return "\\\\" + p[len(EXT_PREFIX) + 4:]
    if p.startswith(EXT_PREFIX):
        return p[len(EXT_PREFIX):]
    return p


def normalize_drive(p):
    if WINDOWS and len(p) >= 2 and p[1] == ":" and p[0].isascii() and p[0].isalpha():
        return p[0].upper() + p[1:]
    return p


def real_path(p, strict=True):
    """os.path.realpath with the spec's traps avoided: through \\\\?\\ on Windows, the
    prefix stripped from the answer, the drive letter upper case."""
    if WINDOWS:
        r = os.path.realpath(access_path(p), strict=strict)
        return normalize_drive(strip_ext_prefix(r))
    return os.path.realpath(p, strict=strict)


def fix_case_posix(p):
    """On a disk that ignores case, realpath keeps the case as typed: look each name up in
    its parent's listing and take the spelling the directory reports."""
    parts = [s for s in p.split("/") if s]
    cur = "/"
    out = []
    for name in parts:
        chosen = name
        try:
            with os.scandir(cur) as it:
                entries = list(it)
            exact = [e for e in entries if e.name == name]
            if not exact:
                try:
                    want = os.lstat(os.path.join(cur, name))
                    for e in entries:
                        try:
                            st = e.stat(follow_symlinks=False)
                        except OSError:
                            continue
                        if st.st_dev == want.st_dev and st.st_ino == want.st_ino:
                            chosen = e.name
                            break
                except OSError:
                    pass
        except OSError:
            pass
        out.append(chosen)
        cur = "/" + "/".join(out)
    return "/" + "/".join(out)


def resolve_member_dir(arg):
    """The real path of a member directory, ending in one separator, or raise ValueError."""
    p = arg
    if WINDOWS:
        drive, rest = os.path.splitdrive(p)
        if not (rest.startswith("\\") or rest.startswith("/")) or (drive == "" and not p.startswith("\\\\")):
            p = os.path.join(os.getcwd(), p)
        p = os.path.normpath(p)
    else:
        if not p.startswith("/"):
            p = os.path.join(os.getcwd(), p)
        p = os.path.normpath(p)
    try:
        rp = real_path(p, strict=True)
    except FileNotFoundError:
        raise ValueError("member directory %s doesn't exist" % show(arg))
    except OSError as e:
        raise ValueError("member directory %s can't be resolved: %s" % (show(arg), e))
    if WINDOWS:
        if re.match(r"^[A-Z]:\\", rp):
            pass
        elif rp.startswith("\\\\"):
            _, segs = path_segments(rp)
            if len(segs) < 2 or rp.startswith("\\\\?\\") or rp.startswith("\\\\.\\"):
                raise ValueError("member directory %s resolves to %s, which has no drive letter and no share" % (show(arg), show(rp)))
        else:
            raise ValueError("member directory %s resolves to %s, which has no drive letter and no share" % (show(arg), show(rp)))
    else:
        if not rp.startswith("/"):
            raise ValueError("member directory %s resolves to a relative path %s" % (show(arg), show(rp)))
        if sys.platform == "darwin" or sys.platform.startswith("linux"):
            rp = fix_case_posix(rp)
    try:
        st = os.stat(access_path(rp))
    except OSError as e:
        raise ValueError("member directory %s can't be checked: %s" % (show(arg), e))
    if not stat.S_ISDIR(st.st_mode):
        raise ValueError("member directory %s isn't a directory" % show(arg))
    if not rp.endswith(SEP):
        rp += SEP
    return rp


# ----------------------------------------------------------------------------
# the snapshot text
# ----------------------------------------------------------------------------

def pad_right(s, width):
    return s + " " * max(0, width - len(s))


def pad_left(s, width):
    return " " * max(0, width - len(s)) + s


def row(c1, c2="", c3="", c4="", c5=""):
    return "%s\t%s\t%s\t%s\t%s\n" % (c1, pad_right(c2, 64), pad_left(c3, 12), pad_right(c4, 24), c5)


def heading_row():
    return row("@S3CAB", "FORMAT", "size", "time", FORMAT_URL)


TRIM_SET = frozenset("\t\n\x0b\x0c\r \xa0         "
                     "     　  ﻿")


def trim_field(s):
    i, j = 0, len(s)
    while i < j and s[i] in TRIM_SET:
        i += 1
    while j > i and s[j - 1] in TRIM_SET:
        j -= 1
    return s[i:j]


def validate_snapshot_bytes(gz_bytes):
    """Read the snapshot back the way a reader would, and return a list of reasons it
    would be refused whole (empty when it wouldn't). Belt and braces before the upload."""
    reasons = []
    try:
        text = gzip.decompress(gz_bytes)
    except Exception as e:
        return ["gzip: %s" % e]
    try:
        s = text.decode("utf-8", "strict")
    except UnicodeDecodeError as e:
        return ["not UTF-8: %s" % e]
    if s.startswith("﻿"):
        reasons.append("starts with a BOM")
    if "\r" in s:
        reasons.append("holds a CR")
    if not s.endswith("\n"):
        return reasons + ["last line has no LF"]
    lines = s[:-1].split("\n")
    if not lines or lines[-1] != ".":
        return reasons + ["last line isn't '.'"]
    if not lines[:-1]:
        return reasons + ["no heading row"]
    f = lines[0].split("\t", 4)
    if len(f) != 5 or [trim_field(x) for x in f[:4]] != ["@S3CAB", "FORMAT", "size", "time"] or f[4] != FORMAT_URL:
        reasons.append("first line isn't the heading row")
    for n, line in enumerate(lines[:-1], 1):
        if trim_field(line) == "":
            reasons.append("blank line %d" % n)
            continue
        t = trim_field(line.split("\t", 1)[0])
        if not (t.startswith("@") or t.startswith("#") or t == "-"):
            reasons.append("line %d has an unknown type %r" % (n, t))
        if t == "-" and len(line.split("\t")) != 5:
            reasons.append("file row on line %d doesn't have exactly five fields" % n)
    return reasons


# ----------------------------------------------------------------------------
# the walk
# ----------------------------------------------------------------------------

class StopRun(Exception):
    """The run stops without writing a snapshot."""


class Walker:
    def __init__(self, member_dirs):
        self.member_dirs = member_dirs       # real paths, each ending in one separator
        self.walk_rows = []                  # #error rows found by the walk, in order
        self.files = []                      # (row_path, access_path) of regular files, in order

    def error_row(self, message, path):
        self.walk_rows.append(row("#error", spell(message), "", "", spell(path)))

    def walk_all(self):
        for d in self.member_dirs:
            self.walk_dir(d, access_path(d))

    def walk_dir(self, row_dir, acc_dir):
        try:
            with os.scandir(acc_dir) as it:
                entries = list(it)
        except OSError as e:
            raise StopRun("directory %s can't be listed: %s" % (show(row_dir), e))
        for e in entries:
            name = e.name
            if not utf8_ok(name):
                raise StopRun("the name %s in %s has no UTF-8 form; rename it or leave it out"
                              % (show(name_with_fffd(name)), show(row_dir)))
            row_path = row_dir + name
            acc_path = acc_dir + name
            try:
                is_link = e.is_symlink()
                is_junc = False
                if WINDOWS:
                    if hasattr(e, "is_junction"):
                        is_junc = e.is_junction()
                    else:
                        is_junc = getattr(e.stat(follow_symlinks=False), "st_reparse_tag", 0) == 0xA0000003
                if is_link or is_junc:
                    kind = "link"
                elif e.is_dir(follow_symlinks=False):
                    kind = "dir"
                elif e.is_file(follow_symlinks=False):
                    kind = "file"
                else:
                    kind = "other"
            except FileNotFoundError:
                continue                     # vanished between being listed and its type known
            except OSError as ex:
                self.error_row("type couldn't be determined: %s" % ex, row_path)
                continue
            if kind == "dir":
                self.walk_dir(row_path + SEP, acc_path + SEP)
            elif kind == "file":
                if any(c in row_path for c in "\t\r\n"):
                    raise StopRun("the file %s has a tab, CR or LF in its path; rename it or leave it out"
                                  % show(row_path))
                self.files.append((row_path, acc_path))
            elif kind == "link":
                self.judge_link(row_path, acc_path)
            else:
                continue                     # pipe, socket, device: no row

    def judge_link(self, row_path, acc_path):
        try:
            held = os.readlink(acc_path)
        except OSError:
            held = "?"
        held_shown = strip_ext_prefix(held) if WINDOWS else held
        try:
            target = real_path(acc_path, strict=True)
        except OSError as ex:
            winerr = getattr(ex, "winerror", None)
            if winerr in (2, 3, 1921) or ex.errno in (errno.ENOENT, errno.ENOTDIR, errno.ELOOP):
                return                       # broken: no row
            self.error_row("link somewhere this computer can't resolve (%s): %s" % (ex.strerror or ex, held_shown), row_path)
            return
        try:
            st = os.stat(access_path(target))
        except OSError as ex:
            self.error_row("link somewhere this computer can't resolve (%s): %s" % (ex.strerror or ex, held_shown), row_path)
            return
        if stat.S_ISDIR(st.st_mode):
            what = "folder"
        elif stat.S_ISREG(st.st_mode):
            what = "file"
        else:
            return                           # to a pipe, socket or device: no row
        for d in self.member_dirs:
            if path_within(target, d):
                return                       # into the backup: the target is recorded where it lies
        shown = row_path + SEP if what == "folder" else row_path
        self.error_row("link to a %s outside the backup: %s" % (what, held_shown), shown)


def hash_file(acc_path):
    """Open, fstat, hash. Returns (hash, size, mtime_instant) or raises OSError /
    ValueError(message) for an #error row."""
    flags = os.O_RDONLY
    for extra in ("O_BINARY", "O_NOFOLLOW", "O_NONBLOCK", "O_NOINHERIT", "O_CLOEXEC"):
        flags |= getattr(os, extra, 0)
    fd = os.open(acc_path, flags)
    try:
        st = os.fstat(fd)
        if not stat.S_ISREG(st.st_mode):
            raise ValueError("no longer a regular file")
        size = st.st_size
        mtime_ms = ns_to_ms_nearest(st.st_mtime_ns)
        instant = instant_from_ms(mtime_ms)
        if instant is None:
            raise ValueError("modification time can't be held in the 24-character form: %d ns since 1970" % st.st_mtime_ns)
        h = hashlib.sha256()
        total = 0
        with open(fd, "rb", closefd=False) as f:
            while True:
                chunk = f.read(READ_CHUNK)
                if not chunk:
                    break
                h.update(chunk)
                total += len(chunk)
        if total != size:
            raise ValueError("read returned %d bytes, expected %d" % (total, size))
        return h.hexdigest(), size, instant
    finally:
        os.close(fd)


# ----------------------------------------------------------------------------
# the bucket
# ----------------------------------------------------------------------------

class Repo:
    def __init__(self, bucket):
        self.bucket = bucket
        self.endpoint = os.environ.get("AWS_ENDPOINT_URL_S3") or os.environ.get("AWS_ENDPOINT_URL") or None
        self.is_aws = self.endpoint is None
        kwargs = {"retries": {"mode": "standard", "max_attempts": 3}}
        try:
            cfg = Config(request_checksum_calculation="when_required",
                         response_checksum_validation="when_required", **kwargs)
        except TypeError:
            cfg = Config(**kwargs)
        self.s3 = boto3.client("s3", endpoint_url=self.endpoint, config=cfg)

    @staticmethod
    def b64_sha256(data_or_digest):
        if isinstance(data_or_digest, (bytes, bytearray)) and len(data_or_digest) == 32:
            digest = bytes(data_or_digest)
        else:
            digest = hashlib.sha256(data_or_digest).digest()
        return base64.b64encode(digest).decode("ascii")

    def _sse(self):
        return {"ServerSideEncryption": "AES256"} if self.is_aws else {}

    def put_new(self, key, body, digest=None):
        """Conditional PUT (If-None-Match: *) of a whole body. Returns 'stored' or 'exists'."""
        if digest is None:
            digest = hashlib.sha256(body).digest()
        for attempt in range(6):
            try:
                self.s3.put_object(Bucket=self.bucket, Key=key, Body=body,
                                   ChecksumSHA256=base64.b64encode(digest).decode("ascii"),
                                   IfNoneMatch="*", **self._sse())
                return "stored"
            except ClientError as e:
                code = e.response.get("Error", {}).get("Code")
                status = e.response.get("ResponseMetadata", {}).get("HTTPStatusCode")
                if code == "PreconditionFailed" or status == 412:
                    return "exists"
                if code == "ConditionalRequestConflict" or status == 409:
                    time.sleep(0.2 * (attempt + 1))
                    continue
                raise
        raise RuntimeError("conditional PUT of %s kept conflicting" % key)

    def put_plain(self, key, body):
        self.s3.put_object(Bucket=self.bucket, Key=key, Body=body,
                           ChecksumSHA256=self.b64_sha256(body), **self._sse())

    def get(self, key):
        """Bytes at key, or None if there is no such key."""
        try:
            r = self.s3.get_object(Bucket=self.bucket, Key=key)
        except ClientError as e:
            code = e.response.get("Error", {}).get("Code")
            if code in ("NoSuchKey", "NotFound", "404"):
                return None
            raise
        return r["Body"].read()

    def head_exists(self, key):
        try:
            self.s3.head_object(Bucket=self.bucket, Key=key)
            return True
        except ClientError as e:
            code = e.response.get("Error", {}).get("Code")
            if code in ("404", "NoSuchKey", "NotFound"):
                return False
            raise

    def delete(self, key):
        self.s3.delete_object(Bucket=self.bucket, Key=key)

    def list_folder(self, prefix):
        """Keys directly in a folder (delimiter '/'), as names without the prefix."""
        names = []
        paginator = self.s3.get_paginator("list_objects_v2")
        for page in paginator.paginate(Bucket=self.bucket, Prefix=prefix, Delimiter="/"):
            for obj in page.get("Contents", []):
                names.append(obj["Key"][len(prefix):])
        return names

    def list_object_hashes(self):
        stored = set()
        for name in self.list_folder("objects/"):
            if HEX64_RE.match(name):
                stored.add(name)
        return stored


def parse_kv(data):
    """KEY=value lines as .info and a lock are read: UTF-8 with U+FFFD, split on LF, one
    trailing CR stripped, split at the first '=', last repeated key wins."""
    out = {}
    text = data.decode("utf-8", "replace")
    for line in text.split("\n"):
        if line.endswith("\r"):
            line = line[:-1]
        if "=" not in line:
            continue
        k, v = line.split("=", 1)
        out[k] = v
    return out


# ----------------------------------------------------------------------------
# state kept beside the program
# ----------------------------------------------------------------------------

def load_holders():
    try:
        with open(HOLDERS_FILE, "rb") as f:
            return json.loads(f.read().decode("utf-8"))
    except FileNotFoundError:
        return {}
    except (OSError, ValueError) as e:
        warn("warning: %s can't be read (%s); starting with no kept holder pairs" % (HOLDERS_FILE, e))
        return {}


def save_holders(holders):
    os.makedirs(STATE_DIR, exist_ok=True)
    tmp = HOLDERS_FILE + ".tmp"
    with open(tmp, "wb") as f:
        f.write(json.dumps(holders, indent=2, sort_keys=True).encode("utf-8"))
        f.write(b"\n")
    os.replace(tmp, HOLDERS_FILE)


def holder_key(bucket, set_name):
    return "s3://%s/%s" % (bucket, set_name)


# ----------------------------------------------------------------------------
# the run
# ----------------------------------------------------------------------------

class Backup:
    def __init__(self, bucket, set_name, dir_args, take_over):
        self.bucket = bucket
        self.set_name = set_name
        self.dir_args = dir_args
        self.take_over = take_over
        self.repo = None
        self.lock_key = None
        self.lock_body = None
        self.by = user_at_machine()
        self.pidns = pid_namespace()
        self.exit_code = 0

    # -- the clock -------------------------------------------------------------

    def read_start_clock(self):
        ns = time.time_ns()
        self.start_ns = ns
        self.start_instant = instant_from_ms(ns_to_ms_down(ns))
        lt = time.localtime(ns // 1_000_000_000)
        self.snapshot_name = time.strftime("%Y%m%dT%H%M", lt)
        self.zone = local_zone_name()

    # -- locks -----------------------------------------------------------------

    def lock_text(self, instant):
        lines = ["COMMAND=backup", "SET=" + self.set_name, "BY=" + self.by, "OS=" + sys.platform]
        if self.pidns:
            lines.append("PIDNS=" + self.pidns)
        lines.append("PID=%d" % os.getpid())
        lines.append("STARTED=" + instant)
        return ("\n".join(lines) + "\n").encode("utf-8")

    def write_lock(self):
        instant = self.start_instant
        while True:
            key = "locks/upload-" + basic_instant(instant)
            body = self.lock_text(instant)
            result = self.repo.put_new(key, body)
            if result == "stored":
                break
            existing = self.repo.get(key)
            if existing == body:
                break                        # our own write, retried after a lost response
            time.sleep(0.01)
            instant = instant_from_ms(ns_to_ms_down(time.time_ns()))
        self.lock_key = key
        self.lock_body = body
        say("lock %s written" % key[len("locks/"):])

    def check_locks(self):
        """List locks/: remove a dead run's of our own, refuse on any live delete lock."""
        for name in self.repo.list_folder("locks/"):
            key = "locks/" + name
            if key == self.lock_key:
                continue
            if not (name.startswith("upload-") or name.startswith("delete-")):
                continue
            data = self.repo.get(key)
            if data is None:
                continue
            kv = parse_kv(data)
            mine = (kv.get("BY") == self.by and kv.get("OS") == sys.platform
                    and (kv.get("PIDNS") or None) == (self.pidns or None))
            dead = False
            if mine and "OS" in kv and PID_RE.match(kv.get("PID", "")):
                alive = process_alive(int(kv["PID"]))
                dead = alive is False
            if dead:
                say("removing dead lock %s (pid %s is gone)" % (name, kv.get("PID")))
                try:
                    self.repo.delete(key)
                except ClientError as e:
                    warn("couldn't remove dead lock %s: %s" % (name, e))
                continue
            if name.startswith("delete-"):
                raise StopRun("a delete is running (lock %s, by %s); refusing to upload beside it"
                              % (name, kv.get("BY", "?")))

    def remove_lock(self):
        if not self.lock_key:
            return
        try:
            self.repo.delete(self.lock_key)
            say("lock %s removed" % self.lock_key[len("locks/"):])
        except Exception as e:
            warn("couldn't remove lock %s: %s; remove it by hand once this run is known dead"
                 % (self.lock_key[len("locks/"):], e))
        self.lock_key = None

    # -- the holder --------------------------------------------------------------

    def info_key(self):
        return "snapshots/%s.info" % self.set_name

    def info_text(self, owner, claimed, created):
        return ("OWNER=%s\nCLAIMED=%s\nCREATED=%s\n" % (owner, claimed, created)).encode("utf-8")

    def claim_or_check_holder(self, existing_snapshots):
        holders = load_holders()
        hk = holder_key(self.bucket, self.set_name)
        kept = holders.get(hk)
        info = self.repo.get(self.info_key())
        if info is not None:
            kv = parse_kv(info)
            if kept and kv.get("OWNER") == kept.get("OWNER") and kv.get("CLAIMED") == kept.get("CLAIMED"):
                say("set %s is held by this machine (%s, claimed %s)" % (self.set_name, kept["OWNER"], kept["CLAIMED"]))
                return
            if kept:
                say("the kept holder pair for %s no longer matches; forgetting it" % hk)
                del holders[hk]
                save_holders(holders)
            if not self.take_over:
                raise StopRun("set %s is held by %s (claimed %s); run with --take-over to take it over"
                              % (self.set_name, kv.get("OWNER", "?"), kv.get("CLAIMED", "?")))
            claimed = instant_from_ms(ns_to_ms_down(time.time_ns()))
            created = kv.get("CREATED") or claimed
            body = self.info_text(self.by, claimed, created)
            self.repo.put_plain(self.info_key(), body)
            holders[hk] = {"OWNER": self.by, "CLAIMED": claimed}
            save_holders(holders)
            say("took set %s over from %s" % (self.set_name, kv.get("OWNER", "?")))
            return
        # no .info in the bucket
        if existing_snapshots and not self.take_over:
            raise StopRun("set %s has snapshots but no .info: it has no holder until one takes it over (--take-over)"
                          % self.set_name)
        claimed = instant_from_ms(ns_to_ms_down(time.time_ns()))
        body = self.info_text(self.by, claimed, claimed)
        result = self.repo.put_new(self.info_key(), body)
        if result == "exists":
            back = self.repo.get(self.info_key())
            if back != body:
                raise StopRun("set name %s is taken: another machine claimed it first" % self.set_name)
        holders[hk] = {"OWNER": self.by, "CLAIMED": claimed}
        save_holders(holders)
        say("claimed set %s for %s" % (self.set_name, self.by))

    def check_holder_before_publish(self):
        holders = load_holders()
        hk = holder_key(self.bucket, self.set_name)
        kept = holders.get(hk)
        info = self.repo.get(self.info_key())
        if info is None:
            raise StopRun("snapshots/%s.info is gone: the set has no holder, so the snapshot isn't uploaded" % self.set_name)
        kv = parse_kv(info)
        if not kept or kv.get("OWNER") != kept.get("OWNER") or kv.get("CLAIMED") != kept.get("CLAIMED"):
            if kept:
                del holders[hk]
                save_holders(holders)
            raise StopRun("set %s is now held by %s (claimed %s); the snapshot isn't uploaded"
                          % (self.set_name, kv.get("OWNER", "?"), kv.get("CLAIMED", "?")))

    # -- the snapshot ------------------------------------------------------------

    def build_snapshot(self, walker, file_rows, finish_instant, files_count, size_sum):
        out = io.StringIO()
        out.write(heading_row())
        out.write(row("@S3CAB", "SPEC", "", "", SPEC_DATE))
        out.write(row("@CLIENT", "NAME", "", "", CLIENT_NAME))
        out.write(row("@CLIENT", "VERSION", "", "", CLIENT_VERSION))
        out.write(row("@SET", "NAME", "", "", self.set_name))
        out.write(row("@SET", "BUCKET", "", "", "s3://" + self.bucket))
        if self.repo.endpoint:
            out.write(row("@SET", "ENDPOINT", "", "", spell(self.repo.endpoint)))
        for d in self.member_dirs:
            out.write(row("@SET", "DIR", "", "", spell(d)))
        out.write(row("@SNAPSHOT", "NAME", "", "", self.snapshot_name))
        out.write(row("@SNAPSHOT", "BY", "", "", spell(self.by)))
        out.write(row("@SNAPSHOT", "START", "", self.start_instant, spell(self.zone)))
        for r in walker.walk_rows:
            out.write(r)
        for r in file_rows:
            out.write(r)
        out.write(row("@SNAPSHOT", "FILES", "", "", str(files_count)))
        out.write(row("@SNAPSHOT", "SIZE", "", "", "%d (%s)" % (size_sum, readable_size(size_sum))))
        duration = duration_text(ns_to_ms_up(self.finish_ns) - ns_to_ms_down(self.start_ns))
        out.write(row("@SNAPSHOT", "FINISH", "", finish_instant, duration))
        out.write(".\n")
        text = out.getvalue().encode("utf-8")
        buf = io.BytesIO()
        with gzip.GzipFile(filename="", mode="wb", fileobj=buf, mtime=0) as gz:
            gz.write(text)
        return text, buf.getvalue()

    def local_snapshot_path(self):
        return os.path.join(STATE_DIR, "snapshots", self.bucket, self.set_name, self.snapshot_name + ".tsv.gz")

    def write_local_snapshot(self, gz_bytes):
        path = self.local_snapshot_path()
        os.makedirs(os.path.dirname(path), exist_ok=True)
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_BINARY", 0), 0o644)
        with open(fd, "wb") as f:
            f.write(gz_bytes)
        return path

    # -- objects -------------------------------------------------------------------

    def send_object(self, hexhash, row_size, row_instant, acc_path, row_path):
        """Upload the file at acc_path to objects/<hexhash>, checking it first. Returns
        'stored', 'exists', or a reason string why nothing was sent."""
        key = "objects/" + hexhash
        want_digest = bytes.fromhex(hexhash)
        flags = os.O_RDONLY
        for extra in ("O_BINARY", "O_NOFOLLOW", "O_NONBLOCK", "O_NOINHERIT", "O_CLOEXEC"):
            flags |= getattr(os, extra, 0)
        try:
            fd = os.open(acc_path, flags)
        except OSError as e:
            return "can't be opened now: %s" % e
        try:
            st = os.fstat(fd)
            if not stat.S_ISREG(st.st_mode):
                return "is no longer a regular file"
            if st.st_size != row_size:
                return "size changed since it was hashed (%d, row says %d)" % (st.st_size, row_size)
            if instant_from_ms(ns_to_ms_nearest(st.st_mtime_ns)) != row_instant:
                return "modification time changed since it was hashed"
            with open(fd, "rb", closefd=False) as f:
                if row_size < MULTIPART_THRESHOLD:
                    body = f.read()
                    if len(body) != row_size:
                        return "read returned %d bytes, row says %d" % (len(body), row_size)
                    digest = hashlib.sha256(body).digest()
                    if digest != want_digest:
                        return "content changed since it was hashed (now %s)" % digest.hex()
                    return self.repo.put_new(key, body, digest)
                return self.send_multipart(key, want_digest, f, row_size)
        finally:
            os.close(fd)

    def send_multipart(self, key, want_digest, f, row_size):
        s3 = self.repo.s3
        create_kwargs = dict(Bucket=self.bucket, Key=key, ChecksumAlgorithm="SHA256", **self.repo._sse())
        upload_id = s3.create_multipart_upload(**create_kwargs)["UploadId"]
        parts = []
        whole = hashlib.sha256()
        total = 0
        try:
            n = 1
            while True:
                part = f.read(PART_SIZE)
                if not part and total >= row_size:
                    break
                if not part:
                    break
                whole.update(part)
                total += len(part)
                r = s3.upload_part(Bucket=self.bucket, Key=key, UploadId=upload_id, PartNumber=n,
                                   Body=part, ChecksumSHA256=self.repo.b64_sha256(part))
                parts.append({"PartNumber": n, "ETag": r["ETag"], "ChecksumSHA256": r["ChecksumSHA256"]})
                n += 1
            digest = whole.digest()
            if total != row_size or digest != want_digest:
                s3.abort_multipart_upload(Bucket=self.bucket, Key=key, UploadId=upload_id)
                return "content changed since it was hashed (now %s, %d bytes); upload aborted" % (digest.hex(), total)
            try:
                s3.complete_multipart_upload(Bucket=self.bucket, Key=key, UploadId=upload_id,
                                             MultipartUpload={"Parts": parts}, IfNoneMatch="*")
                return "stored"
            except ClientError as e:
                code = e.response.get("Error", {}).get("Code")
                status = e.response.get("ResponseMetadata", {}).get("HTTPStatusCode")
                if code == "PreconditionFailed" or status == 412:
                    s3.abort_multipart_upload(Bucket=self.bucket, Key=key, UploadId=upload_id)
                    return "exists"
                raise
        except Exception:
            try:
                s3.abort_multipart_upload(Bucket=self.bucket, Key=key, UploadId=upload_id)
            except Exception:
                pass
            raise

    # -- main ------------------------------------------------------------------------

    def run(self):
        _setup_stdio()
        if not SET_NAME_RE.match(self.set_name):
            raise StopRun("set name %r isn't one or more of a-z and 0-9 with single hyphens between" % self.set_name)
        self.read_start_clock()
        say("backup of set %s to s3://%s, snapshot %s, started %s (%s)"
            % (self.set_name, self.bucket, self.snapshot_name, self.start_instant, self.zone))

        # member directories: real paths, none inside another
        self.member_dirs = []
        for arg in self.dir_args:
            try:
                self.member_dirs.append(resolve_member_dir(arg))
            except ValueError as e:
                raise StopRun(str(e))
        for i, a in enumerate(self.member_dirs):
            for j, b in enumerate(self.member_dirs):
                if i != j and path_within(a, b):
                    if a == b:
                        raise StopRun("member directories %s and %s are the same directory" % (show(self.dir_args[i]), show(self.dir_args[j])))
                    raise StopRun("member directory %s lies inside %s" % (show(a), show(b)))
        for d in self.member_dirs:
            say("member directory %s" % show(d))

        self.repo = Repo(self.bucket)
        try:
            self.write_lock()
            self.check_locks()

            snapshot_names = [n for n in self.repo.list_folder("snapshots/%s/" % self.set_name) if SNAPSHOT_KEY_RE.match(n)]
            self.claim_or_check_holder(bool(snapshot_names))
            if self.snapshot_name + ".tsv.gz" in snapshot_names or os.path.exists(self.local_snapshot_path()):
                raise StopRun("a snapshot named %s already exists for set %s: a second snapshot in the same minute is refused"
                              % (self.snapshot_name, self.set_name))

            # the walk
            walker = Walker(self.member_dirs)
            walker.walk_all()
            say("walked: %d files, %d entries with an #error row" % (len(walker.files), len(walker.walk_rows)))

            # hashing
            file_rows = []
            first_path_for_hash = {}         # hash -> (row_path, acc_path, size, instant)
            files_count = 0
            size_sum = 0
            error_count = len(walker.walk_rows)
            for row_path, acc_path in walker.files:
                try:
                    hexhash, size, instant = hash_file(acc_path)
                except FileNotFoundError:
                    file_rows.append(row("#error", "vanished before it could be read", "", "", spell(row_path)))
                    error_count += 1
                    continue
                except ValueError as e:
                    file_rows.append(row("#error", spell(str(e)), "", "", spell(row_path)))
                    error_count += 1
                    continue
                except OSError as e:
                    file_rows.append(row("#error", spell("can't be read: %s" % (e.strerror or e)), "", "", spell(row_path)))
                    error_count += 1
                    continue
                file_rows.append(row("-", hexhash, str(size), instant, row_path))
                files_count += 1
                size_sum += size
                if hexhash not in first_path_for_hash:
                    first_path_for_hash[hexhash] = (row_path, acc_path, size, instant)
            self.finish_ns = time.time_ns()
            finish_instant = instant_from_ms(ns_to_ms_up(self.finish_ns))
            text, gz_bytes = self.build_snapshot(walker, file_rows, finish_instant, files_count, size_sum)
            reasons = validate_snapshot_bytes(gz_bytes)
            if reasons:
                raise StopRun("the snapshot this run built would be refused whole by a reader (%s); nothing uploaded, this is a bug"
                              % "; ".join(reasons))
            local = self.write_local_snapshot(gz_bytes)
            say("snapshot written: %s (%d file rows, %d bytes, %d #error rows)" % (local, files_count, size_sum, error_count))
            if error_count:
                self.exit_code = 1

            # objects first
            stored = self.repo.list_object_hashes()
            say("objects/ lists %d objects" % len(stored))
            to_send = [h for h in first_path_for_hash if h not in stored]
            say("%d unique contents in the snapshot, %d already stored, %d to send"
                % (len(first_path_for_hash), len(first_path_for_hash) - len(to_send), len(to_send)))
            failures = []
            sent = 0
            for hexhash in to_send:
                row_path, acc_path, size, instant = first_path_for_hash[hexhash]
                result = self.send_object(hexhash, size, instant, acc_path, row_path)
                if result == "stored":
                    sent += 1
                elif result == "exists":
                    pass
                else:
                    failures.append((row_path, hexhash, result))
                    warn("not sent: %s (%s): %s" % (show(row_path), hexhash[:12], result))
            say("%d objects sent" % sent)
            if failures:
                self.exit_code = 1
                raise StopRun("%d object(s) couldn't be stored as their rows say, so the snapshot %s isn't uploaded; re-run the backup"
                              % (len(failures), self.snapshot_name))

            # snapshot last
            self.check_holder_before_publish()
            key = "snapshots/%s/%s.tsv.gz" % (self.set_name, self.snapshot_name)
            result = self.repo.put_new(key, gz_bytes)
            if result == "exists":
                there = self.repo.get(key)
                if there == gz_bytes:
                    say("snapshot %s was already uploaded with these bytes" % key)
                else:
                    raise StopRun("snapshot %s already exists in the bucket with different bytes: refused" % key)
            else:
                say("snapshot uploaded: s3://%s/%s" % (self.bucket, key))
        finally:
            self.remove_lock()
        return self.exit_code


def main(argv):
    args = [a for a in argv[1:] if a != "--take-over"]
    take_over = "--take-over" in argv[1:]
    if len(args) < 3:
        warn(__doc__.strip())
        return 2
    bucket, set_name, dirs = args[0], args[1], args[2:]
    backup = Backup(bucket, set_name, dirs, take_over)
    try:
        return backup.run()
    except StopRun as e:
        warn("stopped: %s" % e)
        return 1
    except (ClientError, BotoCoreError) as e:
        warn("stopped: the bucket request failed: %s" % e)
        return 1
    except KeyboardInterrupt:
        warn("interrupted")
        return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
