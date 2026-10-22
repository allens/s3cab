#!/usr/bin/env python3
"""s3cab-backup: write one backup of a set into an s3cab repository, from the format spec alone.

    python s3cab-backup.py <bucket> <set> <dir>...

Walks the member directories, stores every file's content at objects/<sha256>, then uploads
the snapshot that names them to snapshots/<set>/<YYYY-MM-DDTHHMM>.tsv.gz. The set's holder
pair (OWNER, CLAIMED) and a local copy of every snapshot are kept beside this program, in
s3cab-backup.state/.

Exit status: 0 backed up; 1 backed up, but the snapshot holds #error rows; 2 refused or failed,
no snapshot written.

Python 3.10+ and boto3 only.
"""

import base64
import datetime
import errno
import getpass
import gzip
import hashlib
import io
import os
import re
import socket
import stat
import sys
import time
import unicodedata

import boto3
from botocore.config import Config
from botocore.exceptions import BotoCoreError, ClientError

SPEC_DATE = "2026-10-20"
CLIENT_NAME = "s3cab-backup"
CLIENT_VERSION = "0.1.0"
HEADING = ("@S3CAB", "FORMAT", "size", "time", "https://s3cab.plantegral.com/guide/format")

WINDOWS = os.name == "nt"
SEP = "\\" if WINDOWS else "/"

# Windows reparse tags that are links; every other reparse point is an ordinary file or directory.
IO_REPARSE_TAG_SYMLINK = 0xA000000C
IO_REPARSE_TAG_MOUNT_POINT = 0xA0000003

# Files up to this size are read into memory once, hashed, and sent from that same buffer.
# Larger ones go up in parts, each part hashed as it is sent.
SINGLE_PUT_MAX = 16 * 1024 * 1024
PART_SIZE = 8 * 1024 * 1024
MAX_PARTS = 10000
READ_CHUNK = 1024 * 1024
READ_ATTEMPTS = 3

STATE_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "s3cab-backup.state")

SET_NAME_RE = re.compile(r"[a-z0-9-]+\Z")
HASH_RE = re.compile(r"[0-9a-f]{64}\Z")
INSTANT_RE = re.compile(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\Z")

EPOCH = datetime.datetime(1970, 1, 1)


class Refused(Exception):
    """The run stops without writing a snapshot."""


# ---------------------------------------------------------------- text

def printable(s):
    """A string safe to put in a UTF-8 file or print: no lone surrogates, each replaced by U+FFFD."""
    if WINDOWS:
        return s.encode("utf-8", "surrogatepass").decode("utf-8", "replace")
    return os.fsencode(s).decode("utf-8", "replace")


def spell(s):
    """Spell out the three characters no field may hold, as their Unicode Control Pictures."""
    return printable(s).replace("\t", chr(0x2409)).replace("\r", chr(0x240D)).replace("\n", chr(0x240A))


# Written with chr() so the source holds no bare line separator or BOM of its own.
BOM = chr(0xFEFF)
TRIMMED = "\t\v\f\r\n" + chr(0x2028) + chr(0x2029) + BOM


def _trimmed(ch):
    return ch in TRIMMED or unicodedata.category(ch) == "Zs"


def trim(s):
    """The reader's trim for leading fields (not str.strip: that also eats \\x1c-\\x1f and U+0085)."""
    a, b = 0, len(s)
    while a < b and _trimmed(s[a]):
        a += 1
    while b > a and _trimmed(s[b - 1]):
        b -= 1
    return s[a:b]


def free_text(s):
    """A people-only leading field: spelled out, and trimmed so it reads back as written."""
    return trim(spell(s))


def has_utf8_form(name):
    try:
        name.encode("utf-8", "strict")
    except UnicodeEncodeError:
        return False
    return True


def row(c1, c2="", c3="", c4="", c5=""):
    """One line in canonical form: col 1 bare, 2 padded right to 64, 3 left to 12, 4 right to 24."""
    return f"{c1}\t{c2:<64}\t{c3:>12}\t{c4:<24}\t{c5}\n"


def fmt_instant(ms):
    """Milliseconds since the epoch as YYYY-MM-DDTHH:MM:SS.sssZ; OverflowError if it can't be held."""
    secs, frac = divmod(ms, 1000)
    dt = EPOCH + datetime.timedelta(seconds=secs)
    # strftime("%Y") isn't zero-padded below year 1000 on every platform, so build it by hand.
    return (f"{dt.year:04d}-{dt.month:02d}-{dt.day:02d}T"
            f"{dt.hour:02d}:{dt.minute:02d}:{dt.second:02d}.{frac:03d}Z")


def mtime_ms(ns):
    """Round integer nanoseconds to the nearest millisecond, a tie to the later."""
    return (ns + 500_000) // 1_000_000


def readable_size(n):
    if n < 1000:
        return f"{n}B"
    for power, unit in enumerate(("kB", "MB", "GB", "TB", "PB"), start=1):
        div = 1000 ** power
        tenths = (n * 10 + div // 2) // div          # one decimal place, rounded half up
        if tenths < 10000 or unit == "PB":
            return f"{tenths // 10}.{tenths % 10}{unit}"


def duration(ms):
    secs = (ms + 500) // 1000
    if secs < 60:
        return f"{secs}s"
    if secs < 3600:
        return f"{secs // 60}m {secs % 60:02d}s"
    return f"{secs // 3600}h {secs % 3600 // 60:02d}m"


def zone_name():
    """The best name for the local time zone (free text, for people)."""
    if WINDOWS:
        try:
            import ctypes
            icu = ctypes.WinDLL("icu.dll")
            fn = icu.ucal_getDefaultTimeZone
            fn.restype = ctypes.c_int32
            fn.argtypes = [ctypes.c_wchar_p, ctypes.c_int32, ctypes.POINTER(ctypes.c_int)]
            buf = ctypes.create_unicode_buffer(128)
            status = ctypes.c_int(0)
            n = fn(buf, 128, ctypes.byref(status))
            if status.value <= 0 and 0 < n < 128:
                return buf.value
        except (OSError, AttributeError):
            pass
    else:
        tz = os.environ.get("TZ", "").lstrip(":")
        if tz and "/" in tz and not tz.startswith("/"):
            return tz
        try:
            target = os.path.realpath("/etc/localtime")
            if "zoneinfo/" in target:
                return target.split("zoneinfo/", 1)[1]
        except OSError:
            pass
        try:
            with open("/etc/timezone", encoding="utf-8") as f:
                name = f.read().strip()
                if name:
                    return name
        except OSError:
            pass
    lt = time.localtime()
    return time.tzname[1 if lt.tm_isdst > 0 else 0]


def who():
    try:
        user = getpass.getuser()
    except Exception:
        user = "unknown"
    return f"{user}@{socket.gethostname()}"


def describe_error(e):
    """An OSError as a short message, without the path (the row's last field already holds it)."""
    code = errno.errorcode.get(e.errno, "") if e.errno else ""
    win = getattr(e, "winerror", None)
    parts = [type(e).__name__ + ":"]
    if code:
        parts.append(code + ":")
    parts.append(e.strerror or str(e))
    if win:
        parts.append(f"(winerror {win})")
    return " ".join(parts)


# ---------------------------------------------------------------- paths

def to_extended(p):
    """Windows: the \\\\?\\ form of an absolute path, so it is taken exactly as written."""
    if p.startswith("\\\\?\\"):
        return p
    if p.startswith("\\\\"):
        return "\\\\?\\UNC\\" + p[2:]
    return "\\\\?\\" + p


def from_extended(p):
    """Windows: drop the \\\\?\\ prefix, and spell a drive letter in uppercase."""
    if p.startswith("\\\\?\\UNC\\"):
        return "\\\\" + p[8:]
    if p.startswith("\\\\?\\") and len(p) >= 6 and p[5] == ":" and p[4].isalpha():
        p = p[4:]
    if len(p) >= 2 and p[1] == ":" and p[0].isalpha():
        p = p[0].upper() + p[1:]
    return p


def absolute(arg):
    """An absolute path for a command-line directory, without abspath (which drops a trailing dot)."""
    if WINDOWS:
        drive, rest = os.path.splitdrive(arg)
        if drive and not rest.startswith(("\\", "/")) and not drive.startswith(("\\\\", "//")):
            # drive-relative "D:foo": relative to that drive's own current directory
            arg = os.path.join(os.path.abspath(drive), rest)
        elif not os.path.isabs(arg) or not drive:
            arg = os.path.join(os.getcwd(), arg)
        return os.path.normpath(arg)
    # On POSIX `..` must be resolved after links, so leave it to realpath.
    return arg if os.path.isabs(arg) else os.path.join(os.getcwd(), arg)


def ondisk_case(path):
    """POSIX: realpath keeps the case as typed where a directory ignores case; ask each parent."""
    out = "/"
    for name in path.split("/"):
        if not name:
            continue
        try:
            names = os.listdir(out)
        except OSError:
            names = []
        if name not in names:
            try:
                key = unicodedata.normalize("NFD", name).casefold()
                matches = [n for n in names if unicodedata.normalize("NFD", n).casefold() == key]
            except (TypeError, ValueError):
                matches = []
            if len(matches) == 1:
                name = matches[0]
        out = os.path.join(out, name)
    return out


def io_path(p):
    """The path to hand the operating system for a display path."""
    return to_extended(p) if WINDOWS else p


def display_real(resolved):
    """A realpath() result as it is recorded: plain, on-disk case, no trailing separator."""
    if WINDOWS:
        p = from_extended(resolved)
    else:
        # A reader takes a path starting // for a Windows share; here //x is /x.
        p = ondisk_case("/" + resolved.lstrip("/"))
    if len(p) > 1 and p.endswith(SEP) and not (WINDOWS and re.fullmatch(r"[A-Z]:\\", p)):
        p = p.rstrip(SEP)
    return p


def segments(p):
    """A recorded path's segments; a Windows path splits on both separators."""
    if WINDOWS:
        return [s for s in re.split(r"[\\/]", p)]
    return p.split("/")


def _stripped(p):
    if WINDOWS:
        return p.rstrip("\\/") if not re.fullmatch(r"[A-Za-z]:[\\/]*", p) else p[:2]
    return p.rstrip("/")


def within(path, root):
    """True when `path` is `root` or lies under it, compared by whole segments."""
    a, b = segments(_stripped(path)), segments(_stripped(root))
    if b == [""]:                      # POSIX root "/"
        return True
    return a[:len(b)] == b


def as_dir(p):
    """A directory's recorded form: always ending in a separator."""
    return p if p.endswith(SEP) else p + SEP


def is_link(st):
    if WINDOWS:
        return getattr(st, "st_reparse_tag", 0) in (IO_REPARSE_TAG_SYMLINK, IO_REPARSE_TAG_MOUNT_POINT)
    return stat.S_ISLNK(st.st_mode)


def is_broken(e):
    """Following a link failed because nothing is there (as opposed to somewhere unresolvable)."""
    if WINDOWS:
        return getattr(e, "winerror", None) in (2, 3, 1921)
    return e.errno in (errno.ENOENT, errno.ENOTDIR, errno.ELOOP)


def is_vanished(e):
    if WINDOWS:
        return getattr(e, "winerror", None) in (2, 3)
    return e.errno in (errno.ENOENT, errno.ENOTDIR)


def bad_name(name):
    """Why a name can't be backed up, or None."""
    if not has_utf8_form(name):
        return "a name with no UTF-8 form"
    if any(c in name for c in "\t\r\n"):
        return "a name holding a tab, CR or LF"
    return None


# ---------------------------------------------------------------- the walk

class FileEntry:
    __slots__ = ("path", "io")

    def __init__(self, path, io_):
        self.path, self.io = path, io_


class Walk:
    def __init__(self, members, state_real):
        self.members = members          # recorded real paths, no trailing separator
        self.state_real = state_real    # this program's own working folder, or None
        self.files = []                 # FileEntry, in listing order
        self.errors = []                # (message, path) for the #error block near the top
        self.fatal = []                 # reasons the run must stop

    def run(self):
        for m in self.members:
            self._walk_member(m)

    def _walk_member(self, member):
        stack = [(io_path(member), member, True)]
        while stack:
            dir_io, dir_disp, is_top = stack.pop()
            try:
                with os.scandir(dir_io) as it:
                    listing = list(it)
            except OSError as e:
                if not is_top and is_vanished(e):
                    continue
                self.fatal.append(f"directory can't be listed: {printable(as_dir(dir_disp))}: {describe_error(e)}")
                continue
            subdirs = []
            for entry in listing:
                child = self._entry(entry, dir_disp)
                if child is not None:
                    subdirs.append(child)
            # depth-first, in listing order
            stack.extend(reversed(subdirs))

    def _entry(self, entry, dir_disp):
        name = entry.name
        disp = (dir_disp.rstrip(SEP) if dir_disp != SEP else "") + SEP + name
        why = bad_name(name)
        if why:
            self.fatal.append(f"{why}: {printable(disp)}")
            return None
        try:
            st = os.lstat(entry.path)
        except OSError as e:
            if is_vanished(e):
                return None
            self.errors.append((f"type couldn't be determined: {describe_error(e)}", disp))
            return None
        if is_link(st):
            self._link(entry.path, disp)
            return None
        if stat.S_ISDIR(st.st_mode):
            if self.state_real is not None and segments(disp) == segments(self.state_real):
                return None             # our own working folder: no row
            return (entry.path, disp, False)
        if stat.S_ISREG(st.st_mode):
            self.files.append(FileEntry(disp, entry.path))
        # pipes, sockets and devices get no row
        return None

    def _link(self, link_io, disp):
        try:
            target = os.path.realpath(link_io, strict=True)
            tst = os.stat(target)
        except OSError as e:
            if is_broken(e):
                return                  # broken: no row
            try:
                literal = os.readlink(link_io)
            except OSError:
                literal = "?"
            self.errors.append((f"link target couldn't be resolved: {describe_error(e)}: "
                                f"{from_extended(literal) if WINDOWS else literal}", disp))
            return
        if stat.S_ISDIR(tst.st_mode):
            is_dir = True
        elif stat.S_ISREG(tst.st_mode):
            is_dir = False
        else:
            return                      # to a pipe, socket or device: no row
        real = display_real(target)
        own = self.state_real is not None and within(real, self.state_real)
        if not own and any(within(real, m) for m in self.members):
            return                      # into the backup: recorded where it lies
        kind = "folder" if is_dir else "file"
        shown = as_dir(real) if is_dir else real
        self.errors.append((f"link to a {kind} outside the backup: {shown}", as_dir(disp) if is_dir else disp))


# ---------------------------------------------------------------- reading a file

class Changed(Exception):
    pass


def read_file(io_):
    """Read and hash a file. Returns (hex, size, mtime_ns, data-or-None)."""
    with open(io_, "rb") as f:
        st1 = os.fstat(f.fileno())
        h = hashlib.sha256()
        if st1.st_size <= SINGLE_PUT_MAX:
            data = f.read()
            if len(data) > SINGLE_PUT_MAX:
                raise Changed("grew while being read")
            h.update(data)
            size = len(data)
        else:
            data = None
            size = 0
            while True:
                chunk = f.read(READ_CHUNK)
                if not chunk:
                    break
                h.update(chunk)
                size += len(chunk)
        st2 = os.fstat(f.fileno())
    if (st1.st_size, st1.st_mtime_ns) != (st2.st_size, st2.st_mtime_ns) or size != st2.st_size:
        raise Changed("changed while being read")
    return h.hexdigest(), size, st2.st_mtime_ns, data


# ---------------------------------------------------------------- the bucket

class Bucket:
    def __init__(self, name):
        self.name = name
        self.s3 = boto3.client("s3", config=Config(retries={"mode": "standard", "max_attempts": 8},
                                                   connect_timeout=30, read_timeout=120))
        # boto3 before 1.35 has no IfNoneMatch parameter: send the header from an event handler.
        self._inm_param = {}
        for op in ("PutObject", "CompleteMultipartUpload"):
            members = self.s3.meta.service_model.operation_model(op).input_shape.members
            self._inm_param[op] = "IfNoneMatch" in members
        if not all(self._inm_param.values()):
            self.s3.meta.events.register("before-call.s3.PutObject", self._add_inm)
            self.s3.meta.events.register("before-call.s3.CompleteMultipartUpload", self._add_inm)
        self.stored = set()             # hashes confirmed under objects/ during this run
        self.uploaded = 0
        self.uploaded_bytes = 0

    @staticmethod
    def _add_inm(params, **_):
        params["headers"]["If-None-Match"] = "*"

    def _inm(self, op):
        return {"IfNoneMatch": "*"} if self._inm_param[op] else {}

    @staticmethod
    def _status(e):
        return e.response.get("ResponseMetadata", {}).get("HTTPStatusCode")

    def exists(self, key):
        try:
            self.s3.head_object(Bucket=self.name, Key=key)
            return True
        except ClientError as e:
            if self._status(e) == 404:
                return False
            raise

    def get(self, key):
        """The object's bytes, or None on a 404."""
        try:
            return self.s3.get_object(Bucket=self.name, Key=key)["Body"].read()
        except ClientError as e:
            if self._status(e) == 404:
                return None
            raise

    def put_new(self, key, data):
        """PUT only if absent, S3 checking the bytes against their SHA-256. False if the key exists."""
        b64 = base64.b64encode(hashlib.sha256(data).digest()).decode("ascii")
        try:
            self.s3.put_object(Bucket=self.name, Key=key, Body=data, ChecksumSHA256=b64,
                               **self._inm("PutObject"))
            return True
        except ClientError as e:
            if self._status(e) == 412:
                return False
            raise

    def any_under(self, prefix):
        r = self.s3.list_objects_v2(Bucket=self.name, Prefix=prefix, MaxKeys=1)
        return r.get("KeyCount", 0) > 0

    def store_object(self, hexhash, data, io_, size):
        """Make sure objects/<hexhash> holds the bytes that hash to it.

        `data` is the buffer that was hashed (small files), or None to send the file in parts,
        hashing exactly what is sent. Returns False when the file no longer hashes to the key.
        """
        if hexhash in self.stored:
            return True
        key = "objects/" + hexhash
        if self.exists(key):
            self.stored.add(hexhash)
            return True
        if data is not None:
            if hashlib.sha256(data).hexdigest() != hexhash:
                return False
            if self.put_new(key, data):
                self.uploaded += 1
                self.uploaded_bytes += len(data)
            self.stored.add(hexhash)
            return True
        ok = self._multipart(key, hexhash, io_, size)
        if ok:
            self.stored.add(hexhash)
        return ok

    def _multipart(self, key, hexhash, io_, size):
        part_size = max(PART_SIZE, -(-size // MAX_PARTS))
        upload_id = self.s3.create_multipart_upload(Bucket=self.name, Key=key,
                                                    ChecksumAlgorithm="SHA256")["UploadId"]
        completed = False
        try:
            whole = hashlib.sha256()
            parts = []
            sent = 0
            with open(io_, "rb") as f:
                while True:
                    chunk = f.read(part_size)
                    if not chunk:
                        break
                    whole.update(chunk)
                    sent += len(chunk)
                    b64 = base64.b64encode(hashlib.sha256(chunk).digest()).decode("ascii")
                    n = len(parts) + 1
                    r = self.s3.upload_part(Bucket=self.name, Key=key, UploadId=upload_id, PartNumber=n,
                                            Body=chunk, ChecksumSHA256=b64)
                    parts.append({"PartNumber": n, "ETag": r["ETag"], "ChecksumSHA256": b64})
            if whole.hexdigest() != hexhash or sent != size:
                return False            # the finally clause aborts: nothing is stored
            try:
                self.s3.complete_multipart_upload(Bucket=self.name, Key=key, UploadId=upload_id,
                                                  MultipartUpload={"Parts": parts},
                                                  **self._inm("CompleteMultipartUpload"))
                completed = True
                self.uploaded += 1
                self.uploaded_bytes += sent
            except ClientError as e:
                if self._status(e) != 412:
                    raise
            return True
        finally:
            if not completed:
                try:
                    self.s3.abort_multipart_upload(Bucket=self.name, Key=key, UploadId=upload_id)
                except ClientError:
                    pass


# ---------------------------------------------------------------- the holder

def parse_info(data):
    """A .info file as {key: [values]}: UTF-8, split on LF, one trailing CR stripped, first '='."""
    text = data.decode("utf-8")
    if text.startswith(BOM):
        text = text[1:]
    out = {}
    for line in text.split("\n"):
        if line.endswith("\r"):
            line = line[:-1]
        if "=" not in line:
            continue
        k, v = line.split("=", 1)
        out.setdefault(k, []).append(v)
    return out


def claim_path(bucket, set_name):
    return os.path.join(STATE_DIR, bucket, set_name + ".claim")


def load_claim(bucket, set_name):
    try:
        with open(claim_path(bucket, set_name), "rb") as f:
            d = parse_info(f.read())
    except FileNotFoundError:
        return None
    if len(d.get("OWNER", [])) == 1 and len(d.get("CLAIMED", [])) == 1:
        return d["OWNER"][0], d["CLAIMED"][0]
    return None


def save_claim(bucket, set_name, owner, claimed):
    path = claim_path(bucket, set_name)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".new"
    with open(tmp, "wb") as f:
        f.write(f"OWNER={owner}\nCLAIMED={claimed}\n".encode("utf-8"))
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)


def info_pair(bucket, set_name):
    """(OWNER, CLAIMED) from the bucket's .info, None if there is none."""
    data = bucket.get(f"snapshots/{set_name}.info")
    if data is None:
        return None
    try:
        d = parse_info(data)
    except UnicodeDecodeError:
        raise Refused(f"snapshots/{set_name}.info isn't UTF-8; can't tell who holds the set")
    owners, claims = set(d.get("OWNER", [])), set(d.get("CLAIMED", []))
    if len(owners) != 1 or len(claims) != 1:
        raise Refused(f"snapshots/{set_name}.info doesn't name exactly one OWNER and one CLAIMED")
    return owners.pop(), claims.pop()


def hold_or_claim(bucket, set_name):
    """Make sure this program holds the set, claiming it if it is new. Returns the kept pair."""
    kept = load_claim(bucket.name, set_name)
    current = info_pair(bucket, set_name)
    if current is not None:
        if kept == current:
            return kept
        raise Refused(f"set {set_name!r} is held by {current[0]} (claimed {current[1]}), "
                      f"and this program holds no matching claim; taking a set over isn't offered")
    if bucket.any_under(f"snapshots/{set_name}/"):
        raise Refused(f"set {set_name!r} already has snapshots but no snapshots/{set_name}.info; "
                      f"taking it over isn't offered")
    owner = spell(who())
    claimed = fmt_instant(time.time_ns() // 1_000_000)
    # Keep the pair before it can be published: a published claim we didn't keep would lock us out.
    save_claim(bucket.name, set_name, owner, claimed)
    body = f"OWNER={owner}\nCLAIMED={claimed}\nCREATED={claimed}\n".encode("utf-8")
    if not bucket.put_new(f"snapshots/{set_name}.info", body):
        raise Refused(f"another writer claimed set {set_name!r} first")
    print(f"claimed set {set_name!r} as {owner} at {claimed}", flush=True)
    return owner, claimed


# ---------------------------------------------------------------- checking a snapshot as a reader would

def _path_kind(p):
    """Which separators count depends on the path, not the machine reading it."""
    return "windows" if re.match(r"[A-Za-z]:[\\/]|[\\/]{2}", p) else "posix"


def _seps(p):
    return "\\/" if _path_kind(p) == "windows" else "/"


def _segs_past_root(p):
    """(root, segments) of an absolute path, or None if it isn't absolute."""
    if _path_kind(p) == "windows":
        if re.match(r"[A-Za-z]:[\\/]", p):
            return p[:3], re.split(r"[\\/]", p[3:])
        return p[:2], re.split(r"[\\/]", p[2:])
    if p.startswith("/"):
        return "/", p[1:].split("/")
    return None


def _dir_key(p):
    """A @SET DIR or path as segments for matching: Windows paths lowercased."""
    sp = _segs_past_root(p)
    root, segs = sp
    if _path_kind(p) == "windows":
        return [root.lower()[:2]] + [s.lower() for s in segs]
    return [root] + segs


def check_snapshot(text):
    """Every rule a reader holds a snapshot to, plus canonical form. Returns a list of problems."""
    problems = []
    if not text.endswith("\n"):
        return ["doesn't end with LF"]
    lines = text[:-1].split("\n")
    if lines[-1] != ".":
        return ["last line isn't ."]
    if "." in lines[:-1]:
        problems.append("a . before the end")
    lines = lines[:-1]
    first = lines[0].split("\t")
    if len(first) != 5 or tuple(trim(f) for f in first[:4]) + (first[4],) != HEADING:
        problems.append("first line isn't the heading row")
    counts = {}
    dirs, per_path, files = [], [], []
    for i, line in enumerate(lines, 1):
        if "\r" in line:
            problems.append(f"line {i} holds a CR")
        f = line.split("\t")
        if len(f) != 5:
            problems.append(f"line {i} has {len(f)} fields")
            continue
        t, c2, c3, c4 = (trim(x) for x in f[:4])
        last = f[4]
        if row(t, c2, c3, c4, last) != line + "\n":
            problems.append(f"line {i} isn't in canonical form")
        if i == 1:
            continue
        if t == "-":
            if not HASH_RE.match(c2) or not re.fullmatch(r"\d+", c3) or not INSTANT_RE.match(c4):
                problems.append(f"line {i}: malformed file row")
            files.append((i, last))
            per_path.append((i, last, False))
        elif t in ("#excluded", "#error"):
            per_path.append((i, last, last.endswith(tuple(_seps(last)))))
        elif t.startswith(("@", "#")):
            counts[(t, c2)] = counts.get((t, c2), 0) + 1
            if (t, c2) == ("@SET", "DIR"):
                dirs.append(last)
        else:
            problems.append(f"line {i}: unknown type {t!r}")
    for k in (("@S3CAB", "SPEC"), ("@CLIENT", "NAME"), ("@CLIENT", "VERSION")):
        if counts.get(k) != 1:
            problems.append(f"{k[0]} {k[1]} appears {counts.get(k, 0)} times")
    dir_keys = []
    for d in dirs:
        if _segs_past_root(d) is None:
            problems.append(f"@SET DIR not absolute: {d!r}")
            continue
        k = _dir_key(d)
        while len(k) > 1 and k[-1] == "":   # ignore the separators a DIR ends with
            k.pop()
        dir_keys.append(k)
    seen = {}
    for i, p, is_dir in per_path:
        if any(c in p for c in "\t\r\n"):
            problems.append(f"line {i}: path holds a tab, CR or LF")
        q = p[:-1] if is_dir else p
        sp = _segs_past_root(q)
        if sp is None:
            problems.append(f"line {i}: path not absolute")
            continue
        if any(s in ("", ".", "..") for s in sp[1]):
            problems.append(f"line {i}: path has an empty, . or .. segment")
        k = _dir_key(q)
        if k in dir_keys:
            problems.append(f"line {i}: path is a @SET DIR itself")
        elif not any(len(k) > len(dk) and k[:len(dk)] == dk for dk in dir_keys):
            problems.append(f"line {i}: path under no @SET DIR")
        if q in seen:
            problems.append(f"line {i}: path also in line {seen[q]}")
        seen[q] = i
    file_set = {p for _, p in files}
    for i, p in files:
        root, segs = _segs_past_root(p) or ("", [])
        sep = "\\" if _path_kind(p) == "windows" else "/"
        for n in range(1, len(segs)):
            if root + sep.join(segs[:n]) in file_set:
                problems.append(f"line {i}: path runs through another file row")
    return problems


# ---------------------------------------------------------------- the run

def resolve_members(args):
    members = []
    for arg in args:
        why = bad_name(arg)
        if why:
            raise Refused(f"member directory is {why}: {printable(arg)}")
        try:
            resolved = os.path.realpath(io_path(absolute(arg)), strict=True)
            st = os.stat(resolved)
        except OSError as e:
            raise Refused(f"member directory can't be resolved: {printable(arg)}: {describe_error(e)}")
        if not stat.S_ISDIR(st.st_mode):
            raise Refused(f"member directory isn't a directory: {printable(arg)}")
        real = display_real(resolved)
        why = bad_name(real)
        if why:
            raise Refused(f"member directory's real path is {why}: {printable(real)}")
        members.append(real)
    for i, a in enumerate(members):
        for b in members[i + 1:]:
            if within(a, b) or within(b, a):
                raise Refused(f"member directories {as_dir(a)} and {as_dir(b)} overlap, "
                              f"so the same files would turn up under both")
    return members


def state_real_path():
    try:
        return display_real(os.path.realpath(io_path(STATE_DIR), strict=True))
    except OSError:
        return None


def backup(bucket_name, set_name, dir_args):
    # One clock reading names the snapshot and gives START, each cut down rather than rounded.
    start_ns = time.time_ns()
    start_ms = start_ns // 1_000_000
    lt = time.localtime(start_ns // 1_000_000_000)
    snap_name = f"{lt.tm_year:04d}-{lt.tm_mon:02d}-{lt.tm_mday:02d}T{lt.tm_hour:02d}{lt.tm_min:02d}"
    zone = zone_name()

    if not SET_NAME_RE.match(set_name):
        raise Refused(f"a set's name is lowercase letters, digits and hyphens: {set_name!r}")
    members = resolve_members(dir_args)

    bucket = Bucket(bucket_name)
    pair = hold_or_claim(bucket, set_name)

    snap_key = f"snapshots/{set_name}/{snap_name}.tsv.gz"
    local_copy = os.path.join(STATE_DIR, bucket_name, set_name, snap_name + ".tsv.gz")
    if os.path.exists(local_copy) or bucket.exists(snap_key):
        raise Refused(f"set {set_name!r} already has a snapshot named {snap_name}; "
                      f"a second snapshot in the same minute is refused")

    walk = Walk(members, state_real_path())
    walk.run()
    if walk.fatal:
        for reason in walk.fatal:
            print(f"refused: {reason}", file=sys.stderr)
        raise Refused(f"{len(walk.fatal)} entr{'y' if len(walk.fatal) == 1 else 'ies'} can't be backed up "
                      f"(listed above); no object or snapshot was uploaded")

    # Objects first: every file's content stored under its hash before the snapshot exists.
    body = []                           # file rows, with #error rows for files that failed being read
    n_files = total = 0
    for fe in walk.files:
        entry_row = None
        for attempt in range(READ_ATTEMPTS):
            try:
                hexhash, size, mt_ns, data = read_file(fe.io)
            except Changed as e:
                entry_row = row("#error", free_text(f"file {e}"), c5=fe.path)
                continue
            except OSError as e:
                if is_vanished(e):
                    try:
                        os.lstat(fe.io)
                    except OSError:
                        entry_row = ""  # vanished between being listed and read: no row
                        break
                entry_row = row("#error", free_text(f"file couldn't be read: {describe_error(e)}"), c5=fe.path)
                break
            try:
                when = fmt_instant(mtime_ms(mt_ns))
            except OverflowError:
                entry_row = row("#error", "modification time out of range for YYYY-MM-DDTHH:MM:SS.sssZ",
                                c5=fe.path)
                break
            if not bucket.store_object(hexhash, data, fe.io, size):
                entry_row = row("#error", "file changed while being uploaded", c5=fe.path)
                continue
            entry_row = row("-", hexhash, str(size), when, fe.path)
            n_files += 1
            total += size
            break
        if entry_row:
            body.append(entry_row)

    finish_ns = time.time_ns()
    finish_ms = -(-finish_ns // 1_000_000)  # rounded up: nothing in the file is later than this

    lines = [row(*HEADING),
             row("@S3CAB", "SPEC", c5=SPEC_DATE),
             row("@CLIENT", "NAME", c5=CLIENT_NAME),
             row("@CLIENT", "VERSION", c5=CLIENT_VERSION),
             row("@SET", "NAME", c5=set_name),
             row("@SET", "BUCKET", c5="s3://" + bucket_name)]
    lines += [row("@SET", "DIR", c5=as_dir(m)) for m in members]
    lines += [row("@SNAPSHOT", "NAME", c5=snap_name),
              row("@SNAPSHOT", "BY", c5=spell(who())),
              row("@SNAPSHOT", "START", c4=fmt_instant(start_ms), c5=spell(zone))]
    lines += [row("#error", free_text(msg), c5=path) for msg, path in walk.errors]
    lines += body
    lines += [row("@SNAPSHOT", "FILES", c5=str(n_files)),
              row("@SNAPSHOT", "SIZE", c5=f"{total} ({readable_size(total)})"),
              row("@SNAPSHOT", "FINISH", c4=fmt_instant(finish_ms), c5=duration(finish_ms - start_ms)),
              ".\n"]
    text = "".join(lines)

    problems = check_snapshot(text)
    hashes = {ln.split("\t")[1].strip() for ln in body if ln.startswith("-\t")}
    if not hashes <= bucket.stored:
        problems.append("a file row names an object not confirmed stored")
    if problems:
        raise Refused("the snapshot fails its own reader's check: " + "; ".join(problems[:10]))

    raw = text.encode("utf-8")
    buf = io.BytesIO()
    with gzip.GzipFile(filename="", mode="wb", fileobj=buf, mtime=0, compresslevel=9) as gz:
        gz.write(raw)
    blob = buf.getvalue()
    if gzip.decompress(blob) != raw:
        raise Refused("the compressed snapshot doesn't decompress to its text")

    # The local copy: created exclusively, so it can never overwrite one (os.rename would on POSIX).
    os.makedirs(os.path.dirname(local_copy), exist_ok=True)
    try:
        with open(local_copy, "xb") as f:
            f.write(blob)
            f.flush()
            os.fsync(f.fileno())
    except FileExistsError:
        raise Refused(f"a local snapshot {snap_name} of set {set_name!r} already exists")

    # The holder, checked immediately before the snapshot goes up.
    if info_pair(bucket, set_name) != pair:
        raise Refused(f"set {set_name!r} is no longer held by this program; snapshot kept locally at "
                      f"{printable(local_copy)}, not uploaded")
    if not bucket.put_new(snap_key, blob):
        if bucket.get(snap_key) != blob:
            raise Refused(f"{snap_key} already exists with different bytes; refused")

    n_err = len(walk.errors) + sum(1 for ln in body if ln.startswith("#error\t"))
    print(f"{snap_key}: {n_files} files, {total} bytes ({readable_size(total)}); "
          f"{bucket.uploaded} objects uploaded ({bucket.uploaded_bytes} bytes), "
          f"{len(bucket.stored) - bucket.uploaded} already stored; {n_err} #error rows")
    for ln in lines:
        if ln.startswith("#error\t"):
            f = ln.rstrip("\n").split("\t")
            print(f"  #error {trim(f[1])}: {f[4]}", file=sys.stderr)
    return 1 if n_err else 0


def main(argv):
    for s in (sys.stdout, sys.stderr):
        try:
            s.reconfigure(errors="backslashreplace")   # a path must never crash a print
        except AttributeError:
            pass
    if len(argv) < 4:
        print("usage: python s3cab-backup.py <bucket> <set> <dir>...", file=sys.stderr)
        return 2
    bucket_name, set_name, dirs = argv[1], argv[2], argv[3:]
    if bucket_name.startswith("s3://"):
        bucket_name = bucket_name[5:].rstrip("/")
    try:
        return backup(bucket_name, set_name, dirs)
    except Refused as e:
        print(f"s3cab-backup: {e}", file=sys.stderr)
        return 2
    except (ClientError, BotoCoreError, OSError) as e:
        # Exit 1 means "written, with #error rows"; anything unexpected must not look like that.
        print(f"s3cab-backup: failed before the snapshot was confirmed uploaded: "
              f"{type(e).__name__}: {printable(str(e))}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv))
