#!/usr/bin/env python3
"""Back up one s3cab set to an S3 bucket, written from format.md (the spec of 2026-10-20) alone.

    python s3cab-backup.py <bucket> <set> <dir>...

Walks the member directories, stores every file's content at objects/<sha256>, then uploads
the snapshot snapshots/<set>/<YYYY-MM-DDTHHMM>.tsv.gz that names them. The first run claims
the set (snapshots/<set>.info); the OWNER/CLAIMED pair it wrote, and a copy of every snapshot,
are kept in cleanroom-backup-state/ beside this file.

Exit status: 0 backed up; 1 backed up, with #error rows; 2 stopped, no snapshot uploaded.
"""

import sys

sys.dont_write_bytecode = True  # nothing outside our own folder, not even boto3's .pyc files

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
import time
import traceback
import unicodedata

try:
    import fcntl
except ImportError:  # Windows
    fcntl = None

import boto3
from botocore.config import Config
from botocore.exceptions import BotoCoreError, ClientError

SPEC_DATE = "2026-10-20"
CLIENT_NAME = "cleanroom-backup"
CLIENT_VERSION = "1.0"
FORMAT_URL = "https://s3cab.plantegral.com/guide/format"

WINDOWS = os.name == "nt"
SEP = "\\" if WINDOWS else "/"
STATE_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "cleanroom-backup-state")

PART_SIZE = 16 * 1024 * 1024  # a file larger than this is uploaded in parts
READ_CHUNK = 1024 * 1024
HASH_ATTEMPTS = 3  # a file that keeps changing while it is read gets an #error row

HASH_RE = re.compile(r"[0-9a-f]{64}\Z")
INSTANT_RE = re.compile(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\Z")
SET_RE = re.compile(r"[a-z0-9-]+\Z")
SNAPSHOT_KEY_RE = re.compile(r"\d{4}-\d{2}-\d{2}T\d{4}\.tsv\.gz\Z")
EPOCH = datetime.datetime(1970, 1, 1)


class Refuse(Exception):
    """The run stops here, and no snapshot is uploaded."""


class Changed(Exception):
    """A file no longer holds the bytes its row names."""


# ---------------------------------------------------------------------------- output


def setup_output():
    # Before Python 3.15, redirected output on Windows is in the locale's code page, which
    # can't print every path; a path that fails to print must not stop a backup halfway.
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="backslashreplace")
        except (AttributeError, ValueError):
            pass


def log(msg):
    print(msg, flush=True)


def warn(msg):
    print(msg, file=sys.stderr, flush=True)


def show(path):
    return repr(path)


def describe(e):
    """An OSError as `ENAME: text`."""
    name = errno.errorcode.get(e.errno) if isinstance(e.errno, int) else None
    text = e.strerror or str(e)
    if getattr(e, "winerror", None):
        text = "%s (winerror %d)" % (text, e.winerror)
    return "%s: %s" % (name, text) if name else text


# ---------------------------------------------------------------------------- text


SPELL_OUT = str.maketrans({"\t": "\u2409", "\r": "\u240d", "\n": "\u240a"})


def as_text(s):
    """A value for any field but a file row's path: valid UTF-8 (U+FFFD for what doesn't
    decode), with tab, CR and LF spelled out as Control Pictures."""
    try:
        s.encode("utf-8")
    except UnicodeEncodeError:
        try:
            s = os.fsencode(s).decode("utf-8", "replace")
        except UnicodeError:
            s = s.encode("utf-8", "surrogatepass").decode("utf-8", "replace")
    return s.translate(SPELL_OUT)


def name_problem(name):
    """Why a name can't go into a snapshot at all, or None."""
    if "\t" in name or "\r" in name or "\n" in name:
        return "holds a tab, CR or LF, which no snapshot row can hold"
    try:
        name.encode("utf-8")
    except UnicodeEncodeError:
        return "is not valid Unicode, so has no UTF-8 form (%s)" % as_text(name)
    return None


def trim(s):
    """The trim for a leading field: tab, VT, FF, CR, LF, Unicode spaces (Zs), U+2028,
    U+2029 and a BOM, but not U+0085."""

    def blank(c):
        return c in "\t\x0b\x0c\r\n\u2028\u2029\ufeff" or unicodedata.category(c) == "Zs"

    i, j = 0, len(s)
    while i < j and blank(s[i]):
        i += 1
    while j > i and blank(s[j - 1]):
        j -= 1
    return s[i:j]


# ---------------------------------------------------------------------------- time


def instant(ms):
    """Milliseconds since 1970 as YYYY-MM-DDTHH:MM:SS.sssZ, or None if that can't hold it."""
    try:
        t = EPOCH + datetime.timedelta(milliseconds=ms)
    except OverflowError:
        return None
    return "%04d-%02d-%02dT%02d:%02d:%02d.%03dZ" % (
        t.year, t.month, t.day, t.hour, t.minute, t.second, t.microsecond // 1000)


def ms_nearest(ns):
    return (ns + 500000) // 1000000  # a tie goes to the later millisecond


def ms_down(ns):
    return ns // 1000000


def ms_up(ns):
    return -(-ns // 1000000)


def duration(ms):
    s = (ms + 500) // 1000
    if s < 60:
        return "%ds" % s
    if s < 3600:
        return "%dm %02ds" % (s // 60, s % 60)
    return "%dh %02dm" % (s // 3600, (s % 3600) // 60)


def readable_size(n):
    """`@SNAPSHOT SIZE`'s readable form: powers of 1000, one decimal rounded half up."""
    if n < 1000:
        return "%dB" % n
    for power, unit in enumerate(("kB", "MB", "GB", "TB", "PB"), 1):
        div = 1000 ** power
        tenths = (n * 10 + div // 2) // div
        if tenths < 10000 or unit == "PB":
            return "%d.%d%s" % (tenths // 10, tenths % 10, unit)


def zone_name(local):
    """The best name we have for the local time zone (free text: it is written for people)."""
    tz = os.environ.get("TZ", "").lstrip(":")
    if tz:
        i = tz.find("zoneinfo/")
        if i >= 0:
            return tz[i + len("zoneinfo/"):]
        if not os.path.isabs(tz):
            return tz
    if WINDOWS:
        name = _icu_zone()
        if name:
            return name
    else:
        try:
            link = os.readlink("/etc/localtime")
            i = link.find("zoneinfo/")
            if i >= 0:
                return link[i + len("zoneinfo/"):]
        except OSError:
            pass
        try:
            with open("/etc/timezone", "rb") as f:
                name = f.read().decode("utf-8").strip()
            if name:
                return name
        except (OSError, UnicodeDecodeError):
            pass
    return getattr(local, "tm_zone", None) or time.tzname[local.tm_isdst > 0] or "local time"


def _icu_zone():
    # Windows 10 1903 and later ship ICU, which knows the IANA name; the registry doesn't.
    try:
        import ctypes

        icu = ctypes.WinDLL("icu.dll")
        get = icu.ucal_getDefaultTimeZone
        get.restype = ctypes.c_int32
        get.argtypes = [ctypes.c_wchar_p, ctypes.c_int32, ctypes.POINTER(ctypes.c_int)]
        buf = ctypes.create_unicode_buffer(128)
        status = ctypes.c_int(0)
        n = get(buf, 128, ctypes.byref(status))
        if status.value <= 0 and 0 < n < 128:
            return buf.value[:n]
    except Exception:
        pass
    return None


def who():
    """`user@machine`, for OWNER and BY."""
    try:
        user = getpass.getuser()
    except Exception:
        user = os.environ.get("USERNAME") or os.environ.get("USER") or "unknown"
    machine = socket.gethostname().split(".")[0] or "unknown"
    return as_text("%s@%s" % (user, machine))


# ---------------------------------------------------------------------------- paths


def os_path(p):
    """The path to give the OS. On Windows, through \\\\?\\, so a name ending in a dot or a
    space, a reserved name or a long path is taken exactly as written."""
    if not WINDOWS or p.startswith("\\\\?\\"):
        return p
    if p.startswith("\\\\"):
        return "\\\\?\\UNC\\" + p[2:]
    return "\\\\?\\" + p


def plain_path(p):
    """The path as recorded: no \\\\?\\ prefix, a Windows drive letter in uppercase."""
    if WINDOWS:
        if p.startswith("\\\\?\\UNC\\"):
            p = "\\\\" + p[8:]
        elif p.startswith("\\\\?\\"):
            p = p[4:]
        if len(p) >= 2 and p[1] == ":":
            p = p[0].upper() + p[1:]
    return p


def join(d, name):
    return d + name if d.endswith(SEP) else d + SEP + name


def with_sep(p):
    return p if p.endswith(SEP) else p + SEP


def inside(p, d):
    """p is d, or lies under it, compared by whole segments."""
    return p == d or p.startswith(with_sep(d))


def resolve(p):
    """os.path.realpath(p, strict=True), on Windows through \\\\?\\ (normpath, not abspath,
    which drops a trailing dot or space)."""
    if WINDOWS:
        if not os.path.isabs(p):
            p = os.path.join(os.getcwd(), p)
        p = os_path(os.path.normpath(p))
    try:
        real = os.path.realpath(p, strict=True)
    except TypeError:  # Python before 3.10
        real = os.path.realpath(p)
        os.stat(real)
    return plain_path(real)


def true_case(p):
    """A resolved absolute path spelled with the case (and normalization) the filesystem
    reports. realpath keeps the case as typed on macOS and in a Linux directory that ignores
    case; on Windows it already asked the filesystem for the final path."""
    if WINDOWS:
        return p
    got = _getpath_dir(p)
    if got is not None:
        return got
    parent, name = os.path.split(p)
    if not name or parent == p:
        return p
    parent = true_case(parent)
    return join(parent, _listed_name(parent, name))


def _getpath_dir(p):
    # macOS: the kernel reports a directory's path as spelled on disk, without needing
    # permission to list its parents. Not used for files: a hard-linked file may report
    # its other name.
    if fcntl is None or not hasattr(fcntl, "F_GETPATH"):
        return None
    try:
        fd = os.open(p, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
    except OSError:
        return None
    try:
        got = fcntl.fcntl(fd, fcntl.F_GETPATH, bytes(1024)).split(b"\0", 1)[0]
    except OSError:
        return None
    finally:
        os.close(fd)
    got = os.fsdecode(got)
    try:
        a, b = os.stat(p), os.stat(got)
    except OSError:
        return None
    return got if (a.st_dev, a.st_ino) == (b.st_dev, b.st_ino) else None


def _listed_name(parent, name):
    # Look the name up in its parent's listing, matching the entry by identity.
    try:
        names = os.listdir(os_path(parent))
    except OSError:
        return name
    if name in names:
        return name
    try:
        want = os.lstat(os_path(join(parent, name)))
    except OSError:
        return name
    same = []
    for n in names:
        try:
            st = os.lstat(os_path(join(parent, n)))
        except OSError:
            continue
        if (st.st_dev, st.st_ino) == (want.st_dev, want.st_ino):
            same.append(n)
    if len(same) > 1:  # hard links: prefer the one that differs only in case/normalization

        def fold(s):
            return unicodedata.normalize("NFD", s).casefold()

        same = [n for n in same if fold(n) == fold(name)]
    return same[0] if len(same) == 1 else name


def identity(st):
    return (st.st_dev, st.st_ino) if st.st_ino else None


def ancestor_ids(p):
    """(dev, ino) of p and each directory above it."""
    ids = []
    while True:
        try:
            ident = identity(os.stat(os_path(p)))
        except OSError:
            ident = None
        if ident:
            ids.append(ident)
        parent = os.path.dirname(p)
        if parent == p:
            return ids
        p = parent


def is_link(st):
    """A symbolic link, or on Windows a junction. Other reparse points are ordinary."""
    if stat.S_ISLNK(st.st_mode):
        return True
    tag = getattr(st, "st_reparse_tag", 0)
    return bool(tag) and tag == getattr(stat, "IO_REPARSE_TAG_MOUNT_POINT", 0xA0000003)


def vanished(e):
    """lstat failed because the entry is no longer there."""
    w = getattr(e, "winerror", None)
    if w is not None:
        return w in (2, 3)
    return e.errno in (errno.ENOENT, errno.ENOTDIR)


def broken(e):
    """Following a link failed because it's broken: nothing where it points, a file used as
    a directory, or a loop. Anything else is somewhere this computer can't resolve."""
    w = getattr(e, "winerror", None)
    if w is not None:
        return w in (2, 3, 1921)
    return e.errno in (errno.ENOENT, errno.ENOTDIR, errno.ELOOP)


def open_file(path):
    flags = os.O_RDONLY | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOFOLLOW", 0)
    flags |= getattr(os, "O_NONBLOCK", 0)  # never hang on something swapped for a pipe
    fd = os.open(os_path(path), flags)
    f = os.fdopen(fd, "rb", buffering=0)
    if not stat.S_ISREG(os.fstat(f.fileno()).st_mode):
        f.close()
        raise Changed("is no longer a regular file")
    return f


def read_some(f, n):
    out = []
    while n > 0:
        chunk = f.read(min(n, READ_CHUNK))
        if not chunk:
            break
        out.append(chunk)
        n -= len(chunk)
    return b"".join(out)


def hash_file(path):
    """(sha256 hex, size, mtime_ns) of a file, or the text of the #error it gets."""
    problem = "kept changing while it was read"
    for _ in range(HASH_ATTEMPTS):
        try:
            f = open_file(path)
        except Changed as e:
            problem = str(e)
            continue
        except OSError as e:
            return "can't open: " + describe(e)
        try:
            with f:
                before = os.fstat(f.fileno())
                h = hashlib.sha256()
                n = 0
                while True:
                    chunk = f.read(READ_CHUNK)
                    if not chunk:
                        break
                    h.update(chunk)
                    n += len(chunk)
                after = os.fstat(f.fileno())
        except OSError as e:
            return "can't read: " + describe(e)
        if n == before.st_size == after.st_size and before.st_mtime_ns == after.st_mtime_ns:
            return h.hexdigest(), n, after.st_mtime_ns
    return problem


# ---------------------------------------------------------------------------- the walk


class Walk:
    """Walks the member directories and collects the snapshot's per-path rows."""

    def __init__(self, members):
        self.members = members  # [(real path, identity)]
        self.member_ids = {ident for _, ident in members if ident}
        self.notes = []  # #excluded / #error rows, listed above the files
        self.body = []  # file rows, with an #error among them for a file that failed
        self.files = []  # (hash, size, path)
        self.stops = []  # why the run must stop
        self.errors = 0
        try:
            self.own_id = identity(os.stat(STATE_DIR))
        except OSError:
            self.own_id = None

    def stop(self, why):
        self.stops.append(why)

    def note(self, kind, text, path):
        self.notes.append((kind, text, "", "", path))
        if kind == "#error":
            self.errors += 1

    def listing(self, d):
        try:
            with os.scandir(os_path(d)) as it:
                return [e.name for e in it]
        except OSError as e:
            self.stop("can't list directory %s: %s" % (show(d), describe(e)))
            return []

    def run(self):
        for member, _ in self.members:
            stack = [iter([(member, n) for n in self.listing(member)])]
            while stack:
                try:
                    d, name = next(stack[-1])
                except StopIteration:
                    stack.pop()
                    continue
                child = self.entry(d, name)
                if child is not None:
                    stack.append(iter([(child, n) for n in self.listing(child)]))

    def entry(self, d, name):
        """Record one directory entry; return its path if it is a directory to walk."""
        path = join(d, name)
        problem = name_problem(name)
        if problem:
            self.stop("%s: the name %s" % (show(path), problem))
            return None
        try:
            st = os.lstat(os_path(path))
        except OSError as e:
            if not vanished(e):
                self.note("#error", "can't tell what this is: " + describe(e), path)
            return None
        if is_link(st):
            self.link(path)
        elif stat.S_ISDIR(st.st_mode):
            if self.own_id and identity(st) == self.own_id:
                return None  # our own working folder: no row
            return path
        elif stat.S_ISREG(st.st_mode):
            self.file(path)
        return None  # pipes, sockets, devices: no row

    def file(self, path):
        if self.stops:
            return  # no snapshot will be written: don't spend the time hashing
        got = hash_file(path)
        if isinstance(got, str):
            self.body.append(("#error", got, "", "", path))
            self.errors += 1
            return
        digest, size, mtime_ns = got
        when = instant(ms_nearest(mtime_ns))
        if when is None:
            self.body.append(("#error", "modification time %d ns after 1970 can't be written "
                              "as YYYY-MM-DDTHH:MM:SS.sssZ" % mtime_ns, "", "", path))
            self.errors += 1
            return
        self.body.append(("-", digest, str(size), when, path))
        self.files.append((digest, size, path))

    def link(self, path):
        try:
            real = resolve(path)
            st = os.stat(os_path(real))
        except OSError as e:
            if broken(e):
                return  # broken: no row
            try:
                target = os.readlink(os_path(path))
            except OSError:
                target = "?"
            self.note("#error", "link to somewhere this computer can't resolve: %s (%s)"
                      % (target, describe(e)), path)
            return
        if stat.S_ISDIR(st.st_mode):
            kind = "folder"
        elif stat.S_ISREG(st.st_mode):
            kind = "file"
        else:
            return  # to a pipe, socket or device: no row
        real = true_case(real)
        if self.into_backup(real):
            return  # the target is recorded where it lies
        self.note("#error", "link to a %s outside the backup: %s" % (kind, real),
                  with_sep(path) if kind == "folder" else path)

    def into_backup(self, real):
        ids = ancestor_ids(real)
        if self.own_id and self.own_id in ids:
            return False  # into our own working folder, which gets no rows
        if any(inside(real, m) for m, _ in self.members):
            return True
        # One directory can have two real paths (macOS firmlinks: /Users and
        # /System/Volumes/Data/Users), so compare identities too.
        return any(i in self.member_ids for i in ids)


def member_dirs(args):
    members = []
    for arg in args:
        try:
            real = resolve(arg)
            st = os.stat(os_path(real))
        except OSError as e:
            raise Refuse("member directory %s: %s" % (show(arg), describe(e)))
        if not stat.S_ISDIR(st.st_mode):
            raise Refuse("member directory %s is not a directory" % show(arg))
        real = true_case(real)
        problem = name_problem(real)
        if problem:
            raise Refuse("member directory %s: its path %s" % (show(real), problem))
        members.append((real, identity(st)))
    for i, (a, _) in enumerate(members):
        above = ancestor_ids(a)
        for j, (b, b_id) in enumerate(members):
            if i != j and (inside(a, b) or (b_id and b_id in above)):
                raise Refuse("member directory %s is %s %s, so its files would turn up under "
                             "both" % (show(a), "the same as" if a == b else "inside", show(b)))
    return members


# ---------------------------------------------------------------------------- the snapshot


def line(kind, c2="", c3="", c4="", c5=""):
    # Canonical form: column 1 unpadded; 2 padded right to 64 code points, 3 left to 12,
    # 4 right to 24; the last never padded.
    return "%s\t%s\t%s\t%s\t%s\n" % (kind, c2.ljust(64), c3.rjust(12), c4.ljust(24), c5)


def note_line(kind, c2, c3, c4, c5):
    if kind == "-":
        return line(kind, c2, c3, c4, c5)
    return line(kind, as_text(c2), c3, c4, as_text(c5))


def render(set_name, bucket, endpoint, members, snap_name, by, start_ms, zone, walk, finish_ms):
    rows = [
        line("@S3CAB", "FORMAT", "size", "time", FORMAT_URL),
        line("@S3CAB", "SPEC", c5=SPEC_DATE),
        line("@CLIENT", "NAME", c5=CLIENT_NAME),
        line("@CLIENT", "VERSION", c5=CLIENT_VERSION),
        line("@SET", "NAME", c5=set_name),
        line("@SET", "BUCKET", c5="s3://" + bucket),
    ]
    if endpoint:
        rows.append(line("@SET", "ENDPOINT", c5=as_text(endpoint)))
    rows += [line("@SET", "DIR", c5=with_sep(m)) for m, _ in members]
    rows += [
        line("@SNAPSHOT", "NAME", c5=snap_name),
        line("@SNAPSHOT", "BY", c5=by),
        line("@SNAPSHOT", "START", c4=instant(start_ms), c5=as_text(zone)),
    ]
    rows += [note_line(*r) for r in walk.notes]
    rows += [note_line(*r) for r in walk.body]
    total = sum(size for _, size, _ in walk.files)
    rows += [
        line("@SNAPSHOT", "FILES", c5=str(len(walk.files))),
        line("@SNAPSHOT", "SIZE", c5="%d (%s)" % (total, readable_size(total))),
        line("@SNAPSHOT", "FINISH", c4=instant(finish_ms), c5=duration(finish_ms - start_ms)),
        ".\n",
    ]
    return "".join(rows).encode("utf-8")  # strict: a lone surrogate here is a bug, not data


def gzip_bytes(raw):
    buf = io.BytesIO()
    # No file name and no time in the header, and one stream.
    with gzip.GzipFile(filename="", mode="wb", fileobj=buf, mtime=0) as gz:
        gz.write(raw)
    return buf.getvalue()


def check_snapshot(gz, set_dirs):
    """Read the snapshot back as a reader would, and raise rather than upload one a reader
    would refuse, whole or a path at a time."""

    def need(ok, why):
        if not ok:
            raise RuntimeError("refusing to upload a snapshot a reader would refuse: " + why)

    text = gzip.decompress(gz).decode("utf-8")
    need(not text.startswith("\ufeff"), "BOM")
    lines = text.split("\n")
    need(lines[-1] == "" and lines[-2] == ".", "the file doesn't end with the . line")
    rows = [l.split("\t") for l in lines[:-2]]
    need(all(len(r) == 5 for r in rows), "a line without five fields")
    heading = [trim(f) for f in rows[0][:4]] + [rows[0][4]]
    need(heading == ["@S3CAB", "FORMAT", "size", "time", FORMAT_URL], "heading row")
    known = {"-", "#excluded", "#error", "@S3CAB", "@CLIENT", "@SET", "@SNAPSHOT"}
    counts = {}
    paths = set()
    files = set()
    for r in rows[1:]:
        kind = trim(r[0])
        need(kind in known, "unknown type %r" % kind)
        if kind.startswith("@"):
            prop = (kind, trim(r[1]))
            counts[prop] = counts.get(prop, 0) + 1
            continue
        path = r[4]
        need(not any(c in path for c in "\t\r\n"), "tab, CR or LF in a path")
        need(path not in paths, "path in two rows: %r" % path)
        paths.add(path)
        need(any(path.startswith(d) and len(path) > len(d) for d in set_dirs),
             "path not strictly inside a @SET DIR: %r" % path)
        if kind == "-":
            need(HASH_RE.match(trim(r[1])), "hash")
            need(trim(r[2]).isdigit() and trim(r[2]).isascii(), "size")
            need(INSTANT_RE.match(trim(r[3])), "time")
            rest = [d for d in set_dirs if path.startswith(d)]
            for seg in path[len(max(rest, key=len)):].split(SEP):
                need(seg not in ("", ".", ".."), "bad segment in %r" % path)
            files.add(path)
    for p in files:
        parent = os.path.dirname(p)
        while parent and parent != os.path.dirname(parent):
            need(parent not in files, "file row runs through another: %r" % p)
            parent = os.path.dirname(parent)
    for prop in (("@S3CAB", "SPEC"), ("@CLIENT", "NAME"), ("@CLIENT", "VERSION")):
        need(counts.get(prop) == 1, "not exactly one %s %s" % prop)
    need(trim(rows[-1][0]) == "@SNAPSHOT" and trim(rows[-1][1]) == "FINISH", "FINISH last")


# ---------------------------------------------------------------------------- the bucket


def b64sha256(data):
    return base64.b64encode(hashlib.sha256(data).digest()).decode("ascii")


def http_status(e):
    return e.response.get("ResponseMetadata", {}).get("HTTPStatusCode")


def _add_if_none_match(params, **kwargs):
    params["headers"]["If-None-Match"] = "*"


class Bucket:
    def __init__(self, name):
        self.name = name
        region = os.environ.get("AWS_REGION") or os.environ.get("AWS_DEFAULT_REGION")
        retries = {"retries": {"mode": "standard", "max_attempts": 5}}
        try:
            # boto3 1.36+ otherwise adds checksums of its own (and aws-chunked) to requests
            config = Config(request_checksum_calculation="when_required",
                            response_checksum_validation="when_required", **retries)
        except TypeError:
            config = Config(**retries)
        self.s3 = boto3.session.Session(region_name=region).client("s3", config=config)
        self.endpoint = None
        if os.environ.get("AWS_ENDPOINT_URL_S3") or os.environ.get("AWS_ENDPOINT_URL"):
            self.endpoint = self.s3.meta.endpoint_url
        model = self.s3.meta.service_model.operation_model("PutObject").input_shape.members
        self.native_if_none_match = "IfNoneMatch" in model
        if not self.native_if_none_match:  # boto3 1.34 has no IfNoneMatch parameter
            for op in ("PutObject", "CompleteMultipartUpload"):
                self.s3.meta.events.register("before-call.s3.%s" % op, _add_if_none_match)

    def exists(self, key):
        try:
            self.s3.head_object(Bucket=self.name, Key=key)
            return True
        except ClientError as e:
            if http_status(e) == 404:
                return False
            raise

    def get(self, key):
        try:
            return self.s3.get_object(Bucket=self.name, Key=key)["Body"].read()
        except ClientError as e:
            if http_status(e) == 404:
                return None
            raise

    def keys(self, prefix):
        out = []
        for page in self.s3.get_paginator("list_objects_v2").paginate(Bucket=self.name,
                                                                      Prefix=prefix):
            out += [o["Key"] for o in page.get("Contents", [])]
        return out

    def create(self, key, body):
        """Store body at key unless the key exists: True if stored, False if it was there.
        S3 checks the bytes against x-amz-checksum-sha256 and stores nothing on a mismatch,
        and with a checksum given boto3 sends a plain body (no aws-chunked encoding)."""
        checksum = b64sha256(body)
        args = dict(Bucket=self.name, Key=key, Body=body, ChecksumSHA256=checksum)
        if self.native_if_none_match:
            args["IfNoneMatch"] = "*"
        try:
            r = self.s3.put_object(**args)
        except ClientError as e:
            if http_status(e) == 412:
                return False
            raise
        if r.get("ChecksumSHA256", checksum) != checksum:
            raise RuntimeError("S3 stored %s with checksum %s, not %s"
                               % (key, r.get("ChecksumSHA256"), checksum))
        return True

    def store_file(self, digest, size, path):
        """Store a file's bytes at objects/<digest>, checking they hash to the key before
        they become visible. True if stored, False if already there; Changed if the file
        no longer holds those bytes."""
        key = "objects/" + digest
        if size > PART_SIZE:
            return self._store_in_parts(key, digest, size, path)
        try:
            with open_file(path) as f:
                data = read_some(f, size + 1)
        except OSError as e:
            raise Changed("can't be read now: " + describe(e))
        if len(data) != size or hashlib.sha256(data).hexdigest() != digest:
            raise Changed("its content changed after it was hashed")
        return self.create(key, data)

    def _store_in_parts(self, key, digest, size, path):
        # A multipart object's stored checksum isn't the file's hash, so: S3 checks each
        # part's SHA-256; the whole file is hashed from those same bytes; and the upload is
        # completed only if that hash is the key, and aborted otherwise.
        part_size = max(PART_SIZE, -(-size // 9000))
        upload = self.s3.create_multipart_upload(Bucket=self.name, Key=key,
                                                 ChecksumAlgorithm="SHA256")
        uid = upload["UploadId"]
        completed = False
        try:
            whole = hashlib.sha256()
            parts = []
            n = 0
            try:
                with open_file(path) as f:
                    while True:
                        data = read_some(f, part_size)
                        if not data:
                            break
                        n += len(data)
                        if n > size:
                            raise Changed("it grew after it was hashed")
                        whole.update(data)
                        checksum = b64sha256(data)
                        number = len(parts) + 1
                        r = self.s3.upload_part(Bucket=self.name, Key=key, UploadId=uid,
                                                PartNumber=number, Body=data,
                                                ChecksumSHA256=checksum)
                        if r.get("ChecksumSHA256", checksum) != checksum:
                            raise RuntimeError("S3 stored part %d of %s with checksum %s"
                                               % (number, key, r.get("ChecksumSHA256")))
                        parts.append({"PartNumber": number, "ETag": r["ETag"],
                                      "ChecksumSHA256": checksum})
            except OSError as e:
                raise Changed("can't be read now: " + describe(e))
            if n != size or whole.hexdigest() != digest:
                raise Changed("its content changed after it was hashed")
            args = dict(Bucket=self.name, Key=key, UploadId=uid,
                        MultipartUpload={"Parts": parts})
            if self.native_if_none_match:
                args["IfNoneMatch"] = "*"
            try:
                self.s3.complete_multipart_upload(**args)
            except ClientError as e:
                if http_status(e) == 412:
                    return False
                raise
            completed = True
            return True
        finally:
            if not completed:
                try:
                    self.s3.abort_multipart_upload(Bucket=self.name, Key=key, UploadId=uid)
                except (ClientError, BotoCoreError) as e:
                    warn("couldn't abort the multipart upload of %s: %s" % (key, e))


# ---------------------------------------------------------------------------- holding a set


def parse_info(data):
    """snapshots/<set>.info: UTF-8, split on LF, one trailing CR stripped, each line split at
    its first '='. A key given twice with two values is unusable (None)."""
    text = data.decode("utf-8")
    if text.startswith("\ufeff"):
        text = text[1:]
    values = {}
    for ln in text.split("\n"):
        if ln.endswith("\r"):
            ln = ln[:-1]
        if "=" not in ln:
            continue
        key, value = ln.split("=", 1)
        if key in values and values[key] != value:
            value = None
        values[key] = value
    return values


def held_pair(data):
    try:
        info = parse_info(data)
    except UnicodeDecodeError:
        return None
    return info.get("OWNER"), info.get("CLAIMED")


class Claim:
    """The OWNER/CLAIMED pair this tool wrote when it claimed a set, kept beside the program."""

    def __init__(self, bucket, set_name):
        self.path = os.path.join(STATE_DIR, "bucket-" + bucket, "set-" + set_name + ".claim")

    def load(self):
        try:
            with open(self.path, "rb") as f:
                info = parse_info(f.read())
        except (OSError, UnicodeDecodeError):
            return None
        if info.get("OWNER") is None or info.get("CLAIMED") is None:
            return None
        return info["OWNER"], info["CLAIMED"]

    def save(self, pair):
        os.makedirs(os.path.dirname(self.path), exist_ok=True)
        tmp = self.path + ".tmp"
        with open(tmp, "wb") as f:
            f.write(("OWNER=%s\nCLAIMED=%s\n" % pair).encode("utf-8"))
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, self.path)

    def forget(self):
        try:
            os.remove(self.path)
        except FileNotFoundError:
            pass


def hold(bucket, set_name, claim):
    """Make sure this machine holds the set, claiming it if it is new; return the pair."""
    key = "snapshots/%s.info" % set_name
    kept = claim.load()
    data = bucket.get(key)
    if data is not None:
        pair = held_pair(data)
        if kept is not None and pair == kept:
            return kept
        raise Refuse("set %r is held by %r (claimed %r), not by this machine's kept claim %r; "
                     "this tool doesn't take sets over" % ((set_name,) + (pair or (None, None))
                                                           + (kept,)))
    if bucket.keys("snapshots/%s/" % set_name):
        raise Refuse("set %r already has snapshots but no snapshots/%s.info; taking it over "
                     "must be asked for, which this tool doesn't offer" % (set_name, set_name))
    now = instant(ms_down(time.time_ns()))
    pair = (who(), now)
    claim.save(pair)  # kept before the PUT, so a lost reply can't lock the holder out
    body = ("OWNER=%s\nCLAIMED=%s\nCREATED=%s\n" % (pair[0], now, now)).encode("utf-8")
    if not bucket.create(key, body):
        current = bucket.get(key)
        if current is None or held_pair(current) != pair:
            claim.forget()
            raise Refuse("another claim of set %r got there first" % set_name)
    log("claimed set %r as %s at %s" % (set_name, pair[0], now))
    return pair


def check_holder(bucket, set_name, pair):
    data = bucket.get("snapshots/%s.info" % set_name)
    if data is None:
        raise Refuse("snapshots/%s.info has gone, so this machine no longer holds the set"
                     % set_name)
    current = held_pair(data)
    if current != pair:
        raise Refuse("set %r was taken over: .info names %r, not the kept %r"
                     % (set_name, current, pair))


def keep_local(path, data):
    """Keep a copy of the snapshot, never over an existing one."""
    os.makedirs(os.path.dirname(path), exist_ok=True)
    if os.path.lexists(path):
        raise Refuse("a snapshot named %s already exists locally" % show(path))
    tmp = "%s.%d.partial" % (path, os.getpid())
    with open(tmp, "xb") as f:
        f.write(data)
        f.flush()
        os.fsync(f.fileno())
    try:
        if WINDOWS:
            os.rename(tmp, path)  # refuses an existing target on Windows
        else:
            os.link(tmp, path)  # os.rename would silently replace one on Linux and macOS
            os.remove(tmp)
    except FileExistsError:
        os.remove(tmp)
        raise Refuse("a snapshot named %s already exists locally" % show(path))


# ---------------------------------------------------------------------------- the run


def backup(bucket_name, set_name, dirs, t0):
    if not SET_RE.match(set_name):
        raise Refuse("a set's name is lowercase letters, digits and hyphens, not %r" % set_name)
    if not bucket_name or "/" in bucket_name:
        raise Refuse("%r is not a bucket name" % bucket_name)
    start_ms = ms_down(t0)
    local = time.localtime(t0 // 1000000000)
    snap_name = time.strftime("%Y-%m-%dT%H%M", local)
    zone = zone_name(local)
    by = who()

    members = member_dirs(dirs)
    bucket = Bucket(bucket_name)
    claim = Claim(bucket_name, set_name)
    pair = hold(bucket, set_name, claim)

    snap_key = "snapshots/%s/%s.tsv.gz" % (set_name, snap_name)
    local_copy = os.path.join(STATE_DIR, "bucket-" + bucket_name, "set-" + set_name,
                              snap_name + ".tsv.gz")
    names = [k.rsplit("/", 1)[1] for k in bucket.keys("snapshots/%s/" % set_name)]
    names = [n for n in names if SNAPSHOT_KEY_RE.match(n)]
    if snap_name + ".tsv.gz" in names or os.path.lexists(local_copy):
        raise Refuse("set %r already has a snapshot named %s: a second one in the same minute "
                     "is refused" % (set_name, snap_name))
    if names and max(names) > snap_name + ".tsv.gz":
        warn("warning: %s sorts before the existing %s (the clock went back), so it won't be "
             "taken as the latest" % (snap_name, max(names)))

    log("walking %s" % ", ".join(show(m) for m, _ in members))
    walk = Walk(members)
    walk.run()
    if walk.stops:
        raise Refuse("can't back this set up:\n  " + "\n  ".join(walk.stops))
    finish_ms = ms_up(time.time_ns())
    raw = render(set_name, bucket_name, bucket.endpoint, members, snap_name, by, start_ms, zone,
                 walk, finish_ms)
    gz = gzip_bytes(raw)
    check_snapshot(gz, [with_sep(m) for m, _ in members])

    # Objects first ...
    by_hash = {}
    for digest, size, path in walk.files:
        by_hash.setdefault(digest, []).append((size, path))
    stored = present = 0
    for digest, sources in by_hash.items():
        if bucket.exists("objects/" + digest):
            present += 1  # counted as stored, without downloading it to check
            continue
        why = []
        for size, path in sources:
            try:
                if bucket.store_file(digest, size, path):
                    stored += 1
                else:
                    present += 1
                break
            except Changed as e:
                why.append("%s %s" % (show(path), e))
        else:
            raise Refuse("objects/%s couldn't be stored (%s); the snapshot names it, so it "
                         "isn't uploaded" % (digest, "; ".join(why)))
    log("objects: %d uploaded, %d already stored" % (stored, present))

    # ... the snapshot last, by its holder only, never over another.
    check_holder(bucket, set_name, pair)
    if not bucket.create(snap_key, gz):
        if bucket.get(snap_key) != gz:
            raise Refuse("%s already exists with different bytes; refusing to overwrite it"
                         % snap_key)
        log("%s was already uploaded" % snap_key)
    total = sum(size for _, size, _ in walk.files)
    log("uploaded %s: %d files, %s" % (snap_key, len(walk.files), readable_size(total)))
    try:
        keep_local(local_copy, gz)  # the local copy is the uploaded snapshot, byte for byte
    except (Refuse, OSError) as e:
        warn("warning: the snapshot is uploaded, but no local copy was kept: %s" % e)
    if walk.errors:
        for kind, text, _, _, path in walk.notes + walk.body:
            if kind == "#error":
                warn("#error %s: %s" % (show(path), as_text(text)))
        warn("%d #error row(s): not everything was backed up" % walk.errors)
        return 1
    return 0


def main(argv):
    t0 = time.time_ns()  # one clock reading for the snapshot's name and START
    setup_output()
    if len(argv) < 4:
        warn("usage: python s3cab-backup.py <bucket> <set> <dir>...")
        return 2
    try:
        return backup(argv[1], argv[2], argv[3:], t0)
    except Refuse as e:
        warn("stopped, no snapshot uploaded: %s" % e)
    except (ClientError, BotoCoreError) as e:
        warn("stopped, snapshot not confirmed uploaded: %s" % e)
    except KeyboardInterrupt:
        warn("interrupted, snapshot not confirmed uploaded")
    except Exception:
        traceback.print_exc()
        warn("stopped by the error above, snapshot not confirmed uploaded")
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv))
