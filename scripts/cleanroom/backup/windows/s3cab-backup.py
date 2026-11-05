#!/usr/bin/env python3
"""s3cab-backup: an independent backup writer for the s3cab repository format.

    python s3cab-backup.py [--take-over] <bucket> <set> <dir>...

Walks the member directories, uploads every file's content to objects/<sha256>,
then uploads the snapshot that names them to snapshots/<set>/<YYYYMMDDTHHMM>.tsv.gz,
claiming snapshots/<set>.info for this machine on the set's first backup.

Written from the format spec of 2026-10-30 alone. Python 3.10+ (3.12+ on Windows,
for DirEntry.is_junction) and boto3; nothing else. Credentials, region and an optional
endpoint come from the environment as boto3 reads them (AWS_ENDPOINT_URL makes it a
non-AWS store: no server-side encryption is asked for, and @SET ENDPOINT is written).

Choices the spec leaves to the tool:
  - nothing is excluded, so there are never #excluded rows; a name the format can't hold
    stops the run as the spec requires, and there is no way past it but renaming;
  - objects go in the default storage class (STANDARD on AWS), which a plain GET reads;
  - files of 16 MiB or more are sent in 16 MiB parts, smaller ones in one PUT;
  - --take-over is how a set held by another machine is taken over, when asked.

What it keeps beside itself:
  s3cab-backup.holders.json    the OWNER/CLAIMED pair it wrote to each set's .info
  snapshots/<set>/<name>.tsv.gz  a local copy of every snapshot it uploaded

Exit status: 0 when the snapshot was uploaded and holds no #error row; 1 when it was
uploaded but holds one, or when the run stopped and wrote no snapshot; 2 for usage.
"""

import base64
import ctypes
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

CLIENT_NAME = "s3cab-backup"
CLIENT_VERSION = "0.1.0"
SPEC_DATE = "2026-10-30"
FORMAT_URL = "https://s3cab.plantegral.com/guide/format"

WINDOWS = sys.platform == "win32"
SEP = "\\" if WINDOWS else "/"
MULTIPART_THRESHOLD = 16 * 1024 * 1024   # s3cab's: a file this big or bigger goes in parts
PART_SIZE = 16 * 1024 * 1024
READ_CHUNK = 1024 * 1024
SNAPSHOT_NAME_RE = re.compile(r"^[0-9]{8}T[0-9]{4}\.tsv\.gz$")
SET_NAME_RE = re.compile(r"^[a-z0-9]+(-[a-z0-9]+)*$")
HEX64_RE = re.compile(r"^[0-9a-f]{64}$")
DELETE_LOCK_RE = re.compile(r"^delete-")
UPLOAD_LOCK_RE = re.compile(r"^upload-")

PROGRAM_DIR = os.path.dirname(os.path.abspath(__file__))
STATE_FILE = os.path.join(PROGRAM_DIR, "s3cab-backup.holders.json")
LOCAL_SNAPSHOTS = os.path.join(PROGRAM_DIR, "snapshots")


class Stop(Exception):
    """The run stops, writes no snapshot, and says why."""


# ----------------------------------------------------------------------------
# Text helpers: display, spelling out, trimming, padding
# ----------------------------------------------------------------------------

def display(s):
    """A string safe to print and to put in a message: parts with no UTF-8 form become U+FFFD."""
    if WINDOWS:
        return s.encode("utf-8", "surrogatepass").decode("utf-8", "replace")
    return os.fsencode(s).decode("utf-8", "replace")


def spell_out(s):
    """Tab, CR and LF as the Control Pictures, for any field that may hold them."""
    return s.replace("\t", "\u2409").replace("\r", "\u240d").replace("\n", "\u240a")


def has_utf8_form(s):
    try:
        s.encode("utf-8")
        return True
    except UnicodeEncodeError:
        return False


def row(c1, c2="", c3="", c4="", c5=""):
    """One canonical line: column 1 unpadded, 2 right-padded to 64, 3 left-padded to 12,
    4 right-padded to 24 (code points), 5 verbatim, tabs between, LF at the end."""
    return c1 + "\t" + c2.ljust(64) + "\t" + c3.rjust(12) + "\t" + c4.ljust(24) + "\t" + c5 + "\n"


# ----------------------------------------------------------------------------
# Time helpers: everything stays an integer count until it is known to fit
# ----------------------------------------------------------------------------

def days_to_civil(z):
    """Days since 1970-01-01 to (year, month, day) in the proleptic Gregorian calendar."""
    z += 719468
    era = z // 146097
    doe = z - era * 146097
    yoe = (doe - doe // 1460 + doe // 36524 - doe // 146096) // 365
    y = yoe + era * 400
    doy = doe - (365 * yoe + yoe // 4 - yoe // 100)
    mp = (5 * doy + 2) // 153
    d = doy - (153 * mp + 2) // 5 + 1
    m = mp + 3 if mp < 10 else mp - 9
    return (y + (1 if m <= 2 else 0), m, d)


def instant24(ms):
    """Milliseconds since the epoch as YYYY-MM-DDTHH:MM:SS.sssZ, or None outside years 0000-9999."""
    secs, msec = divmod(ms, 1000)
    days, sod = divmod(secs, 86400)
    y, mo, d = days_to_civil(days)
    if y < 0 or y > 9999:
        return None
    h, rem = divmod(sod, 3600)
    mi, s = divmod(rem, 60)
    return "%04d-%02d-%02dT%02d:%02d:%02d.%03dZ" % (y, mo, d, h, mi, s, msec)


def instant_basic(ms):
    """The lock's form: YYYYMMDDTHHMMSS.sssZ."""
    t = instant24(ms)
    return t.replace("-", "").replace(":", "")


def round_ms(ns):
    """Nearest millisecond, a tie to the later one."""
    return (ns + 500_000) // 1_000_000


def floor_ms(ns):
    return ns // 1_000_000


def ceil_ms(ns):
    return -((-ns) // 1_000_000)


def readable_size(n):
    if n < 1000:
        return "%dB" % n
    for i, unit in enumerate(("kB", "MB", "GB", "TB", "PB"), start=1):
        div = 1000 ** i
        tenths = (n * 10 + div // 2) // div      # one decimal, rounded half up
        if tenths < 10000 or unit == "PB":
            return "%d.%d%s" % (tenths // 10, tenths % 10, unit)


def readable_duration(ms):
    s = ms // 1000
    if s < 60:
        return "%ds" % s
    if s < 3600:
        return "%dm %02ds" % (s // 60, s % 60)
    return "%dh %02dm" % (s // 3600, (s % 3600) // 60)


def local_zone_name():
    """The best name for the local zone this machine can give."""
    if WINDOWS:
        try:
            icu = ctypes.WinDLL("icu.dll")
            fn = icu.ucal_getDefaultTimeZone
            fn.restype = ctypes.c_int32
            buf = ctypes.create_unicode_buffer(256)
            status = ctypes.c_int32(0)
            n = fn(buf, 256, ctypes.byref(status))
            if status.value <= 0 and 0 < n < 256 and buf.value:
                return buf.value
        except Exception:
            pass
    else:
        try:
            p = os.path.realpath("/etc/localtime")
            i = p.find("zoneinfo/")
            if i >= 0 and p[i + 9:]:
                return p[i + 9:]
        except OSError:
            pass
    tz = os.environ.get("TZ")
    if tz:
        return tz.lstrip(":")
    return time.tzname[0] if time.tzname and time.tzname[0] else "unknown"


# ----------------------------------------------------------------------------
# Paths
# ----------------------------------------------------------------------------

def os_path(p):
    """The path to hand to the operating system: on Windows, through \\\\?\\."""
    if not WINDOWS:
        return p
    if p.startswith("\\\\?\\"):
        return p
    if p.startswith("\\\\"):
        return "\\\\?\\UNC\\" + p[2:]
    return "\\\\?\\" + p


def strip_prefix(p):
    if p.startswith("\\\\?\\UNC\\"):
        return "\\\\" + p[8:]
    if p.startswith("\\\\?\\"):
        return p[4:]
    return p


def is_windows_path(p):
    return bool(re.match(r"^[A-Za-z]:[\\/]", p)) or bool(re.match(r"^[\\/]{2}", p))


def split_segments(p):
    """(root, [segments]) by the spec's rules; the root of a Windows path is its drive or share."""
    if is_windows_path(p):
        parts = [s for s in re.split(r"[\\/]", p)]
        if p[1:2] == ":":
            return (parts[0].upper(), [s for s in parts[1:] if s])
        # share: \\server\share\...
        rest = [s for s in parts[2:]]
        server = rest[0] if rest else ""
        share = rest[1] if len(rest) > 1 else ""
        return ("\\\\" + server + "\\" + share, [s for s in rest[2:] if s])
    return ("/", [s for s in p.split("/") if s])


def under_or_equal(path, directory):
    """Whether `path` is `directory` or lies inside it, compared by whole segments, exactly."""
    r1, s1 = split_segments(path)
    r2, s2 = split_segments(directory)
    return r1 == r2 and s1[:len(s2)] == s2


def true_case_posix(path):
    """Spell each name as its parent's listing does (macOS, or a Linux folder that ignores case)."""
    out = "/"
    for seg in path.split("/"):
        if not seg:
            continue
        candidate = os.path.join(out, seg)
        try:
            with os.scandir(out) as it:
                names = [e.name for e in it]
        except OSError:
            out = candidate
            continue
        if seg in names:
            out = candidate
        else:
            twins = [n for n in names if n.casefold() == seg.casefold()]
            out = os.path.join(out, twins[0]) if len(twins) == 1 else candidate
    return out


def member_real_path(arg):
    """A member directory's real path, spelled as the filesystem reports it."""
    absolute = os.path.normpath(os.path.join(os.getcwd(), arg))
    try:
        real = os.path.realpath(os_path(absolute), strict=True)
    except OSError as e:
        raise Stop("member directory %s can't be resolved: %s" % (display(arg), e))
    if WINDOWS:
        real = strip_prefix(real)
        if re.match(r"^[A-Za-z]:\\", real):
            real = real[0].upper() + real[1:]
        elif real.startswith("\\\\") and len([s for s in real[2:].split("\\") if s]) >= 2:
            pass
        else:
            raise Stop("member directory %s has no drive letter and no share (%s): no path a reader accepts can name it"
                       % (display(arg), display(real)))
    else:
        real = true_case_posix(real)
    try:
        st = os.stat(os_path(real))
    except OSError as e:
        raise Stop("member directory %s doesn't exist: %s" % (display(arg), e))
    if not stat.S_ISDIR(st.st_mode):
        raise Stop("member directory %s isn't a directory" % display(arg))
    if not has_utf8_form(real):
        raise Stop("member directory's path has no UTF-8 form: %s" % display(real))
    return real


def dir_row_path(real):
    return real if real.endswith(SEP) else real + SEP


# ----------------------------------------------------------------------------
# The walk
# ----------------------------------------------------------------------------

class Walk:
    def __init__(self, members):
        self.members = members            # real paths, no trailing separator (except a root)
        self.head_errors = []             # (message, path) rows written near the top
        self.body = []                    # ("-", hash, size, time, path) or ("#error", message, path), in walk order
        self.first_path_for_hash = {}     # hash -> (recorded path, size, ms)
        self.total_size = 0
        self.file_count = 0

    def error_row(self, where, path, message):
        where.append(("#error", spell_out(display(message)), spell_out(display(path))))

    def broken_link_error(self, e):
        if WINDOWS:
            return getattr(e, "winerror", None) in (2, 3, 1921)
        return e.errno in (errno.ENOENT, errno.ENOTDIR, errno.ELOOP)

    def walk_member(self, real):
        self.walk_dir(real, os_path(real))

    def walk_dir(self, rec_dir, os_dir):
        try:
            with os.scandir(os_dir) as it:
                entries = list(it)
        except OSError as e:
            raise Stop("directory can't be listed: %s: %s" % (display(rec_dir), e.strerror or e))
        for entry in entries:
            name = entry.name
            rec = os.path.join(rec_dir, name)
            if not has_utf8_form(name):
                raise Stop("an entry's name has no UTF-8 form: %s" % display(rec))
            try:
                if entry.is_symlink() or (WINDOWS and entry.is_junction()):
                    kind = "link"
                elif entry.is_dir(follow_symlinks=False):
                    kind = "dir"
                elif entry.is_file(follow_symlinks=False):
                    kind = "file"
                else:
                    kind = "other"
            except FileNotFoundError:
                continue                   # vanished between being listed and its type being known
            except OSError as e:
                self.error_row(self.head_errors, rec, "type couldn't be determined: %s" % (e.strerror or e))
                continue
            if kind == "dir":
                self.walk_dir(rec, entry.path)
            elif kind == "file":
                self.record_file(rec, entry.path)
            elif kind == "link":
                self.record_link(rec, entry.path)
            # pipes, sockets, devices: no row

    def record_file(self, rec, ospath):
        if "\t" in rec or "\r" in rec or "\n" in rec:
            raise Stop("a file's path holds a tab, CR or LF: %s" % spell_out(display(rec)))
        try:
            with open(ospath, "rb", buffering=0) as f:
                st = os.fstat(f.fileno())
                if not stat.S_ISREG(st.st_mode):
                    return                 # not a regular file after all: no row
                size, mtime_ns = st.st_size, st.st_mtime_ns
                h = hashlib.sha256()
                n = 0
                while True:
                    chunk = f.read(READ_CHUNK)
                    if not chunk:
                        break
                    h.update(chunk)
                    n += len(chunk)
        except FileNotFoundError:
            self.error_row(self.body, rec, "vanished before it could be read")
            return
        except OSError as e:
            self.error_row(self.body, rec, "couldn't be read: %s" % (e.strerror or e))
            return
        if n != size:
            self.error_row(self.body, rec, "read returned %d bytes where the size was %d" % (n, size))
            return
        ms = round_ms(mtime_ns)
        t = instant24(ms)
        if t is None:
            self.error_row(self.body, rec, "modification time can't be held in the 24-character form: %d ms since 1970" % ms)
            return
        digest = h.hexdigest()
        self.body.append(("-", digest, str(size), t, rec))
        self.file_count += 1
        self.total_size += size
        if digest not in self.first_path_for_hash:
            self.first_path_for_hash[digest] = (rec, ospath, size, ms)

    def record_link(self, rec, ospath):
        try:
            target_text = os.readlink(ospath)
            if WINDOWS:
                target_text = strip_prefix(target_text)
        except OSError:
            target_text = "?"
        try:
            real = os.path.realpath(ospath, strict=True)
        except OSError as e:
            if self.broken_link_error(e):
                return                     # broken: no row
            self.error_row(self.head_errors, rec,
                           "link to somewhere this computer can't resolve: %s (%s)" % (target_text, e.strerror or e))
            return
        try:
            tst = os.stat(os_path(real))
        except OSError as e:
            if self.broken_link_error(e):
                return
            self.error_row(self.head_errors, rec,
                           "link to somewhere this computer can't resolve: %s (%s)" % (target_text, e.strerror or e))
            return
        if stat.S_ISDIR(tst.st_mode):
            what = "folder"
        elif stat.S_ISREG(tst.st_mode):
            what = "file"
        else:
            return                         # to a pipe, socket or device: no row
        if WINDOWS:
            real = strip_prefix(real)
            if re.match(r"^[A-Za-z]:\\", real):
                real = real[0].upper() + real[1:]
        else:
            real = true_case_posix(real)
        for member in self.members:
            if under_or_equal(real, member):
                return                     # into the backup: the target is recorded where it lies
        path = rec + SEP if what == "folder" else rec
        self.error_row(self.head_errors, path, "link to a %s outside the backup: %s" % (what, target_text))


# ----------------------------------------------------------------------------
# State kept beside the program
# ----------------------------------------------------------------------------

def load_state():
    try:
        with open(STATE_FILE, "rb") as f:
            return json.loads(f.read().decode("utf-8"))
    except FileNotFoundError:
        return {}
    except (OSError, ValueError) as e:
        raise Stop("can't read %s: %s" % (STATE_FILE, e))


def save_state(state):
    data = json.dumps(state, indent=2, sort_keys=True).encode("utf-8")
    tmp = STATE_FILE + ".tmp"
    with open(tmp, "wb") as f:
        f.write(data)
    os.replace(tmp, STATE_FILE)


# ----------------------------------------------------------------------------
# The bucket
# ----------------------------------------------------------------------------

def parse_kv(text):
    """KEY=value lines as .info and a lock are read: split on LF, one trailing CR stripped, last key wins."""
    out = {}
    for line in text.split("\n"):
        if line.endswith("\r"):
            line = line[:-1]
        if "=" not in line:
            continue
        k, v = line.split("=", 1)
        out[k] = v
    return out


def b64_digest_hex(hexdigest):
    return base64.b64encode(bytes.fromhex(hexdigest)).decode("ascii")


class Repository:
    def __init__(self, bucket):
        import boto3
        from botocore.config import Config
        from botocore.exceptions import ClientError
        self.ClientError = ClientError
        self.bucket = bucket
        self.endpoint = os.environ.get("AWS_ENDPOINT_URL_S3") or os.environ.get("AWS_ENDPOINT_URL") or None
        self.on_aws = self.endpoint is None
        region = os.environ.get("AWS_REGION") or os.environ.get("AWS_DEFAULT_REGION") or None
        kwargs = {"config": Config(retries={"mode": "standard"})}
        if region:
            kwargs["region_name"] = region
        self.s3 = boto3.client("s3", **kwargs)
        self.requests = 0

    def status(self, e):
        return e.response.get("ResponseMetadata", {}).get("HTTPStatusCode")

    def code(self, e):
        return e.response.get("Error", {}).get("Code")

    def sse(self):
        return {"ServerSideEncryption": "AES256"} if self.on_aws else {}

    def list_keys(self, prefix, delimiter=None):
        """Every key under the prefix (directly in it, with a delimiter)."""
        kwargs = {"Bucket": self.bucket, "Prefix": prefix}
        if delimiter:
            kwargs["Delimiter"] = delimiter
        keys = []
        for page in self.s3.get_paginator("list_objects_v2").paginate(**kwargs):
            self.requests += 1
            for item in page.get("Contents", []):
                keys.append(item["Key"])
        return keys

    def get(self, key):
        """The object's bytes, or None when the key is missing."""
        try:
            self.requests += 1
            r = self.s3.get_object(Bucket=self.bucket, Key=key)
            return r["Body"].read()
        except self.ClientError as e:
            if self.code(e) in ("NoSuchKey", "NotFound") or self.status(e) == 404:
                return None
            raise

    def head(self, key):
        try:
            self.requests += 1
            self.s3.head_object(Bucket=self.bucket, Key=key)
            return True
        except self.ClientError as e:
            if self.status(e) == 404:
                return False
            raise

    def put_new(self, key, body):
        """A no-overwrite PUT, with the SHA-256 S3 checks itself. True when stored, False on 412."""
        digest = hashlib.sha256(body).hexdigest()
        try:
            self.requests += 1
            self.s3.put_object(Bucket=self.bucket, Key=key, Body=body, IfNoneMatch="*",
                               ChecksumSHA256=b64_digest_hex(digest), **self.sse())
            return True
        except self.ClientError as e:
            if self.status(e) == 412 or self.code(e) == "PreconditionFailed":
                return False
            raise

    def put_plain(self, key, body):
        digest = hashlib.sha256(body).hexdigest()
        self.requests += 1
        self.s3.put_object(Bucket=self.bucket, Key=key, Body=body,
                           ChecksumSHA256=b64_digest_hex(digest), **self.sse())

    def delete(self, key):
        self.requests += 1
        self.s3.delete_object(Bucket=self.bucket, Key=key)

    def put_object_single(self, key, data, expected_hex):
        """One PUT of bytes already hashed to the key; S3 verifies the same digest before storing."""
        try:
            self.requests += 1
            self.s3.put_object(Bucket=self.bucket, Key=key, Body=data, IfNoneMatch="*",
                               ChecksumSHA256=b64_digest_hex(expected_hex), **self.sse())
            return "uploaded"
        except self.ClientError as e:
            if self.status(e) == 412 or self.code(e) == "PreconditionFailed":
                return "already stored"
            raise

    def put_object_multipart(self, key, f, size, expected_hex):
        """Parts with their own checksums; the last part is sent only once the whole hash equals the key."""
        n_parts = max(1, (size + PART_SIZE - 1) // PART_SIZE)
        self.requests += 1
        created = self.s3.create_multipart_upload(Bucket=self.bucket, Key=key, ChecksumAlgorithm="SHA256", **self.sse())
        upload_id = created["UploadId"]
        parts = []
        whole = hashlib.sha256()
        try:
            for i in range(1, n_parts + 1):
                want = PART_SIZE if i < n_parts else size - PART_SIZE * (n_parts - 1)
                data = read_exactly(f, want)
                whole.update(data)
                if i == n_parts:
                    extra = f.read(1)
                    if extra:
                        whole.update(extra)   # the file grew: the hash can no longer match the key
                    if whole.hexdigest() != expected_hex:
                        raise Stop("file changed while being sent (its bytes no longer hash to %s): %s"
                                   % (expected_hex, display(f.name)))
                part_digest = hashlib.sha256(data).hexdigest()
                self.requests += 1
                r = self.s3.upload_part(Bucket=self.bucket, Key=key, UploadId=upload_id, PartNumber=i,
                                        Body=data, ChecksumSHA256=b64_digest_hex(part_digest))
                parts.append({"ETag": r["ETag"], "PartNumber": i, "ChecksumSHA256": r["ChecksumSHA256"]})
            try:
                self.requests += 1
                self.s3.complete_multipart_upload(Bucket=self.bucket, Key=key, UploadId=upload_id,
                                                  MultipartUpload={"Parts": parts}, IfNoneMatch="*")
                return "uploaded"
            except self.ClientError as e:
                if self.status(e) == 412 or self.code(e) == "PreconditionFailed":
                    self.abort(key, upload_id)
                    return "already stored"
                raise
        except BaseException:
            self.abort(key, upload_id)
            raise

    def abort(self, key, upload_id):
        try:
            self.requests += 1
            self.s3.abort_multipart_upload(Bucket=self.bucket, Key=key, UploadId=upload_id)
        except Exception as e:
            print("warning: couldn't abort multipart upload %s for %s: %s" % (upload_id, key, e), file=sys.stderr)


def check_snapshot_text(text, dir_rows):
    """A reader's whole-file checks, run on our own output before it is uploaded: a snapshot a
    reader would refuse must never reach the bucket. Raises Stop on any failure (a bug here)."""
    if text.startswith(b"\xef\xbb\xbf"):
        raise Stop("internal: snapshot starts with a BOM")
    try:
        s = text.decode("utf-8", "strict")
    except UnicodeDecodeError as e:
        raise Stop("internal: snapshot isn't UTF-8: %s" % e)
    if "\r" in s or not s.endswith("\n"):
        raise Stop("internal: snapshot has a CR or an unterminated last line")
    lines = s.split("\n")[:-1]
    if not lines or lines[-1] != ".":
        raise Stop("internal: snapshot doesn't end with the . line")
    if lines[0] != row("@S3CAB", "FORMAT", "size", "time", FORMAT_URL)[:-1]:
        raise Stop("internal: snapshot doesn't start with the heading row")
    seen = set()
    for line in lines[:-1]:
        if line == "":
            raise Stop("internal: snapshot holds a blank line")
        fields = line.split("\t", 4)
        if len(fields) != 5:
            raise Stop("internal: a line has fewer than five fields: %r" % line)
        kind = fields[0]
        if kind == "-":
            h, size, t, path = fields[1].strip(" "), fields[2].strip(" "), fields[3].strip(" "), fields[4]
            if not HEX64_RE.match(h) or not size.isdigit() or not re.match(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$", t):
                raise Stop("internal: malformed file row: %r" % line)
            if "\x00" in path or not any(path.startswith(d) and len(path) > len(d) for d in dir_rows):
                raise Stop("internal: file row under no @SET DIR: %r" % path)
            if path in seen:
                raise Stop("internal: path in two rows: %r" % path)
            seen.add(path)
        elif kind in ("#error", "#excluded"):
            if fields[4] in seen:
                raise Stop("internal: path in two rows: %r" % fields[4])
            seen.add(fields[4])
        elif kind not in ("@S3CAB", "@CLIENT", "@SET", "@SNAPSHOT"):
            raise Stop("internal: unknown row type %r" % kind)


def read_exactly(f, want):
    chunks = []
    got = 0
    while got < want:
        chunk = f.read(min(READ_CHUNK, want - got))
        if not chunk:
            break
        chunks.append(chunk)
        got += len(chunk)
    return b"".join(chunks)


# ----------------------------------------------------------------------------
# Locks and the holder
# ----------------------------------------------------------------------------

def process_alive(pid):
    if WINDOWS:
        k32 = ctypes.WinDLL("kernel32", use_last_error=True)
        k32.OpenProcess.restype = ctypes.c_void_p
        k32.OpenProcess.argtypes = [ctypes.c_uint32, ctypes.c_int, ctypes.c_uint32]
        k32.GetExitCodeProcess.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_ulong)]
        k32.CloseHandle.argtypes = [ctypes.c_void_p]
        h = k32.OpenProcess(0x1000, 0, pid)     # PROCESS_QUERY_LIMITED_INFORMATION
        if not h:
            return ctypes.get_last_error() == 5  # access denied: it exists; anything else: it doesn't
        try:
            code = ctypes.c_ulong(0)
            if not k32.GetExitCodeProcess(h, ctypes.byref(code)):
                return True
            return code.value == 259            # STILL_ACTIVE
        finally:
            k32.CloseHandle(h)
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


class Run:
    def __init__(self, bucket, set_name, dirs, take_over):
        self.bucket = bucket
        self.set_name = set_name
        self.dir_args = dirs
        self.take_over = take_over
        self.repo = None
        self.lock_key = None
        self.lock_body = None
        self.by = "%s@%s" % (getpass.getuser(), socket.gethostname())
        self.pidns = None
        if sys.platform.startswith("linux"):
            try:
                self.pidns = os.readlink("/proc/self/ns/pid")
            except OSError:
                self.pidns = None
        self.state_key = "s3://%s/%s" % (bucket, set_name)

    # -- locks ---------------------------------------------------------------

    def write_lock(self, start_ms):
        instant = start_ms
        for _ in range(20):
            lock_id = "upload-" + instant_basic(instant)
            key = "locks/" + lock_id
            lines = ["COMMAND=backup", "SET=" + self.set_name, "BY=" + self.by, "OS=" + sys.platform]
            if self.pidns:
                lines.append("PIDNS=" + self.pidns)
            lines += ["PID=%d" % os.getpid(), "STARTED=" + instant24(instant)]
            body = ("\n".join(lines) + "\n").encode("utf-8")
            if self.repo.put_new(key, body):
                self.lock_key, self.lock_body = key, body
                return lock_id
            existing = self.repo.get(key)
            if existing == body:
                self.lock_key, self.lock_body = key, body
                return lock_id
            instant = floor_ms(time.time_ns())
            if instant <= start_ms:
                instant = start_ms + 1
            start_ms = instant
        raise Stop("couldn't write an upload lock: every instant tried was taken")

    def check_locks(self):
        for key in self.repo.list_keys("locks/"):
            lock_id = key[len("locks/"):]
            if key == self.lock_key:
                continue
            if DELETE_LOCK_RE.match(lock_id):
                raise Stop("a delete is running (lock %s): refusing to upload beside it" % lock_id)
            if not UPLOAD_LOCK_RE.match(lock_id):
                continue
            body = self.repo.get(key)
            if body is None:
                continue
            info = parse_kv(body.decode("utf-8", "replace"))
            if info.get("BY") != self.by or "OS" not in info or info.get("OS") != sys.platform:
                continue
            if info.get("PIDNS") != self.pidns:
                continue
            try:
                pid = int(info.get("PID", ""))
            except ValueError:
                continue
            if process_alive(pid):
                continue
            print("removing a dead run's lock %s (pid %d is gone)" % (lock_id, pid))
            self.repo.delete(key)

    def remove_lock(self):
        if self.lock_key is None:
            return
        try:
            self.repo.delete(self.lock_key)
            self.lock_key = None
        except Exception as e:
            print("warning: couldn't remove lock %s; remove it by hand: %s" % (self.lock_key[len("locks/"):], e),
                  file=sys.stderr)

    # -- the holder ----------------------------------------------------------

    def info_key(self):
        return "snapshots/%s.info" % self.set_name

    def read_info(self):
        body = self.repo.get(self.info_key())
        if body is None:
            return None
        return parse_kv(body.decode("utf-8", "replace"))

    def set_has_snapshots(self):
        prefix = "snapshots/%s/" % self.set_name
        for key in self.repo.list_keys(prefix, delimiter="/"):
            if SNAPSHOT_NAME_RE.match(key[len(prefix):]):
                return True
        return False

    def info_body(self, owner, claimed, created):
        return ("OWNER=%s\nCLAIMED=%s\nCREATED=%s\n" % (owner, claimed, created)).encode("utf-8")

    def claim_or_check(self, now_ms):
        state = load_state()
        pair = state.get(self.state_key)
        info = self.read_info()
        if info is None:
            if self.set_has_snapshots() and not self.take_over:
                raise Stop("set %s already has snapshots but no .info: it has no holder until one takes it over (--take-over)"
                           % self.set_name)
            claimed = instant24(now_ms)
            body = self.info_body(self.by, claimed, claimed)
            if not self.repo.put_new(self.info_key(), body):
                info = self.read_info() or {}
                if info.get("OWNER") != self.by or info.get("CLAIMED") != claimed:
                    raise Stop("set %s was claimed by %s at the same moment" % (self.set_name, info.get("OWNER")))
            state[self.state_key] = {"OWNER": self.by, "CLAIMED": claimed}
            save_state(state)
            print("claimed set %s for %s" % (self.set_name, self.by))
            return
        if pair and info.get("OWNER") == pair.get("OWNER") and info.get("CLAIMED") == pair.get("CLAIMED"):
            return
        if self.take_over:
            claimed = instant24(now_ms)
            created = info.get("CREATED") or claimed
            self.repo.put_plain(self.info_key(), self.info_body(self.by, claimed, created))
            state[self.state_key] = {"OWNER": self.by, "CLAIMED": claimed}
            save_state(state)
            print("took over set %s from %s" % (self.set_name, info.get("OWNER")))
            return
        if pair:
            del state[self.state_key]
            save_state(state)
        raise Stop("set %s is held by %s (claimed %s), not by this machine; --take-over to take it"
                   % (self.set_name, info.get("OWNER"), info.get("CLAIMED")))

    def check_holder(self):
        state = load_state()
        pair = state.get(self.state_key)
        info = self.read_info()
        if info is None:
            raise Stop("set %s has no .info any more: it has no holder until one takes it over" % self.set_name)
        if not pair or info.get("OWNER") != pair.get("OWNER") or info.get("CLAIMED") != pair.get("CLAIMED"):
            if pair:
                del state[self.state_key]
                save_state(state)
            raise Stop("set %s is now held by %s (claimed %s): refusing to publish" % (self.set_name, info.get("OWNER"), info.get("CLAIMED")))

    # -- the run ---------------------------------------------------------------

    def run(self):
        if not SET_NAME_RE.match(self.set_name):
            raise Stop("set name %r isn't letters a-z and digits with single hyphens between" % self.set_name)
        if not self.dir_args:
            raise Stop("no member directory given")

        start_ns = time.time_ns()
        start_ms = floor_ms(start_ns)
        start_instant = instant24(start_ms)
        lt = time.localtime(start_ms // 1000)
        snapshot_name = "%04d%02d%02dT%02d%02d" % (lt.tm_year, lt.tm_mon, lt.tm_mday, lt.tm_hour, lt.tm_min)
        zone = local_zone_name()

        members = []
        for arg in self.dir_args:
            real = member_real_path(arg)
            for other in members:
                if under_or_equal(real, other) or under_or_equal(other, real):
                    raise Stop("member directories overlap: %s and %s" % (display(other), display(real)))
            members.append(real)

        self.repo = Repository(self.bucket)
        lock_id = self.write_lock(start_ms)
        print("lock %s" % lock_id)
        try:
            self.check_locks()
            self.claim_or_check(start_ms)

            walk = Walk(members)
            for real in members:
                walk.walk_member(real)

            # -- the snapshot text --
            lines = [row("@S3CAB", "FORMAT", "size", "time", FORMAT_URL),
                     row("@S3CAB", "SPEC", "", "", SPEC_DATE),
                     row("@CLIENT", "NAME", "", "", CLIENT_NAME),
                     row("@CLIENT", "VERSION", "", "", CLIENT_VERSION),
                     row("@SET", "NAME", "", "", self.set_name),
                     row("@SET", "BUCKET", "", "", "s3://" + self.bucket)]
            if self.repo.endpoint:
                lines.append(row("@SET", "ENDPOINT", "", "", spell_out(self.repo.endpoint)))
            for real in members:
                lines.append(row("@SET", "DIR", "", "", spell_out(dir_row_path(real))))
            lines += [row("@SNAPSHOT", "NAME", "", "", snapshot_name),
                      row("@SNAPSHOT", "BY", "", "", spell_out(self.by)),
                      row("@SNAPSHOT", "START", "", start_instant, spell_out(zone))]
            for _, message, path in walk.head_errors:
                lines.append(row("#error", message, "", "", path))
            for r in walk.body:
                if r[0] == "-":
                    lines.append(row("-", r[1], r[2], r[3], r[4]))
                else:
                    lines.append(row("#error", r[1], "", "", r[2]))
            finish_ms = ceil_ms(time.time_ns())
            lines += [row("@SNAPSHOT", "FILES", "", "", str(walk.file_count)),
                      row("@SNAPSHOT", "SIZE", "", "", "%d (%s)" % (walk.total_size, readable_size(walk.total_size))),
                      row("@SNAPSHOT", "FINISH", "", instant24(finish_ms), readable_duration(finish_ms - start_ms)),
                      ".\n"]
            text = "".join(lines).encode("utf-8")
            check_snapshot_text(text, [dir_row_path(real) for real in members])
            buf = io.BytesIO()
            with gzip.GzipFile(filename="", mode="wb", fileobj=buf, mtime=0) as gz:
                gz.write(text)
            snapshot_bytes = buf.getvalue()

            # -- the local copy, never over an existing one --
            local_dir = os.path.join(LOCAL_SNAPSHOTS, self.set_name)
            os.makedirs(local_dir, exist_ok=True)
            local_path = os.path.join(local_dir, snapshot_name + ".tsv.gz")
            try:
                with open(local_path, "xb") as f:
                    f.write(snapshot_bytes)
            except FileExistsError:
                raise Stop("a snapshot of %s named %s already exists locally (%s): a second snapshot in the same minute is refused"
                           % (self.set_name, snapshot_name, local_path))
            errors = len(walk.head_errors) + sum(1 for r in walk.body if r[0] != "-")
            print("snapshot %s: %d files, %d bytes, %d #error rows, %d distinct objects"
                  % (snapshot_name, walk.file_count, walk.total_size, errors, len(walk.first_path_for_hash)))

            # -- objects first --
            stored = set()
            for key in self.repo.list_keys("objects/"):
                h = key[len("objects/"):]
                if HEX64_RE.match(h):
                    stored.add(h)
            uploaded = skipped = 0
            for digest, (rec, ospath, size, ms) in walk.first_path_for_hash.items():
                if digest in stored:
                    skipped += 1
                    continue
                result = self.upload_object(digest, rec, ospath, size, ms)
                if result == "uploaded":
                    uploaded += 1
                else:
                    skipped += 1
            print("objects: %d uploaded, %d already stored" % (uploaded, skipped))

            # -- snapshot last --
            self.check_holder()
            snapshot_key = "snapshots/%s/%s.tsv.gz" % (self.set_name, snapshot_name)
            if self.repo.put_new(snapshot_key, snapshot_bytes):
                print("uploaded %s" % snapshot_key)
            else:
                existing = self.repo.get(snapshot_key)
                if existing == snapshot_bytes:
                    print("%s was already uploaded with the same bytes" % snapshot_key)
                else:
                    raise Stop("%s already exists in the bucket with different bytes: a second snapshot in the same minute is refused"
                               % snapshot_key)
            if errors:
                print("%d #error row(s) in the snapshot: exit 1" % errors, file=sys.stderr)
                return 1
            return 0
        finally:
            self.remove_lock()

    def upload_object(self, digest, rec, ospath, size, ms):
        key = "objects/" + digest
        try:
            f = open(ospath, "rb", buffering=0)
        except OSError as e:
            raise Stop("can't open %s to send it: %s" % (display(rec), e.strerror or e))
        with f:
            st = os.fstat(f.fileno())
            if st.st_size != size or round_ms(st.st_mtime_ns) != ms:
                raise Stop("file changed since it was recorded (size %d -> %d, mtime %s -> %s): %s"
                           % (size, st.st_size, instant24(ms), instant24(round_ms(st.st_mtime_ns)), display(rec)))
            if size < MULTIPART_THRESHOLD:
                data = read_exactly(f, size)
                extra = f.read(1)
                if extra:
                    data += extra + f.read()
                if hashlib.sha256(data).hexdigest() != digest:
                    raise Stop("file changed while being read for upload (its bytes no longer hash to %s): %s" % (digest, display(rec)))
                return self.repo.put_object_single(key, data, digest)
            if self.repo.head(key):
                return "already stored"
            return self.repo.put_object_multipart(key, f, size, digest)


def main(argv):
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace", line_buffering=True)
        sys.stderr.reconfigure(encoding="utf-8", errors="replace", line_buffering=True)
    except Exception:
        pass
    args = list(argv[1:])
    take_over = False
    while args and args[0].startswith("--"):
        opt = args.pop(0)
        if opt == "--":
            break
        if opt == "--take-over":
            take_over = True
        elif opt == "--help":
            print(__doc__)
            return 0
        else:
            print("unknown option %s" % opt, file=sys.stderr)
            return 2
    if len(args) < 3:
        print("usage: python s3cab-backup.py [--take-over] <bucket> <set> <dir>...", file=sys.stderr)
        return 2
    bucket = args[0]
    if bucket.startswith("s3://"):
        bucket = bucket[5:].rstrip("/")
    run = Run(bucket, args[1], args[2:], take_over)
    try:
        return run.run()
    except Stop as e:
        print("stopped: %s" % e, file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        print("interrupted", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
