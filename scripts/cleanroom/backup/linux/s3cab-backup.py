#!/usr/bin/env python3
"""s3cab-backup.py — an independent writer for the s3cab repository format.

    python s3cab-backup.py <bucket> <set> <dir>...

Written from the s3cab format spec of 2026-10-30 alone (format.md), using only
the Python 3 standard library and boto3.  It walks the member directories,
uploads every object the snapshot names, then the snapshot, and keeps the
set's holder pair (OWNER/CLAIMED) in s3cab-backup.state.json beside this file.

Exit status: 0 on success (no #error rows), 1 otherwise.
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
import tempfile
import time

# --------------------------------------------------------------------------
# constants

CLIENT_NAME = "s3cab-backup"          # lowercase letters, digits, hyphens
CLIENT_VERSION = "0.1.0"
SPEC_DATE = "2026-10-30"              # the date at the top of format.md
FORMAT_URL = "https://s3cab.plantegral.com/guide/format"

SEP = os.sep                          # the OS's native separator
MiB = 1024 * 1024
GiB = 1024 * MiB
# S3 takes a single PUT of up to 5 GiB; above that we must use multipart.
MULTIPART_THRESHOLD = int(os.environ.get("S3CAB_BACKUP_MULTIPART_THRESHOLD", 5 * GiB))
SPOOL_IN_MEMORY_MAX = 64 * MiB        # larger bodies are spooled to a temp file
READ_CHUNK = 1 * MiB

HASH_RE = re.compile(r"^[0-9a-f]{64}$")
SET_NAME_RE = re.compile(r"^[a-z0-9]+(-[a-z0-9]+)*$")
SNAPSHOT_KEY_RE = re.compile(r"^[0-9]{8}T[0-9]{4}\.tsv\.gz$")
INSTANT_RE = re.compile(r"^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$")
PID_RE = re.compile(r"^[1-9][0-9]*$")
WIN_DRIVE_RE = re.compile(r"^[A-Za-z]:[\\/]")
WIN_SHARE_RE = re.compile(r"^[\\/]{2}")

IO_REPARSE_TAG_MOUNT_POINT = 0xA0000003
IS_WINDOWS = sys.platform == "win32"


class Stop(Exception):
    """The run stops without writing a snapshot; the message says why."""


class Refuse(Exception):
    """The snapshot (or set) is refused by a repository rule; nothing more is written."""


# --------------------------------------------------------------------------
# small helpers: text

def spell(s):
    """Spell a tab, CR and LF out as the Unicode Control Pictures, for any
    field that may hold them (messages, @SET DIR, the path of a # row)."""
    return s.replace("\t", "\u2409").replace("\r", "\u240d").replace("\n", "\u240a")


def show(s):
    """Make a path safe to print: spell control characters out."""
    out = []
    for ch in s:
        o = ord(ch)
        if o < 0x20 or 0x7F <= o <= 0x9F or ch in "\u2028\u2029":
            out.append("\\x%02x" % o if o < 0x100 else "\\u%04x" % o)
        else:
            out.append(ch)
    return "".join(out)


def log(msg):
    print(msg, flush=True)


def err(msg):
    print(msg, file=sys.stderr, flush=True)


def canonical_line(c1, c2, c3, c4, c5):
    """One row in canonical form: col 1 unpadded, col 2 left-aligned to 64,
    col 3 right-aligned to 12, col 4 left-aligned to 24 (all in code points),
    col 5 verbatim.  LF ending."""
    return "%s\t%s\t%s\t%s\t%s\n" % (c1, c2.ljust(64), c3.rjust(12), c4.ljust(24), c5)


HEADING_LINE = canonical_line("@S3CAB", "FORMAT", "size", "time", FORMAT_URL)


def readable_size(n):
    """The readable form for @SNAPSHOT SIZE: `999B`, then one decimal place,
    rounded half up, in the smallest of kB..PB that keeps it under 1000.0."""
    if n < 1000:
        return "%dB" % n
    units = ["kB", "MB", "GB", "TB", "PB"]
    div = 1000
    for i, u in enumerate(units):
        tenths = (n * 10 + div // 2) // div      # half up, in tenths
        if tenths < 10000 or i == len(units) - 1:
            return "%d.%d%s" % (tenths // 10, tenths % 10, u)
        div *= 1000


def duration_text(ms):
    s = ms // 1000
    if s < 60:
        return "%ds" % s
    if s < 3600:
        return "%dm %02ds" % (s // 60, s % 60)
    return "%dh %02dm" % (s // 3600, (s % 3600) // 60)


# --------------------------------------------------------------------------
# small helpers: time (no datetime: it can't hold year 0000, and on Windows
# fromtimestamp raises before 1970)

def civil_from_days(z):
    """Proleptic Gregorian date for a count of days since 1970-01-01.
    (H. Hinnant's algorithm; Python's // floors, so no sign fix-up needed.)"""
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


def instant_from_ms(ms):
    """The 24-character form for a millisecond count since the epoch, or None
    when the year falls outside 0000..9999."""
    days, rem = divmod(ms, 86_400_000)
    y, mo, d = civil_from_days(days)
    if not 0 <= y <= 9999:
        return None
    h, rem = divmod(rem, 3_600_000)
    mi, rem = divmod(rem, 60_000)
    s, msec = divmod(rem, 1000)
    return "%04d-%02d-%02dT%02d:%02d:%02d.%03dZ" % (y, mo, d, h, mi, s, msec)


def ms_round_nearest(ns):
    """Round a nanosecond count to the nearest millisecond, a tie to the later."""
    return (ns + 500_000) // 1_000_000


def ms_cut_down(ns):
    return ns // 1_000_000


def ms_round_up(ns):
    return -((-ns) // 1_000_000)


def basic_instant(instant24):
    """`2026-10-27T14:02:05.123Z` -> `20261027T140205.123Z` (a lock id's form)."""
    return instant24.replace("-", "").replace(":", "")


def local_zone_name():
    """The best name we have for the local zone; free text in the format."""
    tz = os.environ.get("TZ")
    if tz:
        return tz[1:] if tz.startswith(":") else tz
    try:
        rp = os.path.realpath("/etc/localtime")
        i = rp.find("zoneinfo/")
        if i >= 0 and rp[i + 9:]:
            return rp[i + 9:]
    except OSError:
        pass
    if IS_WINDOWS:
        try:
            import ctypes
            icu = ctypes.WinDLL("icu.dll")
            buf = ctypes.create_unicode_buffer(128)
            status = ctypes.c_int(0)
            n = icu.ucal_getDefaultTimeZone(buf, 128, ctypes.byref(status))
            if status.value <= 0 and n > 0:
                return buf.value
        except Exception:
            pass
    try:
        return time.tzname[1 if time.localtime().tm_isdst > 0 else 0]
    except Exception:
        return "unknown"


# --------------------------------------------------------------------------
# small helpers: paths

def is_windows_path(p):
    return bool(WIN_DRIVE_RE.match(p) or WIN_SHARE_RE.match(p))


def split_path(p):
    """(kind, root, segments) for an absolute path, or None.  kind is 'win'
    or 'posix'; root is 'X:' / '\\\\' / '/'.  Segments are as written."""
    if WIN_DRIVE_RE.match(p):
        return ("win", p[0].upper() + ":", re.split(r"[\\/]", p[3:]) if p[3:] else [])
    if WIN_SHARE_RE.match(p):
        return ("win", "\\\\", re.split(r"[\\/]", p[2:]) if p[2:] else [])
    if p.startswith("/"):
        return ("posix", "/", p[1:].split("/") if p[1:] else [])
    return None


def os_path(rec):
    """The path handed to the OS for a recorded path.  On Windows, through
    \\\\?\\ so a trailing dot or space and a long path are taken as written."""
    if not IS_WINDOWS:
        return rec
    if rec.startswith("\\\\?\\"):
        return rec
    if rec.startswith("\\\\"):
        return "\\\\?\\UNC\\" + rec[2:]
    return "\\\\?\\" + rec


def strip_win_prefix(p):
    if p.startswith("\\\\?\\UNC\\"):
        return "\\\\" + p[8:]
    if p.startswith("\\\\?\\"):
        return p[4:]
    return p


def fix_case(rp):
    """Spell each name of an already-resolved real path as its parent's listing
    does.  realpath keeps the case as typed on macOS and in a case-insensitive
    Linux directory; the listing is what the filesystem reports."""
    parts = split_path(rp)
    if parts is None:
        return rp
    kind, root, segs = parts
    if kind == "win" and root == "\\\\":
        # a share: the server and share names aren't directory entries
        if len(segs) < 2:
            return rp
        cur = "\\\\" + segs[0] + "\\" + segs[1]
        segs = segs[2:]
    elif kind == "win":
        cur = root + "\\"
    else:
        cur = "/"
    for name in segs:
        if name == "":
            continue
        child = cur + name if cur.endswith(SEP) else cur + SEP + name
        chosen = name
        try:
            target = os.lstat(os_path(child))
            with os.scandir(os_path(cur)) as it:
                entries = list(it)
            if not any(e.name == name for e in entries):
                same = []
                for e in entries:
                    try:
                        if os.path.samestat(e.stat(follow_symlinks=False), target):
                            same.append(e.name)
                    except OSError:
                        pass
                if len(same) == 1:
                    chosen = same[0]
        except OSError:
            pass
        cur = cur + chosen if cur.endswith(SEP) else cur + SEP + chosen
    return cur


def real_directory(path_as_typed):
    """The real path of a member directory: every link, substitution and case
    resolved, the Windows drive letter uppercase, no trailing separator except
    for a root."""
    if IS_WINDOWS:
        ap = path_as_typed
        if not os.path.isabs(ap):
            ap = os.path.join(os.getcwd(), ap)
        ap = os.path.normpath(ap)              # keeps a trailing dot/space; abspath drops it
        rp = os.path.realpath(os_path(ap), strict=True)
        rp = strip_win_prefix(rp)
        if re.match(r"^[a-z]:", rp):
            rp = rp[0].upper() + rp[1:]
        if not is_windows_path(rp) or rp.startswith("\\\\?\\"):
            raise Stop("member directory %s has no drive letter and no share (%s): no path a reader accepts can name it"
                       % (show(path_as_typed), show(rp)))
    else:
        rp = os.path.realpath(path_as_typed, strict=True)
    rp = fix_case(rp)
    return rp


def with_trailing_sep(p):
    """A directory's recorded form always ends in exactly one separator."""
    return p if p.endswith(SEP) else p + SEP


def path_segments_exact(p):
    """Root plus segments, for exact comparison of two real paths of this OS."""
    parts = split_path(p)
    if parts is None:
        return None
    kind, root, segs = parts
    return (root,) + tuple(s for s in segs if s != "")


def is_within(real, member_real):
    """Is `real` the member directory or inside it, by whole segments, exactly?"""
    a = path_segments_exact(real)
    b = path_segments_exact(member_real)
    if a is None or b is None:
        return False
    return a[:len(b)] == b


def has_utf8_form(name):
    try:
        name.encode("utf-8")           # a lone surrogate (from surrogateescape or Windows) fails here
        return True
    except UnicodeEncodeError:
        return False


def name_for_people(name):
    """A name with no UTF-8 form, with U+FFFD for each part that doesn't decode."""
    if IS_WINDOWS:
        return name.encode("utf-8", "surrogatepass").decode("utf-8", "replace")
    return os.fsencode(name).decode("utf-8", "replace")


def oserror_text(ex):
    code = errno.errorcode.get(ex.errno, type(ex).__name__) if getattr(ex, "errno", None) else type(ex).__name__
    msg = ex.strerror or str(ex)
    if IS_WINDOWS and getattr(ex, "winerror", None):
        msg = "%s (winerror %d)" % (msg, ex.winerror)
    return "%s: %s" % (code, msg)


# --------------------------------------------------------------------------
# the walk

class Row:
    __slots__ = ("kind", "c2", "c3", "c4", "path")

    def __init__(self, kind, c2, c3, c4, path):
        self.kind, self.c2, self.c3, self.c4, self.path = kind, c2, c3, c4, path

    def line(self):
        return canonical_line(self.kind, self.c2, self.c3, self.c4, self.path)


class FileInfo:
    __slots__ = ("hash", "size", "mtime_ms", "rec", "osp")

    def __init__(self, h, size, mtime_ms, rec, osp):
        self.hash, self.size, self.mtime_ms, self.rec, self.osp = h, size, mtime_ms, rec, osp


def is_link_stat(st):
    if stat.S_ISLNK(st.st_mode):
        return True
    return IS_WINDOWS and getattr(st, "st_reparse_tag", 0) == IO_REPARSE_TAG_MOUNT_POINT


def link_is_broken(ex):
    if ex.errno in (errno.ENOENT, errno.ENOTDIR, errno.ELOOP):
        return True
    if IS_WINDOWS and getattr(ex, "winerror", None) in (2, 3, 1921):
        return True
    return False


class Walker:
    def __init__(self, member_reals):
        self.member_reals = member_reals          # real paths, no trailing sep (or a bare root)
        self.walk_rows = []                       # #error rows the walk finds (links out, unresolvable)
        self.file_rows = []                       # Row objects: '-' rows and hashing #error rows, in order
        self.files = []                           # FileInfo for each '-' row

    def walk_member(self, member_real):
        dir_rec = with_trailing_sep(member_real)
        self.walk_dir(dir_rec)

    def walk_dir(self, dir_rec):
        try:
            with os.scandir(os_path(dir_rec)) as it:
                entries = list(it)
        except OSError as ex:
            raise Stop("directory can't be listed: %s (%s)" % (show(dir_rec), oserror_text(ex)))
        entries.sort(key=lambda e: os.fsencode(e.name) if not IS_WINDOWS else e.name.encode("utf-16-le", "surrogatepass"))
        for e in entries:
            name = e.name
            if not has_utf8_form(name):
                raise Stop("an entry's name has no UTF-8 form: %s in %s"
                           % (show(name_for_people(name)), show(dir_rec)))
            rec = dir_rec + name
            try:
                st = e.stat(follow_symlinks=False)
            except FileNotFoundError:
                continue                      # vanished between listing and typing: no row
            except OSError as ex:
                self.walk_rows.append(Row("#error", spell(oserror_text(ex)), "", "", spell(rec)))
                continue
            if is_link_stat(st):
                row = self.link_row(rec)
                if row is not None:
                    self.walk_rows.append(row)
            elif stat.S_ISDIR(st.st_mode):
                self.walk_dir(rec + SEP)
            elif stat.S_ISREG(st.st_mode):
                if "\t" in rec or "\r" in rec or "\n" in rec:
                    raise Stop("a regular file has a tab, CR or LF in its path: %s" % show(rec))
                self.hash_file(rec)
            elif stat.S_ISFIFO(st.st_mode) or stat.S_ISSOCK(st.st_mode) or stat.S_ISCHR(st.st_mode) or stat.S_ISBLK(st.st_mode):
                continue                      # pipes, sockets and devices get no row
            else:
                self.walk_rows.append(Row("#error", "entry type couldn't be determined", "", "", spell(rec)))

    def link_row(self, rec):
        osp = os_path(rec)
        try:
            target_text = os.readlink(osp)
            if IS_WINDOWS:
                target_text = strip_win_prefix(target_text)
        except OSError:
            target_text = "?"
        try:
            real = os.path.realpath(osp, strict=True)
        except OSError as ex:
            if link_is_broken(ex):
                return None
            return Row("#error", spell("link to somewhere this computer can't resolve: %s (%s)" % (target_text, oserror_text(ex))),
                       "", "", spell(rec))
        except (ValueError, RuntimeError) as ex:
            return None                       # a loop realpath itself gives up on: broken
        if IS_WINDOWS:
            real = strip_win_prefix(real)
            if re.match(r"^[a-z]:", real):
                real = real[0].upper() + real[1:]
        try:
            tst = os.stat(os_path(real))
        except OSError as ex:
            if link_is_broken(ex):
                return None
            return Row("#error", spell("link to somewhere this computer can't resolve: %s (%s)" % (target_text, oserror_text(ex))),
                       "", "", spell(rec))
        if stat.S_ISDIR(tst.st_mode):
            kind = "folder"
        elif stat.S_ISREG(tst.st_mode):
            kind = "file"
        else:
            return None                       # to a pipe, socket or device: no row
        real_cased = fix_case(real)
        if any(is_within(real_cased, m) for m in self.member_reals):
            return None                       # into the backup: recorded where it lies
        path = rec + SEP if kind == "folder" else rec
        return Row("#error", spell("link to a %s outside the backup: %s" % (kind, target_text)), "", "", spell(path))

    def hash_file(self, rec):
        osp = os_path(rec)
        flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_BINARY", 0) | getattr(os, "O_NONBLOCK", 0)
        try:
            fd = os.open(osp, flags)
        except OSError as ex:
            self.file_rows.append(Row("#error", spell(oserror_text(ex)), "", "", spell(rec)))
            return
        try:
            with os.fdopen(fd, "rb", buffering=0) as f:
                st = os.fstat(f.fileno())
                if not stat.S_ISREG(st.st_mode):
                    self.file_rows.append(Row("#error", "no longer a regular file", "", "", spell(rec)))
                    return
                size = st.st_size
                mtime_ms = ms_round_nearest(st.st_mtime_ns)
                h = hashlib.sha256()
                n = 0
                while True:
                    chunk = f.read(READ_CHUNK)
                    if not chunk:
                        break
                    h.update(chunk)
                    n += len(chunk)
        except OSError as ex:
            self.file_rows.append(Row("#error", spell(oserror_text(ex)), "", "", spell(rec)))
            return
        if n != size:
            self.file_rows.append(Row("#error", "read returned %d bytes, size was %d" % (n, size), "", "", spell(rec)))
            return
        instant = instant_from_ms(mtime_ms)
        if instant is None:
            self.file_rows.append(Row("#error", "modification time can't be held in the 24-character form (%d ms since 1970)" % mtime_ms,
                                      "", "", spell(rec)))
            return
        self.file_rows.append(Row("-", h.hexdigest(), str(size), instant, rec))
        self.files.append(FileInfo(h.hexdigest(), size, mtime_ms, rec, osp))


# --------------------------------------------------------------------------
# the snapshot text, and a reader's-eye check of it before upload

def build_snapshot(set_name, bucket, endpoint, member_dirs, snap_name, by, start_instant, zone,
                   walk_rows, file_rows, finish_instant, duration):
    out = [HEADING_LINE,
           canonical_line("@S3CAB", "SPEC", "", "", SPEC_DATE),
           canonical_line("@CLIENT", "NAME", "", "", CLIENT_NAME),
           canonical_line("@CLIENT", "VERSION", "", "", CLIENT_VERSION),
           canonical_line("@SET", "NAME", "", "", set_name),
           canonical_line("@SET", "BUCKET", "", "", "s3://" + bucket)]
    if endpoint:
        out.append(canonical_line("@SET", "ENDPOINT", "", "", spell(endpoint)))
    for d in member_dirs:
        out.append(canonical_line("@SET", "DIR", "", "", spell(with_trailing_sep(d))))
    out.append(canonical_line("@SNAPSHOT", "NAME", "", "", snap_name))
    out.append(canonical_line("@SNAPSHOT", "BY", "", "", spell(by)))
    out.append(canonical_line("@SNAPSHOT", "START", "", start_instant, spell(zone)))
    for r in walk_rows:
        out.append(r.line())
    n_files = 0
    total = 0
    for r in file_rows:
        out.append(r.line())
        if r.kind == "-":
            n_files += 1
            total += int(r.c3)
    out.append(canonical_line("@SNAPSHOT", "FILES", "", "", str(n_files)))
    out.append(canonical_line("@SNAPSHOT", "SIZE", "", "", "%d (%s)" % (total, readable_size(total))))
    out.append(canonical_line("@SNAPSHOT", "FINISH", "", finish_instant, duration))
    out.append(".\n")
    return "".join(out)


TRIM_CHARS = ("\t\n\x0b\x0c\r \xa0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a"
              "\u202f\u205f\u3000\u2028\u2029\ufeff")


def trim(s):
    return s.strip(TRIM_CHARS)


def dir_matches(dir_text, path):
    """Does a @SET DIR (as written) hold this path, by whole segments?  Decide
    the DIR's kind from the row as written first; then ignore every separator
    it ends with; a DIR with an empty segment, a share with no server or share
    name, or one that isn't absolute matches nothing."""
    if is_windows_path(dir_text):
        d = dir_text.rstrip("\\/")
        if WIN_DRIVE_RE.match(dir_text):
            dp = ("win", dir_text[0].upper() + ":", re.split(r"[\\/]", d[3:]) if len(d) > 3 else [])
        else:
            segs = re.split(r"[\\/]", d[2:]) if len(d) > 2 else []
            if len(segs) < 2 or segs[0] == "" or segs[1] == "":
                return False                # `\\` or `\\server\`: no server or no share name
            dp = ("win", "\\\\", segs)
    elif dir_text.startswith("/"):
        d = dir_text.rstrip("/")
        dp = ("posix", "/", d[1:].split("/") if len(d) > 1 else [])
    else:
        return False                        # not an absolute path
    pp = split_path(path)
    if pp is None:
        return False
    dkind, droot, dsegs = dp
    pkind, proot, psegs = pp
    if dkind != pkind:
        return False
    if dkind == "win":
        if droot.lower() != proot.lower():
            return False
        dsegs = [s.lower() for s in dsegs]
        psegs = [s.lower() for s in psegs]
    elif droot != proot:
        return False
    if any(s == "" for s in dsegs) or any("\x00" in s for s in dsegs):
        return False
    if len(psegs) <= len(dsegs):
        return False                        # equal to the DIR, or shorter: not strictly inside
    return psegs[:len(dsegs)] == dsegs


def check_snapshot_text(text):
    """Re-read the snapshot as the spec's reader would.  Returns a list of
    problems; an empty list means a reader would accept every row."""
    problems = []
    if not text.endswith("\n"):
        return ["last line has no LF"]
    lines = text[:-1].split("\n")
    if not lines or lines[0] != HEADING_LINE[:-1]:
        problems.append("first line isn't the heading row")
    if lines[-1] != ".":
        problems.append("last line isn't `.`")
    dirs = []
    per_path = {}
    file_rows = []
    counts = {"@S3CAB SPEC": 0, "@CLIENT NAME": 0, "@CLIENT VERSION": 0}
    for i, ln in enumerate(lines[:-1]):
        if trim(ln) == "":
            problems.append("blank line %d" % (i + 1))
            continue
        fields = ln.split("\t", 4)
        while len(fields) < 5:
            fields.append("")
        t = trim(fields[0])
        if i == 0:
            continue
        if t == "-":
            file_rows.append((i + 1, trim(fields[1]), trim(fields[2]), trim(fields[3]), fields[4]))
        elif t.startswith("#"):
            if fields[4] in per_path:
                problems.append("line %d: path already in line %d" % (i + 1, per_path[fields[4]]))
            per_path[fields[4]] = i + 1
            if "\t" in fields[4] or "\r" in fields[4] or "\n" in fields[4] or split_path(fields[4]) is None:
                problems.append("line %d: # row path not absolute or holds tab/CR/LF" % (i + 1))
        elif t.startswith("@"):
            prop = trim(fields[1])
            key = t + " " + prop
            if key in counts:
                counts[key] += 1
            if key == "@SET DIR":
                dirs.append(fields[4])
            if key in ("@SNAPSHOT START", "@SNAPSHOT FINISH") and not INSTANT_RE.match(trim(fields[3])):
                problems.append("line %d: %s instant malformed" % (i + 1, key))
        else:
            problems.append("line %d: unknown type %r" % (i + 1, t))
    for k, v in counts.items():
        if v != 1:
            problems.append("%s appears %d times" % (k, v))
    accepted = []
    for (ln_no, h, size, mtime, path) in file_rows:
        bad = []
        if not HASH_RE.match(h):
            bad.append("hash")
        if not re.match(r"^[0-9]+$", size):
            bad.append("size")
        if not INSTANT_RE.match(mtime) or instant_from_ms(0) is None:
            bad.append("time")
        else:
            # a real instant: re-derive and compare
            y, mo, d = int(mtime[0:4]), int(mtime[5:7]), int(mtime[8:10])
            hh, mi, ss = int(mtime[11:13]), int(mtime[14:16]), int(mtime[17:19])
            ok = 1 <= mo <= 12 and hh <= 23 and mi <= 59 and ss <= 59
            if ok:
                leap = (y % 4 == 0 and y % 100 != 0) or y % 400 == 0
                mdays = [31, 29 if leap else 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][mo - 1]
                ok = 1 <= d <= mdays
            if not ok:
                bad.append("time")
        if any(c in path for c in "\t\r\n\x00"):
            bad.append("path chars")
        parts = split_path(path)
        if parts is None:
            bad.append("path not absolute")
        else:
            segs = parts[2]
            if any(s in ("", ".", "..") for s in segs):
                bad.append("path segments")
        if not any(dir_matches(dt, path) for dt in dirs):
            bad.append("under no @SET DIR")
        if path in per_path:
            bad.append("path also in line %d" % per_path[path])
        per_path[path] = ln_no
        if bad:
            problems.append("line %d: file row refused: %s" % (ln_no, ", ".join(bad)))
        else:
            accepted.append((ln_no, path))
    paths = {p for _, p in accepted}
    for ln_no, p in accepted:
        seps = "\\/" if is_windows_path(p) else "/"
        for j, ch in enumerate(p):
            if ch in seps and j > 0 and p[:j] in paths:
                problems.append("line %d: path runs through another file row's path %r" % (ln_no, p[:j]))
                break
    return problems


def gzip_single_stream(data):
    buf = io.BytesIO()
    with gzip.GzipFile(filename="", mode="wb", fileobj=buf, mtime=0) as gz:
        gz.write(data)
    return buf.getvalue()


# --------------------------------------------------------------------------
# the bucket

def make_client(region, endpoint):
    import boto3
    from botocore.config import Config
    kwargs = {"config": Config(retries={"mode": "standard", "max_attempts": 5},
                               connect_timeout=10, read_timeout=60)}
    if region:
        kwargs["region_name"] = region
    if endpoint:
        kwargs["endpoint_url"] = endpoint
    try:
        client = boto3.client("s3", **kwargs)
    except Exception:
        if region:
            raise
        kwargs["region_name"] = "us-east-1"
        client = boto3.client("s3", **kwargs)

    # Every PUT this tool makes is a no-overwrite PUT.  boto3 1.34 has no
    # IfNoneMatch parameter, so the header goes on in a before-call handler.
    def add_if_none_match(params, **kwargs):
        params["headers"]["If-None-Match"] = "*"
    client.meta.events.register("before-call.s3.PutObject", add_if_none_match)
    client.meta.events.register("before-call.s3.CompleteMultipartUpload", add_if_none_match)
    return client


def client_error_code(ex):
    try:
        return ex.response["Error"]["Code"], ex.response["ResponseMetadata"]["HTTPStatusCode"]
    except Exception:
        return None, None


def is_404(ex):
    code, status = client_error_code(ex)
    return status == 404 and code in ("404", "NoSuchKey", "NotFound")


def is_412(ex):
    code, status = client_error_code(ex)
    return status == 412 or code == "PreconditionFailed"


def is_bad_digest(ex):
    code, status = client_error_code(ex)
    return code in ("BadDigest", "InvalidDigest", "XAmzContentSHA256Mismatch")


class Bucket:
    def __init__(self, client, name, on_aws):
        self.s3 = client
        self.name = name
        self.on_aws = on_aws
        from botocore.exceptions import ClientError
        self.ClientError = ClientError

    def sse(self):
        return {"ServerSideEncryption": "AES256"} if self.on_aws else {}

    def head(self, key):
        try:
            return self.s3.head_object(Bucket=self.name, Key=key)
        except self.ClientError as ex:
            if is_404(ex):
                return None
            raise

    def get_bytes(self, key):
        try:
            r = self.s3.get_object(Bucket=self.name, Key=key)
        except self.ClientError as ex:
            if is_404(ex):
                return None
            raise
        return r["Body"].read()

    def put_new(self, key, body, sha256_digest=None, with_sse=True):
        """A no-overwrite PUT.  Returns 'stored', 'exists' (412)."""
        kwargs = {"Bucket": self.name, "Key": key, "Body": body}
        if sha256_digest is not None:
            kwargs["ChecksumSHA256"] = base64.b64encode(sha256_digest).decode("ascii")
        if with_sse:
            kwargs.update(self.sse())
        try:
            self.s3.put_object(**kwargs)
            return "stored"
        except self.ClientError as ex:
            if is_412(ex):
                return "exists"
            raise

    def delete(self, key):
        self.s3.delete_object(Bucket=self.name, Key=key)

    def list_direct(self, prefix):
        """Keys directly under a folder prefix (delimiter '/')."""
        keys = []
        paginator = self.s3.get_paginator("list_objects_v2")
        for page in paginator.paginate(Bucket=self.name, Prefix=prefix, Delimiter="/"):
            for o in page.get("Contents", []):
                keys.append(o["Key"])
        return keys


def parse_kv_lines(data):
    """Read `.info` / lock content: UTF-8 (U+FFFD for bad bytes), split on LF,
    strip one trailing CR, split at the first '='; last repeat wins."""
    text = data.decode("utf-8", "replace")
    out = {}
    for ln in text.split("\n"):
        if ln.endswith("\r"):
            ln = ln[:-1]
        if "=" not in ln:
            continue
        k, v = ln.split("=", 1)
        out[k] = v
    return out


def kv_lines(pairs):
    return "".join("%s=%s\n" % (k, v) for k, v in pairs).encode("utf-8")


def process_alive(pid):
    """True if alive (or unknowable), False if the process is gone."""
    if IS_WINDOWS:
        try:
            import ctypes
            from ctypes import wintypes
            k32 = ctypes.WinDLL("kernel32", use_last_error=True)
            k32.OpenProcess.restype = wintypes.HANDLE
            h = k32.OpenProcess(0x1000, False, pid)   # PROCESS_QUERY_LIMITED_INFORMATION
            if not h:
                e = ctypes.get_last_error()
                return e != 87                        # 87: no such process; 5: alive, another user's
            code = wintypes.DWORD()
            ok = k32.GetExitCodeProcess(h, ctypes.byref(code))
            k32.CloseHandle(h)
            return (not ok) or code.value == 259      # STILL_ACTIVE
        except Exception:
            return True
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    except OSError:
        return True


# --------------------------------------------------------------------------
# state kept between runs: the holder pair per bucket and set

def state_path():
    here = os.path.dirname(os.path.realpath(__file__))
    return os.path.join(here, "s3cab-backup.state.json")


def load_state():
    try:
        with open(state_path(), "rb") as f:
            return json.loads(f.read().decode("utf-8"))
    except FileNotFoundError:
        return {}
    except (OSError, ValueError) as ex:
        raise Stop("can't read %s: %s" % (state_path(), ex))


def save_state(state):
    p = state_path()
    data = json.dumps(state, indent=2, sort_keys=True, ensure_ascii=False).encode("utf-8")
    tmp = p + ".tmp"
    with open(tmp, "wb") as f:
        f.write(data)
    os.replace(tmp, p)


def kept_pair(state, bucket, set_name):
    v = state.get("holders", {}).get(bucket, {}).get(set_name)
    if isinstance(v, dict) and "OWNER" in v and "CLAIMED" in v:
        return (v["OWNER"], v["CLAIMED"])
    return None


def keep_pair(state, bucket, set_name, pair):
    # re-read just before writing, so two runs for different sets on one
    # machine don't overwrite each other's pair
    fresh = load_state()
    fresh.setdefault("holders", {}).setdefault(bucket, {})[set_name] = {"OWNER": pair[0], "CLAIMED": pair[1]}
    save_state(fresh)
    state.clear()
    state.update(fresh)


def forget_pair(state, bucket, set_name):
    fresh = load_state()
    try:
        del fresh["holders"][bucket][set_name]
    except KeyError:
        pass
    save_state(fresh)
    state.clear()
    state.update(fresh)


# --------------------------------------------------------------------------
# the run

class Run:
    def __init__(self, bucket_name, set_name, dirs):
        self.bucket_name = bucket_name
        self.set_name = set_name
        self.dirs_as_typed = dirs
        self.lock_key = None
        self.by = None
        self.os_name = sys.platform
        self.pidns = None
        self.bucket = None
        self.state = None
        self.errors = 0

    # -- identity --------------------------------------------------------
    def identity(self):
        try:
            user = getpass.getuser()
        except Exception:
            user = os.environ.get("USER") or os.environ.get("USERNAME") or "unknown"
        self.by = "%s@%s" % (user, socket.gethostname())
        if sys.platform.startswith("linux"):
            try:
                self.pidns = os.readlink("/proc/self/ns/pid")
            except OSError:
                self.pidns = None

    # -- locks -----------------------------------------------------------
    def lock_body(self, instant24):
        pairs = [("COMMAND", "backup"), ("SET", self.set_name), ("BY", self.by), ("OS", self.os_name)]
        if self.pidns:
            pairs.append(("PIDNS", self.pidns))
        pairs += [("PID", str(os.getpid())), ("STARTED", instant24)]
        return kv_lines(pairs)

    def write_lock(self, start_ns):
        ns = start_ns
        while True:
            instant24 = instant_from_ms(ms_cut_down(ns))
            key = "locks/upload-" + basic_instant(instant24)
            body = self.lock_body(instant24)
            if self.bucket.put_new(key, body) == "stored":
                self.lock_key = key
                return
            existing = self.bucket.get_bytes(key)
            if existing == body:
                self.lock_key = key               # our own write, retried after a lost response
                return
            time.sleep(0.002)
            ns = time.time_ns()

    def check_locks(self):
        for key in self.bucket.list_direct("locks/"):
            if key == self.lock_key:
                continue
            lock_id = key[len("locks/"):]
            m = re.match(r"^(upload|delete)-", lock_id)
            if not m:
                continue
            kind = m.group(1)
            data = self.bucket.get_bytes(key)
            if data is None:
                continue                          # gone between the list and the read
            kv = parse_kv_lines(data)
            mine = (kv.get("BY") == self.by and kv.get("OS") == self.os_name
                    and kv.get("PIDNS") == self.pidns and kv.get("OS") is not None)
            pid = kv.get("PID", "")
            if mine and PID_RE.match(pid) and not process_alive(int(pid)):
                log("removing a dead run's lock %s (pid %s is gone)" % (lock_id, pid))
                self.bucket.delete(key)
                continue
            if kind == "delete":
                raise Refuse("a delete is running (lock %s, by %s); refusing to upload beside it" % (lock_id, kv.get("BY", "?")))

    def remove_lock(self):
        if not self.lock_key:
            return
        try:
            self.bucket.delete(self.lock_key)
            self.lock_key = None
        except Exception as ex:
            err("could not remove the lock %s: %s — remove it by hand once this run is dead"
                % (self.lock_key[len("locks/"):], ex))

    # -- the set's holder ------------------------------------------------
    def snapshot_keys(self):
        prefix = "snapshots/%s/" % self.set_name
        return [k for k in self.bucket.list_direct(prefix) if SNAPSHOT_KEY_RE.match(k[len(prefix):])]

    def info_key(self):
        return "snapshots/%s.info" % self.set_name

    def read_info(self):
        data = self.bucket.get_bytes(self.info_key())
        return None if data is None else parse_kv_lines(data)

    def claim_or_check(self):
        kept = kept_pair(self.state, self.bucket_name, self.set_name)
        info = self.read_info()
        if info is None:
            if self.snapshot_keys():
                raise Refuse("set %s has snapshots but no %s: it has no holder until someone takes it over"
                             % (self.set_name, self.info_key()))
            now = instant_from_ms(ms_cut_down(time.time_ns()))
            body = kv_lines([("OWNER", self.by), ("CLAIMED", now), ("CREATED", now)])
            if self.bucket.put_new(self.info_key(), body) == "stored":
                keep_pair(self.state, self.bucket_name, self.set_name, (self.by, now))
                log("claimed set %s as %s" % (self.set_name, self.by))
                return
            info = self.read_info() or {}
            if info.get("OWNER") == self.by and info.get("CLAIMED") == now:
                keep_pair(self.state, self.bucket_name, self.set_name, (self.by, now))
                return
            raise Refuse("set name %s is taken: held by %s (claimed %s)"
                         % (self.set_name, info.get("OWNER", "?"), info.get("CLAIMED", "?")))
        pair = (info.get("OWNER"), info.get("CLAIMED"))
        if kept is None or pair != kept:
            if kept is not None:
                forget_pair(self.state, self.bucket_name, self.set_name)
            raise Refuse("set %s is held by %s (claimed %s), not by this tool's kept pair; take it over to publish"
                         % (self.set_name, pair[0], pair[1]))

    def check_holder_before_publish(self):
        kept = kept_pair(self.state, self.bucket_name, self.set_name)
        info = self.read_info()
        if info is None:
            raise Refuse("%s is gone: the set has no holder; snapshot not uploaded" % self.info_key())
        pair = (info.get("OWNER"), info.get("CLAIMED"))
        if kept is None or pair != kept:
            forget_pair(self.state, self.bucket_name, self.set_name)
            raise Refuse("set %s was taken over by %s (claimed %s); snapshot not uploaded"
                         % (self.set_name, pair[0], pair[1]))

    # -- objects ---------------------------------------------------------
    def store_object(self, fi):
        """Make sure objects/<hash> holds the bytes of this file.  Returns
        'stored', 'present', or a reason string why it wasn't sent."""
        key = "objects/" + fi.hash
        if self.bucket.head(key) is not None:
            return "present"
        flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_BINARY", 0) | getattr(os, "O_NONBLOCK", 0)
        try:
            fd = os.open(fi.osp, flags)
        except OSError as ex:
            return "can't be opened now: " + oserror_text(ex)
        with os.fdopen(fd, "rb", buffering=0) as f:
            st = os.fstat(f.fileno())
            if not stat.S_ISREG(st.st_mode):
                return "no longer a regular file"
            if st.st_size != fi.size or ms_round_nearest(st.st_mtime_ns) != fi.mtime_ms:
                return "changed since it was hashed (size %d -> %d, mtime %s -> %s)" % (
                    fi.size, st.st_size, instant_from_ms(fi.mtime_ms), instant_from_ms(ms_round_nearest(st.st_mtime_ns)))
            if fi.size > MULTIPART_THRESHOLD:
                return self.store_multipart(key, f, fi)
            # Hold the body back whole: hash what we read, send only if it
            # still hashes to the key, and send the key's digest so S3 checks
            # the bytes it received before anything becomes visible.
            h = hashlib.sha256()
            if fi.size <= SPOOL_IN_MEMORY_MAX:
                chunks = []
                while True:
                    c = f.read(READ_CHUNK)
                    if not c:
                        break
                    h.update(c)
                    chunks.append(c)
                body = b"".join(chunks)
                spool = None
            else:
                spool = tempfile.TemporaryFile()
                while True:
                    c = f.read(READ_CHUNK)
                    if not c:
                        break
                    h.update(c)
                    spool.write(c)
                spool.seek(0)
                body = spool
            try:
                if h.hexdigest() != fi.hash:
                    return "content changed while it was read (hash no longer matches its row)"
                try:
                    return "stored" if self.bucket.put_new(key, body, h.digest(), with_sse=True) == "stored" else "present"
                except self.bucket.ClientError as ex:
                    if is_bad_digest(ex):
                        return "bytes sent didn't hash to the key; the store refused them (nothing stored)"
                    raise
            finally:
                if spool is not None:
                    spool.close()

    def store_multipart(self, key, f, fi):
        s3 = self.bucket.s3
        part_size = max(16 * MiB, -(-fi.size // 10000))
        part_size = -(-part_size // MiB) * MiB
        kwargs = {"Bucket": self.bucket_name, "Key": key, "ChecksumAlgorithm": "SHA256"}
        kwargs.update(self.bucket.sse())
        upload_id = s3.create_multipart_upload(**kwargs)["UploadId"]
        whole = hashlib.sha256()
        parts = []
        try:
            n = 1
            while True:
                chunk = f.read(part_size)
                if not chunk:
                    break
                whole.update(chunk)
                r = s3.upload_part(Bucket=self.bucket_name, Key=key, UploadId=upload_id, PartNumber=n, Body=chunk,
                                   ChecksumSHA256=base64.b64encode(hashlib.sha256(chunk).digest()).decode("ascii"))
                parts.append({"PartNumber": n, "ETag": r["ETag"], "ChecksumSHA256": r["ChecksumSHA256"]})
                n += 1
                if len(chunk) < part_size:
                    break
            if whole.hexdigest() != fi.hash:
                s3.abort_multipart_upload(Bucket=self.bucket_name, Key=key, UploadId=upload_id)
                return "content changed while it was read (hash no longer matches its row); multipart aborted"
            try:
                s3.complete_multipart_upload(Bucket=self.bucket_name, Key=key, UploadId=upload_id,
                                             MultipartUpload={"Parts": parts})
                return "stored"
            except self.bucket.ClientError as ex:
                if is_412(ex):
                    s3.abort_multipart_upload(Bucket=self.bucket_name, Key=key, UploadId=upload_id)
                    return "present"
                raise
        except BaseException:
            try:
                s3.abort_multipart_upload(Bucket=self.bucket_name, Key=key, UploadId=upload_id)
            except Exception:
                pass
            raise

    # -- the run ---------------------------------------------------------
    def main(self):
        if not SET_NAME_RE.match(self.set_name):
            raise Stop("set name %r isn't one or more of a-z and 0-9 with single hyphens between" % self.set_name)
        if not self.dirs_as_typed:
            raise Stop("no member directory given")

        # member directories: real paths, each a directory, none inside another
        member_reals = []
        for d in self.dirs_as_typed:
            try:
                rp = real_directory(d)
            except FileNotFoundError:
                raise Stop("member directory doesn't exist: %s" % show(d))
            except OSError as ex:
                raise Stop("member directory can't be resolved: %s (%s)" % (show(d), oserror_text(ex)))
            if not os.path.isdir(os_path(rp)):
                raise Stop("member directory isn't a directory: %s" % show(d))
            if not has_utf8_form(rp):
                raise Stop("member directory's path has no UTF-8 form: %s" % show(name_for_people(rp)))
            member_reals.append(rp)
        for i, a in enumerate(member_reals):
            for j, b in enumerate(member_reals):
                if i != j and is_within(a, b):
                    raise Stop("member directories overlap: %s is %s or inside it (as typed: %s and %s)"
                               % (show(a), show(b), show(self.dirs_as_typed[i]), show(self.dirs_as_typed[j])))

        # the run's start: one clock reading mints the name and START
        start_ns = time.time_ns()
        start_ms = ms_cut_down(start_ns)
        start_instant = instant_from_ms(start_ms)
        snap_name = time.strftime("%Y%m%dT%H%M", time.localtime(start_ns // 1_000_000_000))
        zone = local_zone_name()
        self.identity()
        self.state = load_state()

        endpoint = os.environ.get("AWS_ENDPOINT_URL_S3") or os.environ.get("AWS_ENDPOINT_URL") or None
        region = os.environ.get("AWS_REGION") or os.environ.get("AWS_DEFAULT_REGION") or None
        client = make_client(region, endpoint)
        self.bucket = Bucket(client, self.bucket_name, on_aws=(endpoint is None))

        log("s3cab-backup %s: set %s -> s3://%s, snapshot %s, start %s (%s), by %s"
            % (CLIENT_VERSION, self.set_name, self.bucket_name, snap_name, start_instant, zone, self.by))

        # write first, look second
        self.write_lock(start_ns)
        try:
            self.check_locks()
            self.claim_or_check()
            snap_key = "snapshots/%s/%s.tsv.gz" % (self.set_name, snap_name)
            if self.bucket.head(snap_key) is not None:
                raise Refuse("a snapshot of %s named %s already exists: a second snapshot in the same minute is refused"
                             % (self.set_name, snap_name))

            # the walk, hashing as it goes
            walker = Walker(member_reals)
            for m in member_reals:
                log("walking %s" % show(with_trailing_sep(m)))
                walker.walk_member(m)
            finish_ns = time.time_ns()
            finish_ms = ms_round_up(finish_ns)
            finish_instant = instant_from_ms(finish_ms)
            text = build_snapshot(self.set_name, self.bucket_name, endpoint, member_reals, snap_name, self.by,
                                  start_instant, zone, walker.walk_rows, walker.file_rows, finish_instant,
                                  duration_text(finish_ms - start_ms))
            n_files = sum(1 for r in walker.file_rows if r.kind == "-")
            n_err = sum(1 for r in walker.walk_rows + walker.file_rows if r.kind == "#error")
            self.errors = n_err
            log("walked: %d file rows, %d #error rows, %d unique objects" % (n_files, n_err, len({f.hash for f in walker.files})))
            for r in walker.walk_rows + walker.file_rows:
                if r.kind == "#error":
                    err("#error  %s  %s" % (show(r.c2), show(r.path)))

            problems = check_snapshot_text(text)
            if problems:
                raise Stop("BUG: the snapshot this tool built would be refused by a reader; not uploaded:\n  "
                           + "\n  ".join(problems))
            compressed = gzip_single_stream(text.encode("utf-8"))

            # objects first
            unsent = []
            seen = set()
            stored = present = 0
            for fi in walker.files:
                if fi.hash in seen:
                    continue
                seen.add(fi.hash)
                outcome = self.store_object(fi)
                if outcome == "stored":
                    stored += 1
                elif outcome == "present":
                    present += 1
                else:
                    unsent.append((fi, outcome))
                    err("not sent: %s — %s" % (show(fi.rec), outcome))
            log("objects: %d uploaded, %d already present, %d not sent" % (stored, present, len(unsent)))
            if unsent:
                raise Refuse("%d object(s) could not be stored as their rows say; the snapshot names content the "
                             "repository doesn't hold, so it is not uploaded. Run again." % len(unsent))

            # snapshot last, holder checked immediately before
            self.check_holder_before_publish()
            if self.bucket.put_new(snap_key, compressed, hashlib.sha256(compressed).digest(), with_sse=True) == "stored":
                log("uploaded %s (%d bytes, %d rows)" % (snap_key, len(compressed), text.count("\n")))
            else:
                existing = self.bucket.get_bytes(snap_key)
                if existing == compressed:
                    log("%s already holds exactly these bytes: counts as uploaded" % snap_key)
                else:
                    raise Refuse("%s already exists with different content: conflict, not overwritten" % snap_key)
        finally:
            self.remove_lock()
        return 1 if self.errors else 0


def main(argv):
    if sys.version_info < (3, 10):
        err("Python 3.10 or later is needed (os.path.realpath(strict=True))")
        return 1
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="backslashreplace")
        sys.stderr.reconfigure(encoding="utf-8", errors="backslashreplace")
    except Exception:
        pass
    if len(argv) < 4:
        err("usage: python s3cab-backup.py <bucket> <set> <dir>...")
        return 2
    run = Run(argv[1], argv[2], argv[3:])
    try:
        return run.main()
    except Stop as ex:
        err("stopped, no snapshot written: %s" % ex)
        return 1
    except Refuse as ex:
        err("refused: %s" % ex)
        return 1
    except KeyboardInterrupt:
        err("interrupted")
        return 1
    except Exception as ex:
        err("failed: %s: %s" % (type(ex).__name__, ex))
        return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
