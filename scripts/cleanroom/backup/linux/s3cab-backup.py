#!/usr/bin/env python3
"""s3cab-backup: an independent writer for the s3cab repository format.

    python s3cab-backup.py <bucket> <set> <dir>...

Written from the format spec alone (format.md, spec of 2026-10-23), using only
the Python standard library and boto3. Walks the member directories, uploads
every object the snapshot names, then the snapshot, and claims or checks the
set's `snapshots/<set>.info`.

Exit status: 0 when a snapshot was uploaded and holds no `#error` row; 1 when
the run stopped without a snapshot, or a snapshot was uploaded with `#error`
rows in it.
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
import stat as statmod
import sys
import time
from decimal import Decimal, ROUND_HALF_UP

import boto3
from botocore.config import Config
from botocore.exceptions import ClientError

CLIENT_NAME = "s3cab-backup"
CLIENT_VERSION = "0.1.0"
SPEC_DATE = "2026-10-23"
HEADING = ("@S3CAB", "FORMAT", "size", "time", "https://s3cab.plantegral.com/guide/format")

# Single PUT up to this size; multipart above it (S3's single-PUT ceiling is 5 GiB).
MULTIPART_THRESHOLD = 4 * 2**30
MULTIPART_PART_SIZE = 64 * 2**20

IS_WINDOWS = os.name == "nt"
SEP = "\\" if IS_WINDOWS else "/"

SET_NAME_RE = re.compile(r"^[a-z0-9]+(-[a-z0-9]+)*$")
SNAPSHOT_KEY_RE = re.compile(r"^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{4}\.tsv\.gz$")
HEX64_RE = re.compile(r"^[0-9a-f]{64}$")

# The spelled-out forms for a tab, CR and LF, where a row may hold such a name.
SPELL = {"\t": "\u2409", "\r": "\u240d", "\n": "\u240a"}


class Stop(Exception):
    """The run stops without writing a snapshot; the message says why."""


# ----------------------------------------------------------------------------
# Output

def out(msg=""):
    try:
        print(msg, flush=True)
    except UnicodeEncodeError:
        print(msg.encode("utf-8", "backslashreplace").decode("ascii"), flush=True)


def err(msg):
    try:
        print(msg, file=sys.stderr, flush=True)
    except UnicodeEncodeError:
        print(msg.encode("utf-8", "backslashreplace").decode("ascii"), file=sys.stderr, flush=True)


# ----------------------------------------------------------------------------
# Time

def civil_from_days(z):
    """Days since 1970-01-01 -> (year, month, day), proleptic Gregorian.
    Handles negative days and years outside datetime's 1..9999 range."""
    z += 719468
    era = z // 146097  # floor division already handles negative days
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


def ms_to_instant(ms):
    """Milliseconds since the epoch -> `YYYY-MM-DDTHH:MM:SS.sssZ`, or None if the
    year falls outside 0000..9999."""
    days, rem = divmod(ms, 86400000)
    y, mo, d = civil_from_days(days)
    if y < 0 or y > 9999:
        return None
    h, rem = divmod(rem, 3600000)
    mi, rem = divmod(rem, 60000)
    s, msec = divmod(rem, 1000)
    return "%04d-%02d-%02dT%02d:%02d:%02d.%03dZ" % (y, mo, d, h, mi, s, msec)


def ns_round_to_ms(ns):
    """Nearest millisecond, a tie to the later one (works for negative times)."""
    return (ns + 500_000) // 1_000_000


def ns_floor_ms(ns):
    return ns // 1_000_000


def ns_ceil_ms(ns):
    return -((-ns) // 1_000_000)


def local_minute_name(epoch_seconds):
    """Snapshot name: local wall-clock time to the minute, `YYYY-MM-DDTHHMM`."""
    lt = time.localtime(epoch_seconds)
    return "%04d-%02d-%02dT%02d%02d" % (lt.tm_year, lt.tm_mon, lt.tm_mday, lt.tm_hour, lt.tm_min)


def local_zone_name():
    """Best name available for the local time zone (free text in the format)."""
    tz = os.environ.get("TZ", "")
    if tz and "/" in tz and not tz.startswith(":"):
        return tz
    for p in ("/etc/localtime",):
        try:
            target = os.path.realpath(p)
            if "zoneinfo/" in target:
                return target.split("zoneinfo/", 1)[1]
        except OSError:
            pass
    try:
        with open("/etc/timezone", "r", encoding="utf-8") as f:
            name = f.read().strip()
            if name:
                return name
    except OSError:
        pass
    if IS_WINDOWS:
        try:
            import ctypes
            icu = ctypes.WinDLL("icu.dll")
            buf = ctypes.create_unicode_buffer(128)
            status = ctypes.c_int(0)
            n = icu.ucal_getDefaultTimeZone(buf, 128, ctypes.byref(status))
            if n > 0 and status.value <= 0:
                return buf.value[:n]
        except Exception:
            pass
    try:
        return time.tzname[time.localtime().tm_isdst > 0] or "local"
    except Exception:
        return "local"


def duration_text(ms):
    s = ms // 1000
    if s < 60:
        return "%ds" % s
    if s < 3600:
        return "%dm %02ds" % (s // 60, s % 60)
    return "%dh %02dm" % (s // 3600, (s % 3600) // 60)


# ----------------------------------------------------------------------------
# Canonical rows

def pad_right(s, width):
    n = len(s)
    return s + " " * (width - n) if n < width else s


def pad_left(s, width):
    n = len(s)
    return " " * (width - n) + s if n < width else s


def row(c1, c2="", c3="", c4="", c5=""):
    return "%s\t%s\t%s\t%s\t%s\n" % (c1, pad_right(c2, 64), pad_left(c3, 12), pad_right(c4, 24), c5)


def spell_out(s):
    return "".join(SPELL.get(c, c) for c in s)


def readable_size(n):
    """`@SNAPSHOT SIZE`'s readable form: `0B`..`999B`, then one decimal place,
    rounded half up, in the smallest of kB..PB that keeps it under 1000.0."""
    if n < 1000:
        return "%dB" % n
    d = Decimal(n)
    for unit in ("kB", "MB", "GB", "TB", "PB"):
        d = d / 1000
        q = d.quantize(Decimal("0.1"), rounding=ROUND_HALF_UP)
        if q < 1000 or unit == "PB":
            return "%s%s" % (q, unit)


# ----------------------------------------------------------------------------
# Paths

def is_windows_path(p):
    if len(p) >= 3 and p[0].isascii() and p[0].isalpha() and p[1] == ":" and p[2] in "\\/":
        return True
    if len(p) >= 2 and p[0] in "\\/" and p[1] in "\\/":
        return True
    return False


def split_segments(p):
    """(kind, root, [segments]) by whole segments. A Windows path splits on both
    separators; any other on `/` alone."""
    if is_windows_path(p):
        if p[1] == ":":
            root = p[0].upper() + ":\\"
            rest = p[3:]
        else:
            # \\server\share\...
            body = p[2:]
            parts = re.split(r"[\\/]", body)
            server = parts[0] if parts else ""
            share = parts[1] if len(parts) > 1 else ""
            root = "\\\\" + server + "\\" + share + "\\"
            rest = "/".join(parts[2:])
        segs = [s for s in re.split(r"[\\/]", rest) if s != ""]
        return "win", root, segs
    segs = [s for s in p.split("/") if s != ""]
    return "posix", "/", segs


def path_key(p):
    """A comparable form: Windows paths ignore case by Unicode's default mapping."""
    kind, root, segs = split_segments(p)
    if kind == "win":
        return (kind, root.lower(), tuple(s.lower() for s in segs))
    return (kind, root, tuple(segs))


def is_within(path, directory):
    """True if `path` is `directory` or lies inside it, by whole segments."""
    pk = path_key(path)
    dk = path_key(directory)
    if pk[0] != dk[0] or pk[1] != dk[1]:
        return False
    return pk[2][:len(dk[2])] == dk[2]


def strip_win_prefix(p):
    if p.startswith("\\\\?\\UNC\\"):
        return "\\\\" + p[8:]
    if p.startswith("\\\\?\\"):
        return p[4:]
    return p


def win_open_path(p):
    """A Windows path through `\\\\?\\` so that trailing dots and spaces and long
    paths are taken as written."""
    if p.startswith("\\\\?\\"):
        return p
    if p.startswith("\\\\"):
        return "\\\\?\\UNC\\" + p[2:]
    return "\\\\?\\" + p


def open_path(p):
    return win_open_path(p) if IS_WINDOWS else p


def fix_case(p):
    """Spell each name as its parent's listing does, for filesystems that ignore
    case: realpath keeps the case as typed there."""
    kind, root, segs = split_segments(p)
    if kind == "win":
        cur = root
        joiner = "\\"
    else:
        cur = "/"
        joiner = "/"
    for seg in segs:
        try:
            names = os.listdir(open_path(cur))
        except OSError:
            names = None
        chosen = seg
        if names is not None and seg not in names:
            low = seg.lower()
            matches = [n for n in names if n.lower() == low]
            if len(matches) == 1:
                chosen = matches[0]
        cur = cur + chosen if cur.endswith(joiner) else cur + joiner + chosen
    return cur


def real_directory(p):
    """The real path of a member directory, every part resolved, with a Windows
    drive letter uppercased. Raises OSError when it doesn't exist."""
    if IS_WINDOWS:
        a = os.path.normpath(os.path.join(os.getcwd(), p))
        r = os.path.realpath(win_open_path(a), strict=True)
        r = strip_win_prefix(r)
        if len(r) >= 2 and r[1] == ":":
            r = r[0].upper() + r[1:]
    else:
        r = os.path.realpath(p, strict=True)
    return fix_case(r)


def real_path_of(p):
    """Real path of any existing path (link targets), spelled like real_directory."""
    if IS_WINDOWS:
        r = os.path.realpath(win_open_path(p), strict=True)
        r = strip_win_prefix(r)
        if len(r) >= 2 and r[1] == ":":
            r = r[0].upper() + r[1:]
        return r
    return os.path.realpath(p, strict=True)


def with_trailing_sep(p):
    return p if p.endswith(SEP) else p + SEP


def join_name(directory, name):
    return directory + name if directory.endswith(SEP) else directory + SEP + name


def has_utf8_form(name):
    try:
        name.encode("utf-8")
        return True
    except UnicodeEncodeError:
        return False


def show_name(name):
    """A name for a message: U+FFFD for each part with no UTF-8 form."""
    if IS_WINDOWS:
        return name.encode("utf-8", "surrogatepass").decode("utf-8", "replace")
    return os.fsencode(name).decode("utf-8", "replace")


def has_row_breakers(s):
    return "\t" in s or "\r" in s or "\n" in s


# ----------------------------------------------------------------------------
# Walking

def is_broken_link_error(e):
    if isinstance(e, (FileNotFoundError, NotADirectoryError)):
        return True
    if getattr(e, "errno", None) in (errno.ENOENT, errno.ENOTDIR, errno.ELOOP):
        return True
    if IS_WINDOWS and getattr(e, "winerror", None) in (2, 3, 1921):
        return True
    return False


def is_junction(path):
    f = getattr(os.path, "isjunction", None)
    if f is None:
        return False
    try:
        return f(path)
    except OSError:
        return False


class Walker:
    def __init__(self, member_dirs):
        self.member_dirs = member_dirs      # real paths, no trailing separator except a root
        self.files = []                     # (record_path) in order
        self.pre_rows = []                  # ("#error", message, path) before the file rows
        self.stops = []                     # reasons to stop

    def walk(self):
        for d in self.member_dirs:
            self.walk_dir(d)

    def walk_dir(self, record_dir):
        try:
            with os.scandir(open_path(record_dir)) as it:
                entries = list(it)
        except OSError as e:
            raise Stop("directory can't be listed: %s (%s)" % (show_name(record_dir), e.strerror or e))
        entries.sort(key=lambda en: en.name)
        for en in entries:
            name = en.name
            if IS_WINDOWS and name.startswith("\\\\?\\"):
                name = os.path.basename(name)
            if not has_utf8_form(name):
                self.stops.append("name has no UTF-8 form: %s" % show_name(join_name(record_dir, name)))
                continue
            path = join_name(record_dir, name)
            self.visit(en, path)

    def visit(self, en, path):
        try:
            if en.is_symlink() or is_junction(en.path):
                self.visit_link(path)
                return
            if en.is_dir(follow_symlinks=False):
                self.walk_dir(path)
                return
            if en.is_file(follow_symlinks=False):
                self.visit_file(path)
                return
            # pipe, socket, device, or something else without content: no row
            return
        except FileNotFoundError:
            # vanished between being listed and its type being known: no row
            return
        except OSError as e:
            # type couldn't be determined
            if has_row_breakers(path):
                self.stops.append("path holds a tab, CR or LF: %s" % spell_out(path))
                return
            self.pre_rows.append(("#error", "%s: %s" % (errno.errorcode.get(e.errno, "EIO"), e.strerror or str(e)), path))

    def visit_file(self, path):
        if has_row_breakers(path):
            self.stops.append("path holds a tab, CR or LF: %s" % spell_out(path))
            return
        self.files.append(path)

    def visit_link(self, path):
        try:
            held = os.readlink(open_path(path))
            if IS_WINDOWS:
                held = strip_win_prefix(held)
        except OSError as e:
            held = "?"
        try:
            target = real_path_of(path)
            st = os.stat(open_path(target))
        except OSError as e:
            if is_broken_link_error(e):
                return  # broken: no row
            self.pre_rows.append((
                "#error",
                "link to %s can't be resolved: %s" % (spell_out(held), e.strerror or str(e)),
                spell_out(path),
            ))
            return
        if statmod.S_ISDIR(st.st_mode):
            is_dir = True
        elif statmod.S_ISREG(st.st_mode):
            is_dir = False
        else:
            return  # pipe, socket or device: no row
        for d in self.member_dirs:
            if is_within(target, d):
                return  # into the backup: the target is recorded where it lies
        row_path = spell_out(path)
        if is_dir:
            row_path = with_trailing_sep(row_path)
        self.pre_rows.append((
            "#error",
            "link to %s leads out of the backup" % spell_out(held),
            row_path,
        ))


# ----------------------------------------------------------------------------
# Hashing

def open_regular(path):
    """Open a regular file without following a link or blocking on a pipe.
    Returns (fd, stat), or (None, stat) when the path is no longer a regular
    file (a pipe, socket or device gets no row). Raises OSError otherwise."""
    flags = os.O_RDONLY
    for name in ("O_NOFOLLOW", "O_NONBLOCK", "O_BINARY", "O_CLOEXEC"):
        flags |= getattr(os, name, 0)
    fd = os.open(open_path(path), flags)
    try:
        st = os.fstat(fd)
    except OSError:
        os.close(fd)
        raise
    if not statmod.S_ISREG(st.st_mode):
        os.close(fd)
        return None, st
    return fd, st


def hash_fd(fd):
    h = hashlib.sha256()
    n = 0
    while True:
        chunk = os.read(fd, 1024 * 1024)
        if not chunk:
            break
        h.update(chunk)
        n += len(chunk)
    return h.hexdigest(), n


class HashingBody:
    """A file-like body that hashes the bytes botocore actually reads, in order,
    starting again whenever the stream is rewound to the start."""

    def __init__(self, f, size):
        self.f = f
        self.size = size
        self.h = hashlib.sha256()
        self.hashed = 0
        self.broken = False

    def read(self, n=-1):
        pos = self.f.tell()
        data = self.f.read(n)
        if pos == self.hashed:
            self.h.update(data)
            self.hashed += len(data)
        elif data:
            self.broken = True
        return data

    def seek(self, offset, whence=0):
        r = self.f.seek(offset, whence)
        if self.f.tell() == 0:
            self.h = hashlib.sha256()
            self.hashed = 0
            self.broken = False
        return r

    def tell(self):
        return self.f.tell()

    def __len__(self):
        return self.size

    def hexdigest(self):
        if self.broken or self.hashed != self.size:
            return None
        return self.h.hexdigest()


# ----------------------------------------------------------------------------
# S3

def hex_to_b64(hex_digest):
    return base64.b64encode(bytes.fromhex(hex_digest)).decode("ascii")


def add_if_none_match(params, **kwargs):
    params["headers"]["If-None-Match"] = "*"


def make_client():
    cfg = Config(
        retries={"max_attempts": 3, "mode": "standard"},
        connect_timeout=10,
        read_timeout=30,
        s3={"addressing_style": "virtual"},
    )
    client = boto3.client("s3", config=cfg)
    client.meta.events.register("before-call.s3.PutObject", add_if_none_match)
    client.meta.events.register("before-call.s3.CompleteMultipartUpload", add_if_none_match)
    return client


def error_code(e):
    return e.response.get("Error", {}).get("Code", "")


def http_status(e):
    return e.response.get("ResponseMetadata", {}).get("HTTPStatusCode", 0)


def get_bytes(client, bucket, key):
    """The object's bytes, or None when the key is missing."""
    try:
        r = client.get_object(Bucket=bucket, Key=key)
    except ClientError as e:
        if error_code(e) in ("NoSuchKey", "NotFound") or http_status(e) == 404:
            return None
        raise
    return r["Body"].read()


def list_snapshot_names(client, bucket, set_name):
    names = []
    prefix = "snapshots/%s/" % set_name
    paginator = client.get_paginator("list_objects_v2")
    for page in paginator.paginate(Bucket=bucket, Prefix=prefix, Delimiter="/"):
        for o in page.get("Contents", []):
            tail = o["Key"][len(prefix):]
            if SNAPSHOT_KEY_RE.match(tail):
                names.append(tail[:-len(".tsv.gz")])
    return names


def list_stored_hashes(client, bucket):
    stored = set()
    paginator = client.get_paginator("list_objects_v2")
    for page in paginator.paginate(Bucket=bucket, Prefix="objects/"):
        for o in page.get("Contents", []):
            tail = o["Key"][len("objects/"):]
            if HEX64_RE.match(tail):
                stored.add(tail)
    return stored


def conditional_put(client, bucket, key, body, sha256_hex, size):
    """PUT with If-None-Match: * and the key's SHA-256 for S3 to check.
    Returns "stored", "exists" (412) or raises."""
    try:
        client.put_object(
            Bucket=bucket,
            Key=key,
            Body=body,
            ContentLength=size,
            ChecksumSHA256=hex_to_b64(sha256_hex),
            ServerSideEncryption="AES256",
        )
        return "stored"
    except ClientError as e:
        if http_status(e) == 412 or error_code(e) == "PreconditionFailed":
            return "exists"
        raise


def parse_info(data):
    """`KEY=value` lines; UTF-8, split on LF, one trailing CR stripped, last
    repeated key wins, lines without `=` skipped."""
    text = data.decode("utf-8")
    if text.startswith("\ufeff"):
        text = text[1:]
    info = {}
    for line in text.split("\n"):
        if line.endswith("\r"):
            line = line[:-1]
        if "=" not in line:
            continue
        k, v = line.split("=", 1)
        info[k] = v
    return info


# ----------------------------------------------------------------------------
# Kept state (beside the program)

def state_dir():
    return os.path.join(os.path.dirname(os.path.abspath(__file__)), "s3cab-backup.state")


def state_path():
    return os.path.join(state_dir(), "state.json")


def load_state():
    try:
        with open(state_path(), "rb") as f:
            return json.loads(f.read().decode("utf-8"))
    except (OSError, ValueError):
        return {}


def save_state(state):
    os.makedirs(state_dir(), exist_ok=True)
    tmp = state_path() + ".tmp"
    with open(tmp, "wb") as f:
        f.write(json.dumps(state, indent=2, sort_keys=True).encode("utf-8"))
    os.replace(tmp, state_path())


def keep_local_snapshot(bucket, set_name, name, data):
    d = os.path.join(state_dir(), "snapshots", bucket, set_name)
    os.makedirs(d, exist_ok=True)
    p = os.path.join(d, name + ".tsv.gz")
    # exclusive create: a snapshot is never overwritten
    fd = os.open(p, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_BINARY", 0), 0o644)
    with os.fdopen(fd, "wb") as f:
        f.write(data)
    return p


# ----------------------------------------------------------------------------
# The run

def user_at_machine():
    try:
        user = getpass.getuser()
    except Exception:
        user = os.environ.get("USER") or os.environ.get("USERNAME") or "unknown"
    try:
        host = socket.gethostname()
    except Exception:
        host = "unknown"
    return "%s@%s" % (user, host)


def main(argv):
    if len(argv) < 4:
        err("usage: python s3cab-backup.py <bucket> <set> <dir>...")
        return 2
    bucket, set_name, dirs = argv[1], argv[2], argv[3:]
    try:
        return run(bucket, set_name, dirs)
    except Stop as e:
        err("stopped: %s" % e)
        return 1


def run(bucket, set_name, dirs):
    if not SET_NAME_RE.match(set_name):
        raise Stop("set name must be a-z, 0-9 and single hyphens between them: %r" % set_name)

    # Member directories: must exist and be directories; recorded as real paths.
    members = []
    for d in dirs:
        try:
            r = real_directory(d)
        except OSError as e:
            raise Stop("member directory doesn't exist: %s (%s)" % (d, e.strerror or e))
        if not os.path.isdir(open_path(r)):
            raise Stop("member directory isn't a directory: %s" % d)
        members.append(r)
    for i, a in enumerate(members):
        for j, b in enumerate(members):
            if i != j and is_within(a, b):
                if path_key(a) == path_key(b):
                    raise Stop("the same directory is named twice: %s and %s" % (dirs[i], dirs[j]))
                raise Stop("member directory %s lies inside %s" % (a, b))

    # One clock reading for the start instant and the snapshot's name.
    start_ns = time.time_ns()
    start_ms = ns_floor_ms(start_ns)
    start_instant = ms_to_instant(start_ms)
    name = local_minute_name(start_ns // 1_000_000_000)
    zone = local_zone_name()
    by = user_at_machine()
    snapshot_key = "snapshots/%s/%s.tsv.gz" % (set_name, name)
    info_key = "snapshots/%s.info" % set_name

    client = make_client()
    out("set %s -> s3://%s, snapshot %s" % (set_name, bucket, name))

    # Refuse a second snapshot in the same minute, early.
    existing = list_snapshot_names(client, bucket, set_name)
    if name in existing:
        raise Stop("a snapshot named %s already exists for set %s" % (name, set_name))

    # Claim the set, or check that we hold it.
    state = load_state()
    state_key = "%s/%s" % (bucket, set_name)
    kept = state.get(state_key)
    info_data = get_bytes(client, bucket, info_key)
    if info_data is None:
        if existing:
            raise Stop("set %s has snapshots but no .info: it has no holder until one takes it over" % set_name)
        now_ms = ns_floor_ms(time.time_ns())
        claimed = ms_to_instant(now_ms)
        body = ("OWNER=%s\nCLAIMED=%s\nCREATED=%s\n" % (by, claimed, claimed)).encode("utf-8")
        result = conditional_put(client, bucket, info_key, body, hashlib.sha256(body).hexdigest(), len(body))
        if result == "stored":
            kept = {"OWNER": by, "CLAIMED": claimed}
            state[state_key] = kept
            save_state(state)
            out("claimed set %s as %s" % (set_name, by))
        else:
            info_data = get_bytes(client, bucket, info_key)
            if info_data is None:
                raise Stop("claiming set %s: .info appeared and vanished" % set_name)
    if info_data is not None:
        info = parse_info(info_data)
        if kept is None or info.get("OWNER") != kept.get("OWNER") or info.get("CLAIMED") != kept.get("CLAIMED"):
            if kept is not None:
                del state[state_key]
                save_state(state)
            raise Stop("set %s is held by %s (claimed %s); this machine isn't its holder"
                       % (set_name, info.get("OWNER"), info.get("CLAIMED")))

    # Walk.
    walker = Walker(members)
    walker.walk()
    if walker.stops:
        for s in walker.stops:
            err("refused: %s" % s)
        raise Stop("%d entr%s can't be recorded; rename or leave them out" % (
            len(walker.stops), "y" if len(walker.stops) == 1 else "ies"))

    # Rows.
    lines = [row(*HEADING)]
    lines.append(row("@S3CAB", "SPEC", "", "", SPEC_DATE))
    lines.append(row("@CLIENT", "NAME", "", "", CLIENT_NAME))
    lines.append(row("@CLIENT", "VERSION", "", "", CLIENT_VERSION))
    lines.append(row("@SET", "NAME", "", "", set_name))
    lines.append(row("@SET", "BUCKET", "", "", "s3://" + bucket))
    for m in members:
        lines.append(row("@SET", "DIR", "", "", spell_out(with_trailing_sep(m))))
    lines.append(row("@SNAPSHOT", "NAME", "", "", name))
    lines.append(row("@SNAPSHOT", "BY", "", "", by))
    lines.append(row("@SNAPSHOT", "START", "", start_instant, zone))
    error_count = 0
    for typ, msg, path in walker.pre_rows:
        lines.append(row(typ, msg, "", "", path))
        error_count += 1

    # Hash every file: size and time from one check just before hashing.
    file_count = 0
    total_size = 0
    objects = {}       # hash -> (path, size, mtime_ns) of the first path holding it
    order = []
    for path in walker.files:
        try:
            fd, st = open_regular(path)
        except FileNotFoundError:
            lines.append(row("#error", "ENOENT: no such file or directory", "", "", path))
            error_count += 1
            continue
        except OSError as e:
            lines.append(row("#error", "%s: %s" % (errno.errorcode.get(e.errno, "EIO"), e.strerror or str(e)), "", "", path))
            error_count += 1
            continue
        if fd is None:
            continue  # no longer a regular file: pipe, socket or device gets no row
        try:
            size = st.st_size
            mtime_ns = st.st_mtime_ns
            try:
                digest, _ = hash_fd(fd)
            except OSError as e:
                lines.append(row("#error", "%s: %s" % (errno.errorcode.get(e.errno, "EIO"), e.strerror or str(e)), "", "", path))
                error_count += 1
                continue
        finally:
            os.close(fd)
        instant = ms_to_instant(ns_round_to_ms(mtime_ns))
        if instant is None:
            lines.append(row("#error", "modification time outside years 0000-9999", "", "", path))
            error_count += 1
            continue
        lines.append(row("-", digest, str(size), instant, path))
        file_count += 1
        total_size += size
        if digest not in objects:
            objects[digest] = (path, size, mtime_ns)
            order.append(digest)

    finish_ns = time.time_ns()
    finish_ms = ns_ceil_ms(finish_ns)
    lines.append(row("@SNAPSHOT", "FILES", "", "", str(file_count)))
    lines.append(row("@SNAPSHOT", "SIZE", "", "", "%d (%s)" % (total_size, readable_size(total_size))))
    lines.append(row("@SNAPSHOT", "FINISH", "", ms_to_instant(finish_ms), duration_text(finish_ms - start_ms)))
    lines.append(".\n")
    text = "".join(lines).encode("utf-8")

    buf = io.BytesIO()
    with gzip.GzipFile(filename="", mode="wb", mtime=0, fileobj=buf) as gz:
        gz.write(text)
    snapshot_bytes = buf.getvalue()
    out("%d file rows, %d bytes, %d distinct objects, %d #error rows" % (
        file_count, total_size, len(objects), error_count))

    # Objects first.
    stored = list_stored_hashes(client, bucket)
    sent = reused = 0
    for digest in order:
        if digest in stored:
            reused += 1
            continue
        path, size, mtime_ns = objects[digest]
        upload_object(client, bucket, digest, path, size, mtime_ns)
        sent += 1
    out("objects: %d sent, %d already stored" % (sent, reused))

    # The holder, immediately before the snapshot's upload.
    info_data = get_bytes(client, bucket, info_key)
    if info_data is None:
        raise Stop("snapshots/%s.info is gone; refusing to publish" % set_name)
    info = parse_info(info_data)
    if info.get("OWNER") != kept["OWNER"] or info.get("CLAIMED") != kept["CLAIMED"]:
        state = load_state()
        state.pop(state_key, None)
        save_state(state)
        raise Stop("set %s was taken over by %s (claimed %s); refusing to publish"
                   % (set_name, info.get("OWNER"), info.get("CLAIMED")))

    # Snapshot last.
    snap_hash = hashlib.sha256(snapshot_bytes).hexdigest()
    result = conditional_put(client, bucket, snapshot_key, snapshot_bytes, snap_hash, len(snapshot_bytes))
    if result == "exists":
        there = get_bytes(client, bucket, snapshot_key)
        if there != snapshot_bytes:
            raise Stop("a different snapshot already exists at %s; refusing to overwrite" % snapshot_key)
        out("snapshot already uploaded with the same bytes")
    try:
        local = keep_local_snapshot(bucket, set_name, name, snapshot_bytes)
        out("local copy: %s" % local)
    except OSError as e:
        err("couldn't keep a local copy of the snapshot: %s" % e)
    out("uploaded s3://%s/%s" % (bucket, snapshot_key))
    if error_count:
        err("%d #error row%s in the snapshot" % (error_count, "" if error_count == 1 else "s"))
        return 1
    return 0


def upload_object(client, bucket, digest, path, size, mtime_ns):
    key = "objects/" + digest
    try:
        fd, st = open_regular(path)
    except OSError as e:
        raise Stop("can't open %s to upload it: %s" % (path, e.strerror or e))
    if fd is None:
        raise Stop("%s is no longer a regular file" % path)
    try:
        if st.st_size != size or st.st_mtime_ns != mtime_ns:
            raise Stop("%s changed since it was hashed; not sent, snapshot not uploaded" % path)
        f = os.fdopen(fd, "rb", closefd=False)
        if size > MULTIPART_THRESHOLD:
            upload_multipart(client, bucket, key, digest, f, size, path)
        else:
            body = HashingBody(f, size)
            try:
                result = conditional_put(client, bucket, key, body, digest, size)
            except ClientError as e:
                if error_code(e) == "BadDigest":
                    raise Stop("%s: the bytes sent don't hash to %s (S3 stored nothing)" % (path, digest))
                raise
            sent_hash = body.hexdigest()
            if result == "stored" and sent_hash != digest:
                # S3 checked the same bytes against the key, so this shouldn't happen;
                # leave nothing stored under the key if it does.
                client.delete_object(Bucket=bucket, Key=key)
                raise Stop("%s: bytes sent hashed to %s, not %s; removed" % (path, sent_hash, digest))
    finally:
        os.close(fd)


def upload_multipart(client, bucket, key, digest, f, size, path):
    create = client.create_multipart_upload(
        Bucket=bucket, Key=key, ChecksumAlgorithm="SHA256", ServerSideEncryption="AES256")
    upload_id = create["UploadId"]
    whole = hashlib.sha256()
    parts = []
    try:
        number = 0
        remaining = size
        while remaining > 0:
            number += 1
            chunk = f.read(min(MULTIPART_PART_SIZE, remaining))
            if not chunk:
                break
            remaining -= len(chunk)
            whole.update(chunk)
            part_hash = hashlib.sha256(chunk).hexdigest()
            r = client.upload_part(
                Bucket=bucket, Key=key, UploadId=upload_id, PartNumber=number,
                Body=chunk, ContentLength=len(chunk), ChecksumSHA256=hex_to_b64(part_hash))
            parts.append({"PartNumber": number, "ETag": r["ETag"], "ChecksumSHA256": r["ChecksumSHA256"]})
        if remaining != 0 or whole.hexdigest() != digest:
            raise Stop("%s: the bytes sent don't hash to %s; upload aborted, nothing stored" % (path, digest))
        try:
            client.complete_multipart_upload(
                Bucket=bucket, Key=key, UploadId=upload_id, MultipartUpload={"Parts": parts})
        except ClientError as e:
            if http_status(e) == 412 or error_code(e) == "PreconditionFailed":
                client.abort_multipart_upload(Bucket=bucket, Key=key, UploadId=upload_id)
                return
            raise
    except BaseException:
        try:
            client.abort_multipart_upload(Bucket=bucket, Key=key, UploadId=upload_id)
        except Exception:
            pass
        raise


if __name__ == "__main__":
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="backslashreplace")
        sys.stderr.reconfigure(encoding="utf-8", errors="backslashreplace")
    except Exception:
        pass
    sys.exit(main(sys.argv))
