#!/usr/bin/env python3
"""
s3cab-backup.py -- an independent writer of the s3cab repository format.

    python s3cab-backup.py [--take-over] <bucket> <set> <dir>...

Written from the format specification alone (format.md, the spec of 2026-10-23).
Python 3 standard library plus boto3, nothing else; meant to run unchanged on
Linux, macOS and Windows.

Correct, not fast: every file is read and hashed on every run, one at a time,
and nothing is cached between runs except what the spec says a tool keeps: the
OWNER/CLAIMED pair it wrote when it claimed a set, which lives in
s3cab-backup.state.json beside this program.

Exit status: 0 when the snapshot was uploaded and holds no #error row; 1 when
the run stopped (nothing uploaded) or the snapshot was uploaded with #error
rows; 2 when this program found a fault in its own output and refused to
upload it.
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
import zlib
from decimal import Decimal, ROUND_HALF_UP

import boto3
import botocore
from botocore.config import Config
from botocore.exceptions import ClientError

# --------------------------------------------------------------------------
# Constants fixed by the spec
# --------------------------------------------------------------------------

SPEC_DATE = "2026-10-23"
CLIENT_NAME = "s3cab-backup"
CLIENT_VERSION = "0.1.0"
FORMAT_URL = "https://s3cab.plantegral.com/guide/format"
HEADING = ("@S3CAB", "FORMAT", "size", "time", FORMAT_URL)

SET_NAME_RE = re.compile(r"[a-z0-9]+(-[a-z0-9]+)*")
SNAPSHOT_NAME_RE = re.compile(r"\d{4}-\d{2}-\d{2}T\d{4}")
HASH_RE = re.compile(r"[0-9a-f]{64}")
INSTANT_RE = re.compile(r"(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{3})Z")

# The trim set for leading fields: JavaScript's trim() set, exactly.
TRIM_CHARS = (
    "\t\n\v\f\r"
    " \u00a0\u1680" + "".join(chr(c) for c in range(0x2000, 0x200B)) + "\u202f\u205f\u3000"
    "\u2028\u2029\ufeff"
)

KNOWN_TYPES = {"-", "#error", "#excluded", "@S3CAB", "@CLIENT", "@SET", "@SNAPSHOT"}

WINDOWS = os.name == "nt"
SEP = "\\" if WINDOWS else "/"
EXT = "\\\\?\\"            # \\?\
EXT_UNC = "\\\\?\\UNC\\"   # \\?\UNC\

CHUNK = 1024 * 1024

STATE_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "s3cab-backup.state.json")


class Stop(Exception):
    """The run stops without writing a snapshot; the message says why."""


# --------------------------------------------------------------------------
# Console
# --------------------------------------------------------------------------

def _reconfigure_streams():
    # Redirected output on Windows is encoded in the locale's code page before
    # Python 3.15; a path such as a combining-accent cafe.txt would raise.
    for s in (sys.stdout, sys.stderr):
        try:
            s.reconfigure(encoding="utf-8", errors="backslashreplace")
        except (AttributeError, ValueError):
            pass


def say(msg):
    print(msg, flush=True)


def warn(msg):
    print(msg, file=sys.stderr, flush=True)


def display_name(name):
    """A name for a message: parts with no UTF-8 form shown as U+FFFD, tab/CR/LF spelled out."""
    try:
        if WINDOWS:
            text = name.encode("utf-8", "surrogatepass").decode("utf-8", "replace")
        else:
            text = os.fsencode(name).decode("utf-8", "replace")
    except (UnicodeError, ValueError):
        text = name.encode("utf-8", "replace").decode("utf-8", "replace")
    return spell(text)


# --------------------------------------------------------------------------
# Time
# --------------------------------------------------------------------------

NS_PER_MS = 1_000_000


def ms_nearest(ns):
    """Nanoseconds to milliseconds, nearest, a tie to the later one."""
    return (ns + NS_PER_MS // 2) // NS_PER_MS


def ms_floor(ns):
    return ns // NS_PER_MS


def ms_ceil(ns):
    return -((-ns) // NS_PER_MS)


def civil_from_days(z):
    """Days since 1970-01-01 to (year, month, day), proleptic Gregorian, any sign."""
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


def days_from_civil(y, m, d):
    y -= m <= 2
    era = y // 400
    yoe = y - era * 400
    doy = (153 * (m + (-3 if m > 2 else 9)) + 2) // 5 + d - 1
    doe = yoe * 365 + yoe // 4 - yoe // 100 + doy
    return era * 146097 + doe - 719468


def instant(ms):
    """The 24-character UTC form for a millisecond count since the epoch, or None
    when the year falls outside 0000..9999."""
    days, rem = divmod(ms, 86_400_000)
    y, mo, d = civil_from_days(days)
    if y < 0 or y > 9999:
        return None
    h, rem = divmod(rem, 3_600_000)
    mi, rem = divmod(rem, 60_000)
    s, msec = divmod(rem, 1000)
    return f"{y:04d}-{mo:02d}-{d:02d}T{h:02d}:{mi:02d}:{s:02d}.{msec:03d}Z"


def is_real_instant(text):
    """True when text is the 24-character form naming a day the calendar has."""
    m = INSTANT_RE.fullmatch(text)
    if not m:
        return False
    y, mo, d, h, mi, s, _ = (int(g) for g in m.groups())
    if not (1 <= mo <= 12 and 1 <= d <= 31 and h <= 23 and mi <= 59 and s <= 59):
        return False
    return civil_from_days(days_from_civil(y, mo, d)) == (y, mo, d)


def local_snapshot_name(ns):
    lt = time.localtime(ns // 1_000_000_000)
    return time.strftime("%Y-%m-%dT%H%M", lt)


def local_zone_name():
    """The best name this machine gives for its zone. Written for people only."""
    tz = os.environ.get("TZ", "")
    if tz.startswith(":"):
        tz = tz[1:]
    if tz and ("/" in tz or tz in ("UTC", "GMT")) and not tz.startswith("/"):
        return tz
    try:
        target = os.readlink("/etc/localtime")
        i = target.find("zoneinfo/")
        if i >= 0 and target[i + 9:]:
            return target[i + 9:]
    except OSError:
        pass
    try:
        with open("/etc/timezone", encoding="utf-8") as f:
            name = f.read().strip()
        if name:
            return name
    except OSError:
        pass
    if WINDOWS:
        try:
            import ctypes
            icu = ctypes.WinDLL("icu.dll")
            fn = icu.ucal_getDefaultTimeZone
            fn.restype = ctypes.c_int32
            fn.argtypes = [ctypes.c_wchar_p, ctypes.c_int32, ctypes.POINTER(ctypes.c_int32)]
            buf = ctypes.create_unicode_buffer(128)
            status = ctypes.c_int32(0)
            n = fn(buf, 128, ctypes.byref(status))
            if status.value <= 0 and n > 0:
                return buf.value[:n]
        except Exception:
            pass
    lt = time.localtime()
    off = lt.tm_gmtoff or 0
    sign = "+" if off >= 0 else "-"
    off = abs(off)
    name = (lt.tm_zone or "").strip()
    return f"{name} (UTC{sign}{off // 3600:02d}:{off % 3600 // 60:02d})".strip()


def duration_text(ms):
    s = max(ms, 0) // 1000
    if s < 60:
        return f"{s}s"
    if s < 3600:
        return f"{s // 60}m {s % 60:02d}s"
    return f"{s // 3600}h {s % 3600 // 60:02d}m"


# --------------------------------------------------------------------------
# Text
# --------------------------------------------------------------------------

def spell(s):
    """Tab, CR and LF as the Unicode Control Pictures, for any field but a file row's path."""
    return s.replace("\t", "\u2409").replace("\r", "\u240d").replace("\n", "\u240a")


def trim(s):
    return s.strip(TRIM_CHARS)


def row(c1, c2="", c3="", c4="", c5=""):
    """One canonical line: column 1 unpadded, 2 right-padded to 64, 3 left-padded
    to 12, 4 right-padded to 24 (all in code points), 5 verbatim."""
    return f"{c1}\t{c2.ljust(64)}\t{c3.rjust(12)}\t{c4.ljust(24)}\t{c5}\n"


def readable_size(n):
    if n < 1000:
        return f"{n}B"
    for k, unit in enumerate(("kB", "MB", "GB", "TB", "PB"), start=1):
        v = (Decimal(n) / (Decimal(1000) ** k)).quantize(Decimal("0.1"), rounding=ROUND_HALF_UP)
        if v < 1000 or unit == "PB":
            return f"{v}{unit}"


def has_forbidden(path):
    return "\t" in path or "\r" in path or "\n" in path


def err_text(e):
    code = errno.errorcode.get(e.errno, "") if getattr(e, "errno", None) is not None else ""
    text = e.strerror or str(e)
    win = getattr(e, "winerror", None)
    if win is not None:
        text = f"{text} (winerror {win})"
    return f"{code}: {text}" if code else text


# --------------------------------------------------------------------------
# Paths
# --------------------------------------------------------------------------

def os_path(p):
    """The form of a recorded path to hand to the operating system: on Windows
    through \\\\?\\ so a trailing dot or space, a reserved name and a long path are
    taken exactly as written."""
    if not WINDOWS or p.startswith(EXT):
        return p
    if p.startswith("\\\\"):
        return EXT_UNC + p[2:]
    return EXT + p


def plain_path(p):
    """A path Windows handed back, without its \\\\?\\ prefix."""
    if p.startswith(EXT_UNC):
        return "\\\\" + p[len(EXT_UNC):]
    if p.startswith(EXT):
        return p[len(EXT):]
    return p


def is_windows_path(p):
    if len(p) >= 3 and p[0].isascii() and p[0].isalpha() and p[1] == ":" and p[2] in "\\/":
        return True
    return len(p) >= 2 and p[0] in "\\/" and p[1] in "\\/"


def path_key(p):
    """(kind, root, segments) for comparing two real paths by whole segments:
    case-insensitive on a Windows path, exact on any other."""
    if is_windows_path(p):
        norm = p.replace("/", "\\")
        if norm[1:3] == ":\\":
            root, rest = norm[:3], norm[3:]
        else:
            root, rest = "\\\\", norm[2:]
        segs = [s for s in rest.split("\\") if s]
        return ("win", root.lower(), tuple(s.lower() for s in segs))
    return ("posix", "/", tuple(s for s in p.split("/") if s))


def is_within(child, parent, or_equal):
    if child[0] != parent[0] or child[1] != parent[1]:
        return False
    c, p = child[2], parent[2]
    if len(c) < len(p) or (len(c) == len(p) and not or_equal):
        return False
    return c[:len(p)] == p


def with_trailing_sep(p):
    return p if p.endswith(SEP) else p + SEP


def _macos_name_on_disk(path):
    """macOS: the name as the disk spells it, by getattrlist(ATTR_CMN_NAME).
    Needs only search permission on the path, where listing or opening the
    parent may be refused. None when it can't be had."""
    try:
        import ctypes
        import ctypes.util
        libc = ctypes.CDLL(ctypes.util.find_library("c"), use_errno=True)

        class AttrList(ctypes.Structure):
            _fields_ = [("bitmapcount", ctypes.c_ushort), ("reserved", ctypes.c_ushort),
                        ("commonattr", ctypes.c_uint32), ("volattr", ctypes.c_uint32),
                        ("dirattr", ctypes.c_uint32), ("fileattr", ctypes.c_uint32),
                        ("forkattr", ctypes.c_uint32)]

        ATTR_BIT_MAP_COUNT, ATTR_CMN_NAME, FSOPT_NOFOLLOW = 5, 0x00000001, 0x1
        al = AttrList(ATTR_BIT_MAP_COUNT, 0, ATTR_CMN_NAME, 0, 0, 0, 0)
        buf = ctypes.create_string_buffer(4096)
        r = libc.getattrlist(os.fsencode(path), ctypes.byref(al), buf, ctypes.sizeof(buf), FSOPT_NOFOLLOW)
        if r != 0:
            return None
        off = ctypes.c_int32.from_buffer_copy(buf.raw, 4).value
        ln = ctypes.c_uint32.from_buffer_copy(buf.raw, 8).value
        name = buf.raw[4 + off:4 + off + ln].split(b"\0", 1)[0]
        return os.fsdecode(name) or None
    except Exception:
        return None


def _macos_name_from_handle(parent, seg):
    try:
        import fcntl
        fd = os.open(os.path.join(parent, seg), os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
        try:
            buf = fcntl.fcntl(fd, fcntl.F_GETPATH, b"\0" * 1024)
        finally:
            os.close(fd)
        path = buf.split(b"\0", 1)[0].decode("utf-8", "surrogateescape")
        return path.rsplit("/", 1)[-1] or None
    except (OSError, AttributeError, ImportError):
        return None


def _fix_case_posix(resolved):
    """realpath keeps the case as typed on macOS and in a case-folding Linux
    directory; look each name up in its parent's listing instead."""
    out = []
    for seg in [s for s in resolved.split("/") if s]:
        parent = "/" + "/".join(out)
        name = seg
        try:
            names = os.listdir(parent)
        except OSError:
            names = None
        if names is None:
            if sys.platform == "darwin":
                name = (_macos_name_on_disk(os.path.join(parent, seg))
                        or _macos_name_from_handle(parent, seg) or seg)
        elif seg not in names:
            try:
                want = os.lstat(os.path.join(parent, seg))
                for n in names:
                    try:
                        if os.path.samestat(os.lstat(os.path.join(parent, n)), want):
                            name = n
                            break
                    except OSError:
                        continue
            except OSError:
                pass
        out.append(name)
    return "/" + "/".join(out)


def real_path(p):
    """The real path of p as the filesystem spells it: every link, junction,
    subst drive, short name and letter case resolved. Raises OSError (strict)
    when it can't be resolved."""
    if WINDOWS:
        q = p
        if not q.startswith(EXT):
            q = os.path.normpath(q)
            if not os.path.isabs(q):
                q = os.path.normpath(os.path.join(os.getcwd(), q))
            if not os.path.isabs(q):
                q = os.path.abspath(q)
            q = os_path(q)
        r = plain_path(os.path.realpath(q, strict=True))
        if len(r) >= 2 and r[1] == ":":
            r = r[0].upper() + r[1:]
        return r
    return _fix_case_posix(os.path.realpath(p, strict=True))


def entry_is_link(entry, st):
    """A symbolic link, or on Windows a junction (a volume mount point is one too)."""
    if entry.is_symlink():
        return True
    if WINDOWS:
        is_junction = getattr(entry, "is_junction", None)
        if is_junction is not None:
            try:
                return bool(is_junction())
            except OSError:
                pass
        tag = getattr(st, "st_reparse_tag", 0)
        return tag == getattr(stat, "IO_REPARSE_TAG_MOUNT_POINT", 0xA0000003)
    return False


OPEN_FLAGS = os.O_RDONLY
for _flag in ("O_BINARY", "O_NOFOLLOW", "O_NONBLOCK", "O_CLOEXEC", "O_NOCTTY"):
    OPEN_FLAGS |= getattr(os, _flag, 0)


# --------------------------------------------------------------------------
# Walking the member directories
# --------------------------------------------------------------------------

class Walker:
    def __init__(self, member_dirs):
        self.member_dirs = member_dirs                 # real paths, each ending in SEP
        self.member_keys = [path_key(m) for m in member_dirs]
        self.top_rows = []     # #error rows known before any file is read
        self.rows = []         # file rows, with an #error among them for a file that failed while read
        self.objects = {}      # hash -> (path, size, mtime_ns): the first path in the snapshot
        self.files = 0
        self.total = 0
        self.errors = 0

    # -- rows -------------------------------------------------------------

    def _error_top(self, message, path):
        # Column 2 is trimmed on reading, so write it trimmed: the file stays canonical.
        self.top_rows.append(("#error", trim(spell(message)), "", "", spell(path)))
        self.errors += 1
        warn(f"#error {spell(path)}: {spell(message)}")

    def _error_row(self, message, path):
        self.rows.append(("#error", trim(spell(message)), "", "", spell(path)))
        self.errors += 1
        warn(f"#error {spell(path)}: {spell(message)}")

    # -- walking -----------------------------------------------------------

    def walk_member(self, d):
        self._walk_dir(d, member=True)

    def _walk_dir(self, d, member=False):
        try:
            with os.scandir(os_path(d)) as it:
                entries = list(it)
        except FileNotFoundError as e:
            if member:
                raise Stop(f"member directory vanished: {display_name(d)}: {err_text(e)}")
            # It was there to back up when it was listed, like a file that vanishes
            # before it is read; the spec gives that an #error row, so this does too.
            self._error_top(f"directory vanished before it could be walked: {err_text(e)}", d)
            return
        except OSError as e:
            raise Stop(f"cannot list directory {display_name(d)}: {err_text(e)}")
        for entry in entries:
            self._visit(d, entry)

    def _visit(self, d, entry):
        name = entry.name
        try:
            name.encode("utf-8")
        except UnicodeEncodeError:
            raise Stop(f"name has no UTF-8 form: {display_name(d)}{display_name(name)}")
        path = d + name
        try:
            st = entry.stat(follow_symlinks=False)
        except FileNotFoundError:
            return  # vanished between being listed and its type being known
        except OSError as e:
            self._error_top(err_text(e), path)
            return
        if entry_is_link(entry, st):
            self._visit_link(path)
        elif stat.S_ISDIR(st.st_mode):
            self._walk_dir(path + SEP)
        elif stat.S_ISREG(st.st_mode):
            self._visit_file(path)
        # else: a pipe, socket, device or other special entry gets no row

    def _visit_file(self, path):
        if has_forbidden(path):
            raise Stop(f"a file's path holds a tab, CR or LF: {spell(path)}")
        try:
            fd = os.open(os_path(path), OPEN_FLAGS)
        except FileNotFoundError:
            self._error_row("vanished before it could be read", path)
            return
        except OSError as e:
            self._error_row(err_text(e), path)
            return
        try:
            try:
                st = os.fstat(fd)
                if not stat.S_ISREG(st.st_mode):
                    self._error_row("not a regular file when opened", path)
                    return
                size = st.st_size
                mtime_ns = st.st_mtime_ns
                when = instant(ms_nearest(mtime_ns))
                if when is None:
                    self._error_row("modification time outside the years 0000 to 9999", path)
                    return
                h = hashlib.sha256()
                while True:
                    chunk = os.read(fd, CHUNK)
                    if not chunk:
                        break
                    h.update(chunk)
            except OSError as e:
                self._error_row(err_text(e), path)
                return
        finally:
            os.close(fd)
        digest = h.hexdigest()
        self.rows.append(("-", digest, str(size), when, path))
        self.files += 1
        self.total += size
        self.objects.setdefault(digest, (path, size, mtime_ns))

    def _visit_link(self, path):
        try:
            target = os.readlink(os_path(path))
            target_text = spell(plain_path(target))
        except OSError as e:
            target_text = f"<target unreadable: {err_text(e)}>"
        try:
            real = real_path(path)
            tst = os.stat(os_path(real))
        except (FileNotFoundError, NotADirectoryError):
            return  # broken: nothing exists where it points
        except OSError as e:
            if e.errno == errno.ELOOP or (WINDOWS and getattr(e, "winerror", None) in (2, 3, 1921)):
                return  # broken: a loop, or Windows' spelling of not found
            self._error_top(f"link to {target_text} leads somewhere this computer can't resolve: {err_text(e)}", path)
            return
        if stat.S_ISDIR(tst.st_mode):
            kind, row_path = "a folder", path + SEP
        elif stat.S_ISREG(tst.st_mode):
            kind, row_path = "a file", path
        else:
            return  # to a pipe, socket or device
        key = path_key(real)
        if any(is_within(key, m, or_equal=True) for m in self.member_keys):
            return  # into the backup: the target is recorded where it lies
        self._error_top(f"link to {kind} outside the backup: {target_text}", row_path)


# --------------------------------------------------------------------------
# The snapshot text, and a reader's check of it before upload
# --------------------------------------------------------------------------

def build_snapshot(bucket, endpoint, set_name, member_dirs, snap_name, by, start_ns, zone, walker):
    lines = [
        row(*HEADING),
        row("@S3CAB", "SPEC", "", "", SPEC_DATE),
        row("@CLIENT", "NAME", "", "", CLIENT_NAME),
        row("@CLIENT", "VERSION", "", "", CLIENT_VERSION),
        row("@SET", "NAME", "", "", set_name),
        row("@SET", "BUCKET", "", "", f"s3://{bucket}"),
    ]
    if endpoint:
        lines.append(row("@SET", "ENDPOINT", "", "", spell(endpoint)))
    for d in member_dirs:
        lines.append(row("@SET", "DIR", "", "", spell(d)))
    lines += [
        row("@SNAPSHOT", "NAME", "", "", snap_name),
        row("@SNAPSHOT", "BY", "", "", spell(by)),
        row("@SNAPSHOT", "START", "", instant(ms_floor(start_ns)), spell(zone)),
    ]
    for r in walker.top_rows:
        lines.append(row(*r))
    for r in walker.rows:
        lines.append(row(*r))
    finish_ns = time.time_ns()
    finish = instant(ms_ceil(finish_ns))
    if finish is None:
        raise Stop("the clock is outside the years 0000 to 9999")
    lines += [
        row("@SNAPSHOT", "FILES", "", "", str(walker.files)),
        row("@SNAPSHOT", "SIZE", "", "", f"{walker.total} ({readable_size(walker.total)})"),
        row("@SNAPSHOT", "FINISH", "", finish, duration_text(ms_ceil(finish_ns) - ms_floor(start_ns))),
        ".\n",
    ]
    return "".join(lines)


def gzip_single_stream(data):
    buf = io.BytesIO()
    with gzip.GzipFile(filename="", mode="wb", fileobj=buf, mtime=0) as gz:
        gz.write(data)
    return buf.getvalue()


class SelfCheckFailed(Exception):
    pass


def self_check(gz_bytes, expected_text, member_dirs):
    """Read the snapshot back the way the spec tells a reader to, and refuse to
    upload anything a reader would refuse. A failure here is a fault in this
    program, not in the files being backed up."""
    def fail(why):
        raise SelfCheckFailed(why)

    d = zlib.decompressobj(16 + zlib.MAX_WBITS)
    raw = d.decompress(gz_bytes)
    if not d.eof or d.unused_data:
        fail("not exactly one gzip stream")
    if raw != expected_text.encode("utf-8"):
        fail("decompressed text differs from what was written")
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError as e:
        fail(f"not UTF-8: {e}")
    if text.startswith("\ufeff"):
        fail("starts with a BOM")
    if "\r" in text:
        fail("holds a CR")
    if not text.endswith("\n"):
        fail("last line unterminated")
    lines = text.split("\n")[:-1]
    if len(lines) < 2 or lines[-1] != ".":
        fail("does not end with the '.' line")

    def fields_of(line):
        f = line.split("\t", 4)
        while len(f) < 5:
            f.append("")
        return [trim(x) for x in f[:4]] + [f[4]]

    if tuple(fields_of(lines[0])) != HEADING:
        fail("first line is not the heading row")
    dir_keys = [path_key(d) for d in member_dirs]
    seen = {}
    file_paths = []
    counts = {"files": 0, "total": 0}
    props = {}
    for n, line in enumerate(lines[:-1], start=1):
        f = fields_of(line)
        if row(*f) != line + "\n":
            fail(f"line {n} is not in canonical form")
        typ = f[0]
        if typ not in KNOWN_TYPES:
            fail(f"line {n}: unknown type {typ!r}")
        if typ.startswith("@"):
            props.setdefault((typ, f[1]), []).append(f)
            continue
        path = f[4]
        if has_forbidden(path):
            fail(f"line {n}: path holds a tab, CR or LF")
        if path in seen:
            fail(f"line {n}: path already has a row: {path}")
        seen[path] = typ
        if typ != "-":
            continue
        if not HASH_RE.fullmatch(f[1]):
            fail(f"line {n}: bad hash")
        if not f[2].isascii() or not f[2].isdigit():
            fail(f"line {n}: bad size")
        if not is_real_instant(f[3]):
            fail(f"line {n}: bad time {f[3]!r}")
        if "\0" in path:
            fail(f"line {n}: NUL in path")
        key = path_key(path)
        if not key[2] or any(s in (".", "..") for s in key[2]):
            fail(f"line {n}: bad path segment in {path}")
        windows = key[0] == "win"
        if windows:
            if not is_windows_path(path):
                fail(f"line {n}: not absolute")
        elif not path.startswith("/") or path.startswith("//"):
            fail(f"line {n}: not an absolute POSIX path with one leading slash")
        if any(is_within(key, dk, or_equal=True) and key[2] == dk[2] for dk in dir_keys):
            fail(f"line {n}: a file row names a DIR itself: {path}")
        if not any(is_within(key, dk, or_equal=False) for dk in dir_keys):
            fail(f"line {n}: path under no @SET DIR: {path}")
        file_paths.append(path)
        counts["files"] += 1
        counts["total"] += int(f[2])
    # one path running through another as a folder
    folders = set()
    for p in file_paths:
        sep = "\\" if is_windows_path(p) else "/"
        parts = p.split(sep)
        for i in range(1, len(parts)):
            folders.add(sep.join(parts[:i]))
    for p in file_paths:
        if p in folders:
            fail(f"a file row's path runs through another's: {p}")
    for key in (("@S3CAB", "SPEC"), ("@CLIENT", "NAME"), ("@CLIENT", "VERSION")):
        if len(props.get(key, [])) != 1:
            fail(f"not exactly one {key[0]} {key[1]} row")
    if not props.get(("@SET", "DIR")):
        fail("no @SET DIR row")
    if props.get(("@SNAPSHOT", "FILES"), [[None] * 5])[0][4] != str(counts["files"]):
        fail("@SNAPSHOT FILES disagrees with the file rows")
    size_value = props.get(("@SNAPSHOT", "SIZE"), [[None] * 5])[0][4] or ""
    if size_value.split(" ")[0] != str(counts["total"]):
        fail("@SNAPSHOT SIZE disagrees with the size column")
    return counts


# --------------------------------------------------------------------------
# S3
# --------------------------------------------------------------------------

def make_client(endpoint):
    region = os.environ.get("AWS_REGION") or os.environ.get("AWS_DEFAULT_REGION") or "us-east-1"
    config = Config(
        retries={"max_attempts": 3, "mode": "standard"},
        connect_timeout=10,
        read_timeout=30,
    )
    kwargs = {"region_name": region, "config": config}
    if endpoint:
        kwargs["endpoint_url"] = endpoint
    return boto3.client("s3", **kwargs)


def error_code(e):
    return e.response.get("Error", {}).get("Code", "")


def status_code(e):
    return e.response.get("ResponseMetadata", {}).get("HTTPStatusCode")


class S3Repo:
    def __init__(self, bucket, endpoint):
        self.bucket = bucket
        self.endpoint = endpoint
        self.s3 = make_client(endpoint)
        self.aws = not endpoint  # ask AWS, and no other provider, for SSE

    def _put_kwargs(self, key, body, checksum_b64):
        kw = {"Bucket": self.bucket, "Key": key, "Body": body, "IfNoneMatch": "*", "ChecksumSHA256": checksum_b64}
        if self.aws:
            kw["ServerSideEncryption"] = "AES256"
        return kw

    def list_keys(self, prefix, delimiter=None):
        kwargs = {"Bucket": self.bucket, "Prefix": prefix}
        if delimiter:
            kwargs["Delimiter"] = delimiter
        paginator = self.s3.get_paginator("list_objects_v2")
        for page in paginator.paginate(**kwargs):
            for obj in page.get("Contents", []):
                yield obj["Key"]

    def object_hashes(self):
        """Every hash stored under objects/, on the bucket's word."""
        hashes = set()
        for key in self.list_keys("objects/", delimiter="/"):
            name = key[len("objects/"):]
            if HASH_RE.fullmatch(name):
                hashes.add(name)
        return hashes

    def snapshot_names(self, set_name):
        """Names of the snapshots directly under snapshots/<set>/."""
        prefix = f"snapshots/{set_name}/"
        names = []
        for key in self.list_keys(prefix, delimiter="/"):
            name = key[len(prefix):]
            if name.endswith(".tsv.gz") and SNAPSHOT_NAME_RE.fullmatch(name[:-len(".tsv.gz")]):
                names.append(name[:-len(".tsv.gz")])
        return names

    def get(self, key):
        """(bytes, etag) or (None, None) when the key is missing."""
        try:
            r = self.s3.get_object(Bucket=self.bucket, Key=key)
        except ClientError as e:
            if status_code(e) == 404 and error_code(e) in ("NoSuchKey", "NotFound", "404"):
                return None, None
            raise
        return r["Body"].read(), r.get("ETag")

    def put_new(self, key, data):
        """Conditional PUT of bytes; True when stored, False when the key already exists (412)."""
        digest = base64.b64encode(hashlib.sha256(data).digest()).decode("ascii")
        try:
            self.s3.put_object(**self._put_kwargs(key, data, digest))
        except ClientError as e:
            if status_code(e) == 412:
                return False
            raise
        return True

    def put_over(self, key, data, etag):
        """Rewrite an existing key, only if it is still the one read (If-Match)."""
        digest = base64.b64encode(hashlib.sha256(data).digest()).decode("ascii")
        kw = self._put_kwargs(key, data, digest)
        del kw["IfNoneMatch"]
        if etag:
            kw["IfMatch"] = etag
        try:
            self.s3.put_object(**kw)
        except ClientError as e:
            if status_code(e) == 412:
                return False
            raise
        return True

    def delete(self, key):
        self.s3.delete_object(Bucket=self.bucket, Key=key)


class HashingReader:
    """A file-like body that hashes what is read through it, so the digest is of
    the bytes actually sent. A seek back to the start restarts the hash, since
    boto3 reads the body more than once; a seek elsewhere invalidates it."""

    def __init__(self, f):
        self._f = f
        self._h = hashlib.sha256()
        self._hashed = 0
        self.valid = True

    def read(self, n=-1):
        data = self._f.read(n)
        if self.valid:
            self._h.update(data)
            self._hashed += len(data)
        return data

    def seek(self, offset, whence=0):
        pos = self._f.seek(offset, whence)
        if pos == 0:
            self._h = hashlib.sha256()
            self._hashed = 0
            self.valid = True
        elif pos != self._hashed:
            self.valid = False
        return pos

    def tell(self):
        return self._f.tell()

    def hexdigest(self):
        return self._h.hexdigest() if self.valid else None

    def __getattr__(self, name):
        return getattr(self._f, name)


# --------------------------------------------------------------------------
# Who holds the set
# --------------------------------------------------------------------------

def load_state():
    try:
        with open(STATE_PATH, "rb") as f:
            state = json.loads(f.read().decode("utf-8"))
        if isinstance(state, dict):
            return state
    except (OSError, ValueError):
        pass
    return {}


def save_state(state):
    data = json.dumps(state, indent=2, sort_keys=True).encode("utf-8") + b"\n"
    tmp = STATE_PATH + ".tmp"
    with open(tmp, "wb") as f:
        f.write(data)
    os.replace(tmp, STATE_PATH)


def parse_info(data):
    """The .info file's own rule: UTF-8, split on LF, one trailing CR stripped,
    split at the first '=', last repeated key wins; lines with no '=' skipped."""
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError:
        return None
    info = {}
    for line in text.split("\n"):
        if line.endswith("\r"):
            line = line[:-1]
        if "=" not in line:
            continue
        k, v = line.split("=", 1)
        info[k] = v
    return info


def info_text(owner, claimed, created):
    return f"OWNER={owner}\nCLAIMED={claimed}\nCREATED={created}\n".encode("utf-8")


def ensure_holder(repo, set_name, snap_name, by, now, take_over, state):
    """Claim a new set, or check that this program is the set's holder. Also
    refuses a second snapshot of the set in the same minute."""
    key = f"snapshots/{set_name}.info"
    state_key = f"s3://{repo.bucket}/{set_name}"
    claims = state.setdefault("claims", {})
    kept = claims.get(state_key)

    names = repo.snapshot_names(set_name)
    if snap_name in names:
        raise Stop(f"snapshots/{set_name}/{snap_name}.tsv.gz already exists: a second snapshot of a set in the same minute is refused")

    data, etag = repo.get(key)
    if data is None:
        if names and not take_over:
            raise Stop(f"set {set_name!r} has snapshots but no snapshots/{set_name}.info, so no holder; run with --take-over to take it over")
        pair = {"OWNER": by, "CLAIMED": now}
        if repo.put_new(key, info_text(by, now, now)):
            claims[state_key] = pair
            save_state(state)
            say(f"claimed set {set_name!r}: OWNER={by} CLAIMED={now}" + (" (taken over: no .info was there)" if names else ""))
            return
        data, etag = repo.get(key)
        if data is None:
            raise Stop(f"snapshots/{set_name}.info appeared and vanished while claiming; try again")

    info = parse_info(data)
    if info is None:
        raise Stop(f"snapshots/{set_name}.info is not UTF-8")
    owner, claimed = info.get("OWNER"), info.get("CLAIMED")
    if kept and kept.get("OWNER") == owner and kept.get("CLAIMED") == claimed:
        say(f"set {set_name!r} is held by this program: OWNER={owner} CLAIMED={claimed}")
        return
    if kept:
        del claims[state_key]  # it can never match again
        save_state(state)
    if not take_over:
        raise Stop(f"set {set_name!r} is held by OWNER={owner!r} CLAIMED={claimed!r}, not by this program; run with --take-over to take it over")
    created = info.get("CREATED") or now
    if not repo.put_over(key, info_text(by, now, created), etag):
        raise Stop(f"snapshots/{set_name}.info changed while taking the set over; try again")
    claims[state_key] = {"OWNER": by, "CLAIMED": now}
    save_state(state)
    say(f"took over set {set_name!r}: OWNER={by} CLAIMED={now} CREATED={created}")


def check_holder(repo, set_name, state):
    """Immediately before the snapshot's upload: the .info must still name the pair we kept."""
    key = f"snapshots/{set_name}.info"
    kept = state.get("claims", {}).get(f"s3://{repo.bucket}/{set_name}")
    if not kept:
        raise Stop("no OWNER/CLAIMED pair is kept for this set")
    data, _ = repo.get(key)
    if data is None:
        raise Stop(f"snapshots/{set_name}.info is gone: the set has no holder, so the snapshot is not uploaded")
    info = parse_info(data) or {}
    if info.get("OWNER") != kept["OWNER"] or info.get("CLAIMED") != kept["CLAIMED"]:
        raise Stop(f"set {set_name!r} is now held by OWNER={info.get('OWNER')!r} CLAIMED={info.get('CLAIMED')!r}; the snapshot is not uploaded")


# --------------------------------------------------------------------------
# Uploading
# --------------------------------------------------------------------------

def upload_objects(repo, objects):
    """Store every object the snapshot names. Returns a list of (path, why) for
    content that could not be stored; the snapshot must not be uploaded then."""
    stored = repo.object_hashes()
    failures = []
    uploaded = skipped = 0
    for digest, (path, size, mtime_ns) in objects.items():
        key = f"objects/{digest}"
        if digest in stored:
            skipped += 1
            continue
        try:
            st = os.stat(os_path(path), follow_symlinks=False)
        except OSError as e:
            failures.append((path, f"could not be checked before upload: {err_text(e)}"))
            continue
        if not stat.S_ISREG(st.st_mode) or st.st_size != size or st.st_mtime_ns != mtime_ns:
            failures.append((path, "size or modification time changed since it was hashed"))
            continue
        checksum = base64.b64encode(bytes.fromhex(digest)).decode("ascii")
        try:
            fd = os.open(os_path(path), OPEN_FLAGS)
        except OSError as e:
            failures.append((path, f"could not be opened for upload: {err_text(e)}"))
            continue
        try:
            with open(fd, "rb", closefd=True) as f:
                reader = HashingReader(f)
                try:
                    repo.s3.put_object(**repo._put_kwargs(key, reader, checksum))
                except ClientError as e:
                    if status_code(e) == 412:
                        skipped += 1  # already stored, on the bucket's word
                        continue
                    if error_code(e) == "BadDigest":
                        failures.append((path, "content changed while it was being sent (the store refused the bytes)"))
                        continue
                    raise
        except OSError as e:
            failures.append((path, f"could not be read for upload: {err_text(e)}"))
            continue
        sent = reader.hexdigest()
        if sent != digest:
            # The store checked the bytes against the key itself, so this should
            # not happen on AWS; on a store that didn't, leave nothing under the key.
            repo.delete(key)
            failures.append((path, f"bytes sent hashed to {sent}, not to the key; removed"))
            continue
        uploaded += 1
        say(f"stored {key} ({size} bytes) from {spell(path)}")
    say(f"objects: {len(objects)} unique, {uploaded} uploaded, {skipped} already stored, {len(failures)} failed")
    return failures


def upload_snapshot(repo, set_name, snap_name, gz_bytes):
    key = f"snapshots/{set_name}/{snap_name}.tsv.gz"
    if repo.put_new(key, gz_bytes):
        say(f"uploaded {key} ({len(gz_bytes)} bytes)")
        return
    existing, _ = repo.get(key)
    if existing == gz_bytes:
        say(f"{key} is already there with the same bytes")
        return
    raise Stop(f"{key} already exists with different bytes: refusing to overwrite a snapshot")


# --------------------------------------------------------------------------
# Main
# --------------------------------------------------------------------------

def usage():
    warn("usage: python s3cab-backup.py [--take-over] <bucket> <set> <dir>...")
    return 2


def resolve_members(dirs):
    """Each member directory's real path, ending in a separator; stops on a
    missing one, a non-directory, or two that are nested or the same."""
    members = []
    stats = []
    for d in dirs:
        try:
            real = real_path(d)
            st = os.stat(os_path(real))
        except OSError as e:
            raise Stop(f"member directory {display_name(d)} does not exist or can't be resolved: {err_text(e)}")
        if not stat.S_ISDIR(st.st_mode):
            raise Stop(f"member directory {display_name(d)} is not a directory")
        members.append(with_trailing_sep(real))
        stats.append(st)
    keys = [path_key(m) for m in members]
    for i in range(len(members)):
        for j in range(len(members)):
            if i == j:
                continue
            if is_within(keys[i], keys[j], or_equal=True) or os.path.samestat(stats[i], stats[j]):
                if keys[i] == keys[j] or os.path.samestat(stats[i], stats[j]):
                    raise Stop(f"member directories {dirs[i]!r} and {dirs[j]!r} are the same directory: {members[i]}")
                raise Stop(f"member directory {members[i]} lies inside {members[j]}: the same files would turn up twice")
    return members


def main(argv):
    _reconfigure_streams()
    args = list(argv)
    take_over = False
    if args and args[0] == "--take-over":
        take_over = True
        args = args[1:]
    if len(args) < 3:
        return usage()
    bucket, set_name, dirs = args[0], args[1], args[2:]
    if not SET_NAME_RE.fullmatch(set_name):
        raise Stop(f"set name {set_name!r} is not letters a-z and digits with single hyphens between them")
    endpoint = os.environ.get("AWS_ENDPOINT_URL_S3") or os.environ.get("AWS_ENDPOINT_URL") or ""

    start_ns = time.time_ns()                   # one clock reading: START and the name both come from it
    snap_name = local_snapshot_name(start_ns)
    start = instant(ms_floor(start_ns))
    if start is None:
        raise Stop("the clock is outside the years 0000 to 9999")
    zone = local_zone_name()
    try:
        user = getpass.getuser()
    except Exception:
        user = "unknown"
    by = f"{user}@{socket.gethostname()}"
    say(f"set {set_name!r} in s3://{bucket}: snapshot {snap_name}, START {start} {zone}, BY {by}")

    members = resolve_members(dirs)
    for m in members:
        say(f"@SET DIR {spell(m)}")

    repo = S3Repo(bucket, endpoint)
    state = load_state()
    ensure_holder(repo, set_name, snap_name, by, start, take_over, state)

    walker = Walker(members)
    for m in members:
        walker.walk_member(m)
    say(f"walked: {walker.files} file rows, {walker.total} bytes, {len(walker.objects)} unique contents, {walker.errors} #error rows")

    text = build_snapshot(bucket, endpoint, set_name, members, snap_name, by, start_ns, zone, walker)
    gz_bytes = gzip_single_stream(text.encode("utf-8"))
    self_check(gz_bytes, text, members)

    failures = upload_objects(repo, walker.objects)
    if failures:
        for path, why in failures:
            warn(f"not stored: {spell(path)}: {why}")
        raise Stop(f"{len(failures)} object(s) could not be stored; the snapshot is not uploaded")

    check_holder(repo, set_name, state)
    upload_snapshot(repo, set_name, snap_name, gz_bytes)
    if walker.errors:
        warn(f"snapshot written with {walker.errors} #error row(s); exit 1")
        return 1
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv[1:]))
    except Stop as e:
        print(f"stopped: {e}", file=sys.stderr, flush=True)
        sys.exit(1)
    except SelfCheckFailed as e:
        print(f"refusing to upload: this program's own snapshot failed a reader's check: {e}", file=sys.stderr, flush=True)
        sys.exit(2)
    except (ClientError, botocore.exceptions.BotoCoreError) as e:
        # Any S3 failure not handled above (403, NoSuchBucket, a 5xx after retries,
        # a dropped connection): nothing further is written, and the snapshot stays unpublished.
        print(f"stopped: S3 request failed: {e}", file=sys.stderr, flush=True)
        sys.exit(1)
