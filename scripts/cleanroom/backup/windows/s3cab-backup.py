#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
s3cab-backup.py -- write one backup of a set into an s3cab repository, from the format spec alone.

    python s3cab-backup.py <bucket> <set> <dir>...

Standard library + boto3 only.  Runs unchanged on Linux, macOS and Windows.

What the program keeps between runs lives beside this file, under s3cab-backup.local/:
  holder.json                    the OWNER/CLAIMED pair the spec says a writer must keep per set
  snapshots/<set>/<name>.tsv.gz  a byte-identical local copy of every snapshot it uploaded

Exit status: 0 backup complete; 1 the run stopped without a snapshot, or a snapshot was written
that holds an #error row; 2 bad command line.
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
import unicodedata
from decimal import Decimal, ROUND_HALF_UP

import boto3
import botocore
from botocore.config import Config
from botocore.exceptions import ClientError

CLIENT_NAME = "cleanroom-backup"
CLIENT_VERSION = "0.1.0"
SPEC_DATE = "2026-10-23"
FORMAT_URL = "https://s3cab.plantegral.com/guide/format"

WINDOWS = os.name == "nt"
LONG = "\\\\?\\"                       # the Windows prefix that makes a path be taken as written
IO_REPARSE_TAG_MOUNT_POINT = 0xA0000003  # a junction
SNAPSHOT_FILE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{4}\.tsv\.gz$")
SET_NAME_RE = re.compile(r"^[a-z0-9]+(-[a-z0-9]+)*$")
HEX64_RE = re.compile(r"^[0-9a-f]{64}$")
CHUNK = 1 << 20

LOCAL_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "s3cab-backup.local")
HOLDER_FILE = os.path.join(LOCAL_DIR, "holder.json")


class Stop(Exception):
    """The run stops here, without writing a snapshot."""


# ----------------------------------------------------------------------------------------------
# Text helpers
# ----------------------------------------------------------------------------------------------

def spell(s):
    """Spell a tab, CR or LF out as the Unicode Control Pictures, for every field but a file row's path."""
    return s.replace("\t", "\u2409").replace("\r", "\u240d").replace("\n", "\u240a")


def display(s):
    """A name for a message: parts with no UTF-8 form shown as U+FFFD, the way the spec describes."""
    if WINDOWS:
        return s.encode("utf-8", "surrogatepass").decode("utf-8", "replace")
    try:
        return os.fsencode(s).decode("utf-8", "replace")
    except (UnicodeError, ValueError):
        return s.encode("utf-8", "replace").decode("utf-8")


def has_utf8_form(s):
    try:
        s.encode("utf-8")
        return True
    except UnicodeEncodeError:
        return False


def row(c1, c2, c3, c4, c5):
    """One canonical line: column 1 unpadded, 2 right-padded to 64, 3 left-padded to 12, 4 right-padded to 24, 5 verbatim."""
    return f"{c1}\t{c2.ljust(64)}\t{c3.rjust(12)}\t{c4.ljust(24)}\t{c5}\n"


def readable_size(n):
    """The readable form in @SNAPSHOT SIZE: 0B..999B, then one decimal in the smallest unit under 1000.0, or PB."""
    if n < 1000:
        return f"{n}B"
    for i, unit in enumerate(("kB", "MB", "GB", "TB", "PB"), start=1):
        v = (Decimal(n) / (Decimal(1000) ** i)).quantize(Decimal("0.1"), rounding=ROUND_HALF_UP)
        if v < 1000 or unit == "PB":
            return f"{v}{unit}"


def duration_text(ms):
    """Free text for FINISH's last column, in the spirit of the spec's examples (9s, 12m 21s, 3h 04m)."""
    s = max(0, ms) // 1000
    if s < 60:
        return f"{s}s"
    m, s = divmod(s, 60)
    if m < 60:
        return f"{m}m {s:02d}s"
    h, m = divmod(m, 60)
    return f"{h}h {m:02d}m"


# ----------------------------------------------------------------------------------------------
# Instants
# ----------------------------------------------------------------------------------------------

def round_to_ms(ns):
    """Nearest millisecond, a tie to the later one (floor of ns + half a millisecond)."""
    return (ns + 500_000) // 1_000_000


def civil_from_days(z):
    """Days since 1970-01-01 -> (year, month, day) in the proleptic Gregorian calendar, any year."""
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


def instant(ms):
    """Milliseconds since the epoch -> the 24-character form, or None when the year is outside 0000..9999."""
    secs, frac = divmod(ms, 1000)
    days, sod = divmod(secs, 86400)
    y, mo, d = civil_from_days(days)
    if not 0 <= y <= 9999:
        return None
    hh, rem = divmod(sod, 3600)
    mi, ss = divmod(rem, 60)
    return f"{y:04d}-{mo:02d}-{d:02d}T{hh:02d}:{mi:02d}:{ss:02d}.{frac:03d}Z"


def zone_name():
    """The best name we have for the local zone: IANA where the system can tell us, else what the C library says."""
    tz = os.environ.get("TZ")
    if tz and "/" in tz and not tz.startswith(":"):
        return tz
    if WINDOWS:
        try:
            icu = ctypes.WinDLL("icu")
            fn = icu.ucal_getDefaultTimeZone
            fn.restype = ctypes.c_int32
            fn.argtypes = [ctypes.c_void_p, ctypes.c_int32, ctypes.POINTER(ctypes.c_int32)]
            buf = ctypes.create_unicode_buffer(256)
            status = ctypes.c_int32(0)
            n = fn(buf, 256, ctypes.byref(status))
            if status.value <= 0 and 0 < n < 256 and buf.value:
                return buf.value
        except (OSError, AttributeError):
            pass
    else:
        try:
            target = os.readlink("/etc/localtime")
            i = target.find("zoneinfo/")
            if i >= 0:
                return target[i + len("zoneinfo/"):]
        except OSError:
            pass
        try:
            with open("/etc/timezone", "r", encoding="utf-8") as f:
                name = f.read().strip()
            if name:
                return name
        except OSError:
            pass
    lt = time.localtime()
    name = time.tzname[1 if lt.tm_isdst > 0 else 0]
    off = lt.tm_gmtoff
    sign = "+" if off >= 0 else "-"
    off = abs(off)
    return f"{name or 'local'} (UTC{sign}{off // 3600:02d}:{off % 3600 // 60:02d})"


def user_at_machine():
    try:
        user = getpass.getuser()
    except Exception:
        user = os.environ.get("USER") or os.environ.get("USERNAME") or "unknown"
    try:
        host = socket.gethostname()
    except Exception:
        host = "unknown"
    return f"{user}@{host}"


# ----------------------------------------------------------------------------------------------
# Paths
# ----------------------------------------------------------------------------------------------

def os_path(p):
    r"""The spelling handed to the operating system: on Windows, through \\?\ so a name is taken exactly as written."""
    if not WINDOWS or p.startswith(LONG):
        return p
    if p.startswith("\\\\"):
        return LONG + "UNC\\" + p[2:]
    return LONG + p


def record_path(p):
    r"""The spelling a snapshot records: no \\?\ prefix, \\?\UNC\ back to \\, and an uppercase drive letter."""
    if WINDOWS:
        if p.startswith(LONG + "UNC\\"):
            p = "\\\\" + p[len(LONG) + 4:]
        elif p.startswith(LONG):
            p = p[len(LONG):]
        if len(p) >= 2 and p[1] == ":" and p[0].isascii() and p[0].isalpha():
            p = p[0].upper() + p[1:]
    return p


def is_windows_path(p):
    return (len(p) >= 3 and p[0].isascii() and p[0].isalpha() and p[1] == ":" and p[2] in "\\/") or \
           (len(p) >= 2 and p[0] in "\\/" and p[1] in "\\/")


def compare_key(p):
    """(root, segments) for whole-segment comparison; case ignored on a Windows path by Python's full lower mapping."""
    if is_windows_path(p):
        if p[1] == ":":
            root, rest = p[:2].upper(), p[3:]
        else:
            root, rest = "\\\\", p[2:]
        segs = [s.lower() for s in re.split(r"[\\/]", rest) if s != ""]
        return root, segs
    return "/", [s for s in p.split("/") if s != ""]


def is_or_inside(path, directory):
    """True when path is directory itself or lies inside it, compared by whole segments."""
    r1, s1 = compare_key(path)
    r2, s2 = compare_key(directory)
    return r1 == r2 and s1[:len(s2)] == s2


def join_name(directory, name):
    return directory + name if directory.endswith(os.sep) else directory + os.sep + name


def with_trailing_sep(p):
    return p if p.endswith(os.sep) else p + os.sep


def fix_case_from_listings(p):
    """On a case-insensitive POSIX filesystem realpath keeps the case as typed; take each name from its parent's listing."""
    def key(s):
        return unicodedata.normalize("NFD", s).casefold()
    parts = [s for s in p.split("/") if s]
    out = "/"
    for part in parts:
        try:
            names = os.listdir(out)
        except OSError:
            return p                                      # can't ask the parent: keep what realpath gave
        if part not in names:
            matches = [n for n in names if key(n) == key(part)]
            if len(matches) == 1:
                part = matches[0]
        out = os.path.join(out, part)
    return out


def resolve_member(arg):
    """A member directory as its real path: every link, short name and letter case resolved."""
    p = os.path.normpath(os.path.join(os.getcwd(), arg))
    try:
        real = os.path.realpath(os_path(p), strict=True)
    except OSError as e:
        raise Stop(f"member directory {display(arg)!r} doesn't exist or can't be resolved: {e.strerror or e}")
    try:
        st = os.stat(real)
    except OSError as e:
        raise Stop(f"member directory {display(arg)!r} can't be checked: {e.strerror or e}")
    if not stat.S_ISDIR(st.st_mode):
        raise Stop(f"member directory {display(arg)!r} isn't a directory")
    rp = record_path(real)
    if not WINDOWS:
        rp = fix_case_from_listings(rp)
    if not has_utf8_form(rp):
        raise Stop(f"member directory {display(rp)!r} has a name with no UTF-8 form")
    return with_trailing_sep(rp)


def link_target_text(path):
    try:
        t = os.readlink(os_path(path))
    except OSError:
        return "(target unreadable)"
    if WINDOWS:
        if t.startswith(LONG + "UNC\\"):
            t = "\\\\" + t[len(LONG) + 4:]
        elif t.startswith(LONG):
            t = t[len(LONG):]
    return t


def link_is_broken(ex):
    w = getattr(ex, "winerror", None)
    if w is not None:
        return w in (2, 3, 1921)
    return ex.errno in (errno.ENOENT, errno.ENOTDIR, errno.ELOOP)


# ----------------------------------------------------------------------------------------------
# Walking
# ----------------------------------------------------------------------------------------------

class Walk:
    """Lists every member directory without following links; collects the files to hash and the rows for links."""

    def __init__(self, members):
        self.members = members          # real paths ending with a separator
        self.files = []                 # paths of regular files, in listing order
        self.link_errors = []           # (message, path) -> #error rows near the top

    def run(self):
        for m in self.members:
            top = m if len(compare_key(m)[1]) == 0 else m.rstrip(os.sep)
            self.walk(top)

    def walk(self, directory):
        try:
            with os.scandir(os_path(directory)) as it:
                entries = list(it)
        except OSError as e:
            raise Stop(f"can't list directory {display(directory)!r}: {e.strerror or e}")
        for e in entries:
            path = join_name(directory, e.name)
            if not has_utf8_form(e.name):
                raise Stop(f"entry {display(path)!r} has a name with no UTF-8 form; it can't be written into a snapshot")
            try:
                st = e.stat(follow_symlinks=False)
            except FileNotFoundError:
                continue                                  # vanished before its type was known: no row
            except OSError as ex:
                self.link_errors.append((f"can't determine type: {ex.strerror or ex}", path))
                continue
            tag = getattr(st, "st_reparse_tag", 0)
            if stat.S_ISLNK(st.st_mode) or (WINDOWS and tag == IO_REPARSE_TAG_MOUNT_POINT):
                self.link(path)
            elif stat.S_ISDIR(st.st_mode):
                self.walk(path)
            elif stat.S_ISREG(st.st_mode):
                if "\t" in path or "\r" in path or "\n" in path:
                    raise Stop(f"file {display(spell(path))!r} has a tab, CR or LF in its path; rename it or leave it out")
                self.files.append(path)
            # pipes, sockets, devices: no row

    def link(self, path):
        target = link_target_text(path)
        try:
            resolved = os.path.realpath(os_path(path), strict=True)
            tst = os.stat(resolved)
        except OSError as ex:
            if link_is_broken(ex):
                return                                    # broken: no row
            self.link_errors.append((f"link to {target} that this computer can't resolve: {ex.strerror or ex}", path))
            return
        if stat.S_ISDIR(tst.st_mode):
            kind, row_path = "folder", path + os.sep
        elif stat.S_ISREG(tst.st_mode):
            kind, row_path = "file", path
        else:
            return                                        # pipe, socket or device: no row
        if any(is_or_inside(record_path(resolved), m) for m in self.members):
            return                                        # into the backup: the target is recorded where it lies
        self.link_errors.append((f"link to a {kind} outside the backup: {target}", row_path))


def open_regular(path):
    flags = os.O_RDONLY | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0)
    return os.fdopen(os.open(os_path(path), flags), "rb")


def hash_file(path):
    """One check of size and mtime, then the SHA-256 of the content. Returns (hexdigest, size, mtime_ns)."""
    with open_regular(path) as f:
        st = os.fstat(f.fileno())
        if not stat.S_ISREG(st.st_mode):
            raise OSError(errno.EINVAL, "not a regular file when opened")
        size, ns = st.st_size, st.st_mtime_ns
        h = hashlib.sha256()
        while True:
            chunk = f.read(CHUNK)
            if not chunk:
                break
            h.update(chunk)
    return h.hexdigest(), size, ns


# ----------------------------------------------------------------------------------------------
# The bucket
# ----------------------------------------------------------------------------------------------

def make_s3():
    cfg = Config(retries={"mode": "standard", "max_attempts": 5}, connect_timeout=10, read_timeout=60)
    try:
        return boto3.client("s3", config=cfg)
    except botocore.exceptions.NoRegionError:
        return boto3.client("s3", config=cfg, region_name="us-east-1")


def error_code(e):
    return e.response.get("Error", {}).get("Code", ""), e.response.get("ResponseMetadata", {}).get("HTTPStatusCode")


def put_conditional(s3, bucket, key, body, sha256_hex=None):
    """PUT with If-None-Match: *. Returns 'created' or 'exists' (412). Raises Stop for a checksum refusal."""
    kwargs = dict(Bucket=bucket, Key=key, Body=body, IfNoneMatch="*", ServerSideEncryption="AES256")
    if sha256_hex is not None:
        kwargs["ChecksumSHA256"] = base64.b64encode(bytes.fromhex(sha256_hex)).decode("ascii")
    for attempt in range(6):
        try:
            s3.put_object(**kwargs)
            return "created"
        except ClientError as e:
            code, status = error_code(e)
            if status == 412 or code == "PreconditionFailed":
                return "exists"
            if code == "BadDigest":
                raise Stop(f"S3 refused {key}: the bytes sent don't hash to the key (the file changed while being sent)")
            if status == 409 or code == "ConditionalRequestConflict":
                if hasattr(body, "seek"):
                    body.seek(0)
                time.sleep(min(20, 0.5 * (2 ** attempt)))
                continue
            raise
    raise Stop(f"PUT {key} kept conflicting with another writer; giving up")


def get_bytes(s3, bucket, key):
    """The object's bytes, or None when the key is absent."""
    try:
        r = s3.get_object(Bucket=bucket, Key=key)
    except ClientError as e:
        code, status = error_code(e)
        if code in ("NoSuchKey", "NotFound") or status == 404:
            return None
        raise
    return r["Body"].read()


def list_snapshot_names(s3, bucket, setname):
    """Keys directly in snapshots/<set>/ named exactly like a snapshot, as their names without .tsv.gz."""
    prefix = f"snapshots/{setname}/"
    names = []
    for page in s3.get_paginator("list_objects_v2").paginate(Bucket=bucket, Prefix=prefix, Delimiter="/"):
        for o in page.get("Contents", []):
            leaf = o["Key"][len(prefix):]
            if SNAPSHOT_FILE_RE.match(leaf):
                names.append(leaf[:-len(".tsv.gz")])
    return sorted(names)


def list_stored_objects(s3, bucket):
    stored = set()
    for page in s3.get_paginator("list_objects_v2").paginate(Bucket=bucket, Prefix="objects/"):
        for o in page.get("Contents", []):
            leaf = o["Key"][len("objects/"):]
            if HEX64_RE.match(leaf):
                stored.add(leaf)
    return stored


class HashingBody:
    """A file-like body that hashes the bytes as the SDK sends them; a seek back to 0 starts the hash over."""

    def __init__(self, f):
        self.f = f
        self.reset()

    def reset(self):
        self.h = hashlib.sha256()
        self.n = 0

    def read(self, n=-1):
        b = self.f.read(n)
        self.h.update(b)
        self.n += len(b)
        return b

    def seek(self, offset, whence=0):
        r = self.f.seek(offset, whence)
        if self.f.tell() == 0:
            self.reset()
        return r

    def tell(self):
        return self.f.tell()

    def seekable(self):
        return True

    def readable(self):
        return True


# ----------------------------------------------------------------------------------------------
# The holder (.info)
# ----------------------------------------------------------------------------------------------

def load_holders():
    try:
        with open(HOLDER_FILE, "rb") as f:
            return json.loads(f.read().decode("utf-8"))
    except (OSError, ValueError):
        return {}


def save_holders(d):
    os.makedirs(LOCAL_DIR, exist_ok=True)
    with open(HOLDER_FILE, "wb") as f:
        f.write((json.dumps(d, indent=2, sort_keys=True) + "\n").encode("utf-8"))


def parse_info(b):
    """UTF-8, split on LF, one trailing CR stripped, split at the first '=', last repeat wins."""
    d = {}
    for line in b.decode("utf-8").split("\n"):
        if line.endswith("\r"):
            line = line[:-1]
        if "=" not in line:
            continue
        k, v = line.split("=", 1)
        d[k] = v
    return d


def read_info(s3, bucket, setname):
    b = get_bytes(s3, bucket, f"snapshots/{setname}.info")
    if b is None:
        return None
    try:
        return parse_info(b)
    except UnicodeDecodeError:
        return {}


def claim_or_verify_holder(s3, bucket, setname, me, snapshot_names):
    """Claim a new set, or check that we hold this one. Returns the (OWNER, CLAIMED) pair we must keep matching."""
    key = f"{bucket}/{setname}"
    holders = load_holders()
    info = read_info(s3, bucket, setname)
    if info is None:
        if snapshot_names:
            raise Stop(f"set {setname!r} has snapshots but no snapshots/{setname}.info: it has no holder, and this tool "
                       f"only takes a set over when asked")
        claimed = instant(time.time_ns() // 1_000_000)
        body = f"OWNER={me}\nCLAIMED={claimed}\nCREATED={claimed}\n".encode("utf-8")
        if put_conditional(s3, bucket, f"snapshots/{setname}.info", body) == "exists":
            raise Stop(f"another writer claimed set {setname!r} first")
        holders[key] = {"OWNER": me, "CLAIMED": claimed, "CREATED": claimed}
        save_holders(holders)
        print(f"claimed set {setname!r} as {me} at {claimed}")
        return holders[key]
    kept = holders.get(key)
    if kept and info.get("OWNER") == kept.get("OWNER") and info.get("CLAIMED") == kept.get("CLAIMED"):
        return kept
    if kept:
        del holders[key]
        save_holders(holders)
    raise Stop(f"set {setname!r} is held by {info.get('OWNER')!r} (claimed {info.get('CLAIMED')!r}), not by this tool; "
               f"it takes a set over only when asked")


def check_holder(s3, bucket, setname, pair):
    info = read_info(s3, bucket, setname)
    if info is None:
        raise Stop(f"snapshots/{setname}.info is gone: the set has no holder, so the snapshot isn't uploaded")
    if info.get("OWNER") != pair["OWNER"] or info.get("CLAIMED") != pair["CLAIMED"]:
        holders = load_holders()
        holders.pop(f"{bucket}/{setname}", None)
        save_holders(holders)
        raise Stop(f"set {setname!r} was taken over by {info.get('OWNER')!r} at {info.get('CLAIMED')!r}; "
                   f"the snapshot isn't uploaded")


# ----------------------------------------------------------------------------------------------
# The run
# ----------------------------------------------------------------------------------------------

def usage():
    sys.stderr.write("usage: python s3cab-backup.py <bucket> <set> <dir>...\n")
    return 2


def main(argv):
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="backslashreplace")
        except (AttributeError, ValueError):
            pass
    if len(argv) < 4:
        return usage()
    bucket, setname, dir_args = argv[1], argv[2], argv[3:]
    if bucket.startswith("s3://"):
        bucket = bucket[len("s3://"):]
    bucket = bucket.strip("/")
    if not bucket or "/" in bucket:
        sys.stderr.write(f"not a bucket name: {argv[1]!r}\n")
        return usage()
    if not SET_NAME_RE.match(setname):
        sys.stderr.write(f"not a set name: {setname!r} (a-z, 0-9, single hyphens between)\n")
        return usage()

    # One clock reading for START and the name, each cut down to its precision.
    t0 = time.time_ns()
    start_ms = t0 // 1_000_000
    name = time.strftime("%Y-%m-%dT%H%M", time.localtime(t0 // 1_000_000_000))
    zone = zone_name()
    me = user_at_machine()
    print(f"snapshot {name} of set {setname!r} into s3://{bucket}, by {me}, zone {zone}")

    try:
        return run(bucket, setname, dir_args, start_ms, name, zone, me)
    except Stop as e:
        sys.stderr.write(f"stopped, no snapshot written: {e}\n")
        return 1


def upload_objects(s3, bucket, records):
    """Store every object the rows name that the bucket doesn't list, each sent with the key's digest so S3
    refuses other bytes, and hashed again as it is sent. A file that changed stops the run: no snapshot."""
    wanted = {}
    for path, digest, size, ms in records:
        wanted.setdefault(digest, (path, size, ms))         # content several paths share is sent from the first
    stored = list_stored_objects(s3, bucket) if wanted else set()
    n_new = n_present = 0
    for digest, (path, size, ms) in wanted.items():
        if digest in stored:
            n_present += 1
            continue
        with open_regular(path) as f:
            st = os.fstat(f.fileno())
            if st.st_size != size or round_to_ms(st.st_mtime_ns) != ms:
                raise Stop(f"{display(path)!r} changed since its row was written (size or mtime); the snapshot isn't uploaded")
            body = HashingBody(f)
            result = put_conditional(s3, bucket, f"objects/{digest}", body, digest)
            if result == "created" and (body.h.hexdigest() != digest or body.n != size):
                s3.delete_object(Bucket=bucket, Key=f"objects/{digest}")
                raise Stop(f"{display(path)!r} changed while being sent; nothing is left under objects/{digest}")
        if result == "created":
            n_new += 1
            print(f"stored objects/{digest} ({size} bytes) from {display(path)}")
        else:
            n_present += 1
    print(f"objects: {n_new} uploaded, {n_present} already stored")


def resolve_members(dir_args):
    """Every member directory as its real path; stop when two are the same or one lies inside another."""
    members = [resolve_member(a) for a in dir_args]
    for i, a in enumerate(members):
        for j, b in enumerate(members):
            if i < j and is_or_inside(a, b) and is_or_inside(b, a):
                raise Stop(f"member directories {display(a)!r} and {display(b)!r} are the same directory")
            if i != j and is_or_inside(a, b) and not is_or_inside(b, a):
                raise Stop(f"member directory {display(a)!r} lies inside {display(b)!r}: its files would turn up twice")
    return members


def run(bucket, setname, dir_args, start_ms, name, zone, me):
    members = resolve_members(dir_args)
    for m in members:
        print(f"member directory {display(m)}")

    s3 = make_s3()
    existing_names = list_snapshot_names(s3, bucket, setname)
    if name in existing_names:
        raise Stop(f"snapshots/{setname}/{name}.tsv.gz already exists: a second snapshot in the same minute is refused")
    if existing_names and name < existing_names[-1]:
        print(f"warning: the clock went back; {name} sorts before the existing snapshot {existing_names[-1]}")
    pair = claim_or_verify_holder(s3, bucket, setname, me, existing_names)

    # Walk, then hash.
    walk = Walk(members)
    walk.run()
    print(f"listed {len(walk.files)} files, {len(walk.link_errors)} entries with an #error row")

    file_rows = []        # lines, in order (file rows and read-time #error rows)
    records = []          # (path, hash, size, mtime_ms) for uploading
    n_files = n_errors = 0
    total = 0
    for path in walk.files:
        try:
            digest, size, ns = hash_file(path)
        except OSError as ex:
            file_rows.append(row("#error", spell(f"can't read: {ex.strerror or ex}"), "", "", spell(path)))
            n_errors += 1
            continue
        ms = round_to_ms(ns)
        mtime = instant(ms)
        if mtime is None:
            file_rows.append(row("#error", f"modification time can't be written: {ns} ns since 1970 is outside the years 0000 to 9999", "", "", spell(path)))
            n_errors += 1
            continue
        file_rows.append(row("-", digest, str(size), mtime, path))
        records.append((path, digest, size, ms))
        n_files += 1
        total += size
    finish_ns = time.time_ns()
    finish_ms = -(-finish_ns // 1_000_000)            # rounded up
    n_errors += len(walk.link_errors)

    lines = [
        row("@S3CAB", "FORMAT", "size", "time", FORMAT_URL),
        row("@S3CAB", "SPEC", "", "", SPEC_DATE),
        row("@CLIENT", "NAME", "", "", CLIENT_NAME),
        row("@CLIENT", "VERSION", "", "", CLIENT_VERSION),
        row("@SET", "NAME", "", "", setname),
        row("@SET", "BUCKET", "", "", f"s3://{bucket}"),
    ]
    lines += [row("@SET", "DIR", "", "", spell(m)) for m in members]
    lines += [
        row("@SNAPSHOT", "NAME", "", "", name),
        row("@SNAPSHOT", "BY", "", "", spell(me)),
        row("@SNAPSHOT", "START", "", instant(start_ms), spell(zone)),
    ]
    lines += [row("#error", spell(msg), "", "", spell(p)) for msg, p in walk.link_errors]
    lines += file_rows
    lines += [
        row("@SNAPSHOT", "FILES", "", "", str(n_files)),
        row("@SNAPSHOT", "SIZE", "", "", f"{total} ({readable_size(total)})"),
        row("@SNAPSHOT", "FINISH", "", instant(finish_ms), duration_text(finish_ms - start_ms)),
        ".\n",
    ]
    text = "".join(lines).encode("utf-8")
    buf = io.BytesIO()
    with gzip.GzipFile(filename="", mode="wb", fileobj=buf, mtime=0) as gz:
        gz.write(text)
    snapshot = buf.getvalue()
    snapshot_hash = hashlib.sha256(snapshot).hexdigest()

    # Local copy first, never over an existing one.
    local_dir = os.path.join(LOCAL_DIR, "snapshots", setname)
    os.makedirs(local_dir, exist_ok=True)
    local_file = os.path.join(local_dir, f"{name}.tsv.gz")
    try:
        with open(local_file, "xb") as f:
            f.write(snapshot)
    except FileExistsError:
        raise Stop(f"a local snapshot {local_file} already exists: a second snapshot in the same minute is refused")
    print(f"snapshot written: {n_files} files, {total} bytes, {n_errors} #error rows -> {local_file}")

    # Objects first.
    upload_objects(s3, bucket, records)

    # Snapshot last, after the holder check.
    check_holder(s3, bucket, setname, pair)
    key = f"snapshots/{setname}/{name}.tsv.gz"
    result = put_conditional(s3, bucket, key, snapshot, snapshot_hash)
    if result == "exists":
        if get_bytes(s3, bucket, key) == snapshot:
            print(f"{key} was already uploaded with these bytes")
        else:
            raise Stop(f"{key} already exists with different bytes; refused")
    else:
        print(f"uploaded {key} ({len(snapshot)} bytes)")
    if n_errors:
        sys.stderr.write(f"backup written with {n_errors} #error row(s); exit 1\n")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
