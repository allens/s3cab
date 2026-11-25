#!/usr/bin/env python3
"""s3cab-backup.py: an independent backup writer for the s3cab storage format.

    python s3cab-backup.py <bucket> <set> <dir>...

Written from format.md (the spec of 2026-10-30) and nothing else.  It walks the
member directories, stores every file's content at objects/<sha256>, then
uploads the snapshot that names them to snapshots/<set>/<name>.tsv.gz.

Python 3 standard library and boto3 only.  Correct, not fast: one request at a
time, nothing cached between runs.  The one thing kept between runs is what the
spec says a holder keeps: the OWNER and CLAIMED of each set this program
claimed, in s3cab-backup.state.json beside this file.

Exit status: 0 when the snapshot is uploaded with no #error row; 1 when the run
stopped, was refused, or uploaded a snapshot holding an #error row; 2 for a bad
command line.
"""

import base64
import errno
import gzip
import hashlib
import json
import os
import re
import signal
import socket
import stat
import sys
import time
import zlib

try:
    import fcntl
except ImportError:  # Windows
    fcntl = None

SPEC_DATE = "2026-10-30"
FORMAT_URL = "https://s3cab.plantegral.com/guide/format"
CLIENT_NAME = "s3cab-backup-py"
CLIENT_VERSION = "1.0.0"

WINDOWS = os.name == "nt"
SEP = "\\" if WINDOWS else "/"

# A file this size or larger is sent in parts.  A part is this size unless the
# file needs more than 10,000 of them.
MULTIPART_FROM = 16 * 1024 * 1024
PART_SIZE = 16 * 1024 * 1024
MAX_PARTS = 10000

# [0-9], never \d, and fullmatch, never $: Python's \d takes any Unicode digit
# and its $ also matches before a final LF.
SET_NAME = re.compile(r"[a-z0-9]+(?:-[a-z0-9]+)*")
SNAPSHOT_FILE = re.compile(r"[0-9]{8}T[0-9]{4}\.tsv\.gz")
HASH = re.compile(r"[0-9a-f]{64}")
INSTANT = re.compile(r"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z")
PID = re.compile(r"[1-9][0-9]*")

# The trim for leading fields: JavaScript's trim() set, not str.strip()'s.
TRIM = ("\t\n\v\f\r   "
        "           "
        "    　﻿")

MS_MIN = -62167219200000   # 0000-01-01T00:00:00.000Z
MS_MAX = 253402300799999   # 9999-12-31T23:59:59.999Z


class Stop(Exception):
    """The run stops here, and says why.  No snapshot is uploaded."""


# ---------------------------------------------------------------------------
# Signals: a signal stops the run at the next checkpoint, never in the middle
# of a request, so the lock is not removed while a request is in flight.
# ---------------------------------------------------------------------------

_signals = []


def _on_signal(signum, _frame):
    if _signals:                      # asked twice: stop at once
        raise KeyboardInterrupt
    _signals.append(signum)


def checkpoint():
    if _signals:
        raise Stop("interrupted by signal %d" % _signals[0])


# ---------------------------------------------------------------------------
# Text helpers
# ---------------------------------------------------------------------------

def show(text):
    """A value made safe to print: control characters spelled out."""
    out = []
    for ch in str(text):
        o = ord(ch)
        if o < 0x20 or 0x7F <= o <= 0x9F or o in (0x2028, 0x2029) or 0xD800 <= o <= 0xDFFF:
            out.append("\\x%02x" % o if o < 0x100 else "\\u%04x" % o)
        else:
            out.append(ch)
    return "".join(out)


def say(message):
    print(message, flush=True)


def warn(message):
    print("s3cab-backup: " + message, file=sys.stderr, flush=True)


def spell(text):
    """Tab, CR and LF written as their Unicode Control Pictures."""
    return text.replace("\t", "␉").replace("\r", "␍").replace("\n", "␊")


def has_utf8(text):
    try:
        text.encode("utf-8")
        return True
    except UnicodeEncodeError:
        return False


def with_replacements(name):
    """A name with U+FFFD standing in for each part that has no UTF-8 form."""
    if WINDOWS:
        return name.encode("utf-8", "surrogatepass").decode("utf-8", "replace")
    return os.fsencode(name).decode("utf-8", "replace")


def clean_message(text):
    """Free text fit for column 2: valid Unicode, no tab or line ending."""
    text = str(text).encode("utf-8", "surrogatepass").decode("utf-8", "replace")
    text = spell(text).strip(TRIM)
    return text or "error"


def os_error_text(err):
    code = errno.errorcode.get(err.errno, "") if err.errno is not None else ""
    winerror = getattr(err, "winerror", None)
    if winerror:
        code = "winerror %d" % winerror
    text = err.strerror or str(err)
    return "%s: %s" % (code, text) if code else text


# ---------------------------------------------------------------------------
# Instants.  Done by hand: datetime holds only the years 1 to 9999, and the
# 24-character form runs from the year 0000.
# ---------------------------------------------------------------------------

def _civil(days):
    """Days since 1970-01-01 to (year, month, day), proleptic Gregorian."""
    z = days + 719468
    era = z // 146097
    doe = z - era * 146097
    yoe = (doe - doe // 1460 + doe // 36524 - doe // 146096) // 365
    doy = doe - (365 * yoe + yoe // 4 - yoe // 100)
    mp = (5 * doy + 2) // 153
    day = doy - (153 * mp + 2) // 5 + 1
    month = mp + 3 if mp < 10 else mp - 9
    return yoe + era * 400 + (1 if month <= 2 else 0), month, day


def _split_ms(ms):
    if not MS_MIN <= ms <= MS_MAX:
        raise ValueError("an instant the 24-character form can't hold")
    days, rest = divmod(ms, 86400000)       # floor division, right before 1970 too
    hours, rest = divmod(rest, 3600000)
    minutes, rest = divmod(rest, 60000)
    seconds, millis = divmod(rest, 1000)
    return _civil(days) + (hours, minutes, seconds, millis)


def instant_text(ms):
    """Milliseconds since 1970 as YYYY-MM-DDTHH:MM:SS.sssZ."""
    return "%04d-%02d-%02dT%02d:%02d:%02d.%03dZ" % _split_ms(ms)


def instant_basic(ms):
    """The same instant in ISO 8601's basic form, as a lock's key holds it."""
    return "%04d%02d%02dT%02d%02d%02d.%03dZ" % _split_ms(ms)


def round_ms(ns):
    """Nanoseconds to the nearest millisecond, a tie to the later one."""
    return (ns + 500000) // 1000000


def now_ms():
    """The clock, cut down to the millisecond."""
    return time.time_ns() // 1000000


def readable_size(n):
    if n < 1000:
        return "%dB" % n
    units = ("kB", "MB", "GB", "TB", "PB")
    for i, unit in enumerate(units):
        div = 1000 ** (i + 1)
        tenths = (n * 10 + div // 2) // div      # one decimal place, half up
        if tenths < 10000 or unit == "PB":
            return "%d.%d%s" % (tenths // 10, tenths % 10, unit)


def duration_text(ms):
    seconds = (ms + 500) // 1000
    if seconds < 60:
        return "%ds" % seconds
    if seconds < 3600:
        return "%dm %02ds" % (seconds // 60, seconds % 60)
    return "%dh %02dm" % (seconds // 3600, seconds % 3600 // 60)


def zone_name():
    """The best name there is for the local time zone.  Written for people."""
    tz = os.environ.get("TZ")
    if tz:
        name = tz[1:] if tz.startswith(":") else tz
        if "zoneinfo/" in name:
            name = name.split("zoneinfo/", 1)[1]
        if name:
            return name
    if WINDOWS:
        try:
            import ctypes
            icu = ctypes.CDLL("icu.dll")
            buf = ctypes.create_unicode_buffer(256)
            status = ctypes.c_int(0)
            n = icu.ucal_getDefaultTimeZone(buf, 256, ctypes.byref(status))
            if status.value <= 0 and n > 0 and buf.value:
                return buf.value
        except Exception:
            pass
    else:
        try:
            link = os.path.realpath("/etc/localtime")
            if "zoneinfo/" in link:
                return link.split("zoneinfo/", 1)[1]
        except OSError:
            pass
    local = time.localtime()
    if local.tm_zone:
        return local.tm_zone
    offset = local.tm_gmtoff or 0
    sign = "-" if offset < 0 else "+"
    return "UTC%s%02d:%02d" % (sign, abs(offset) // 3600, abs(offset) % 3600 // 60)


def user_at_machine():
    user = None
    try:
        if WINDOWS:
            user = os.getlogin()
        else:
            import pwd
            user = pwd.getpwuid(os.getuid()).pw_name   # not $USER: each run must spell it alike
    except Exception:
        pass
    if not user:
        try:
            import getpass
            user = getpass.getuser()
        except Exception:
            user = "unknown"
    try:
        machine = socket.gethostname() or "unknown"
    except Exception:
        machine = "unknown"
    text = "%s@%s" % (user, machine)
    text = text.encode("utf-8", "surrogatepass").decode("utf-8", "replace")
    return spell(text)


# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------

def os_path(path):
    """A recorded path in the form to hand the operating system.

    On Windows every path goes through \\\\?\\, so that a name ending in a dot
    or a space, a reserved name or a long path is taken exactly as written.
    """
    if not WINDOWS or path.startswith("\\\\?\\"):
        return path
    if path.startswith("\\\\"):
        return "\\\\?\\UNC\\" + path[2:]
    return "\\\\?\\" + path


def plain_windows_path(path):
    """A Windows path without the \\\\?\\ it was handed back with."""
    if path.startswith("\\\\?\\UNC\\"):
        return "\\\\" + path[8:]
    if path.startswith("\\\\?\\"):
        path = path[4:]
    if re.match(r"[A-Za-z]:", path):
        path = path[0].upper() + path[1:]       # a drive letter is always uppercase
    return path


def _listed_name(parent, name):
    """How parent's own listing spells the entry `name` opens.

    Matched by the file (device and inode), not by the name: a disk that
    ignores case or Unicode normalization opens a name its listing spells in
    other bytes.  None when the parent can't be listed.
    """
    try:
        with os.scandir(parent) as it:
            entries = list(it)
    except OSError:
        return None
    for entry in entries:
        if entry.name == name:
            return name
    try:
        want = os.lstat(os.path.join(parent, name))
    except OSError:
        return name
    # lstat every entry: the inode a listing itself carries (DirEntry.inode())
    # is not the one lstat reports for a mount point, or a macOS firmlink such
    # as /Users, so it can't be used to pick the entry.
    for entry in entries:
        try:
            got = os.lstat(os.path.join(parent, entry.name))
        except OSError:
            continue
        if (got.st_dev, got.st_ino) == (want.st_dev, want.st_ino):
            return entry.name
    return name


def _getpath(path):
    """macOS: the path of an open file as the disk spells it (F_GETPATH)."""
    if fcntl is None or not hasattr(fcntl, "F_GETPATH"):
        return None
    try:
        fd = os.open(path, os.O_RDONLY | getattr(os, "O_NONBLOCK", 0))
    except OSError:
        return None
    try:
        raw = fcntl.fcntl(fd, fcntl.F_GETPATH, bytes(1024))
        return os.fsdecode(raw.split(b"\0", 1)[0])
    except OSError:
        return None
    finally:
        os.close(fd)


def spell_as_disk(real):
    """A POSIX real path with every name spelled as its parent lists it.

    os.path.realpath keeps the case as typed on macOS, and in a Linux directory
    that ignores case, so each name is looked up in its parent's listing.
    Where a parent can't be listed the name stays as the path spelled it,
    unless (on macOS) F_GETPATH on the whole path knows better.
    """
    names = [n for n in real.split("/") if n]
    out, unlisted, parent = [], [], "/"
    for i, name in enumerate(names):
        listed = _listed_name(parent, name)
        if listed is None:
            unlisted.append(i)
            listed = name
        out.append(listed)
        parent = "/" + "/".join(out)
    if unlisted:
        told = _getpath("/" + "/".join(out))
        told_names = [n for n in told.split("/") if n] if told else []
        if len(told_names) == len(out):
            for i in unlisted:
                if told_names[i] == out[i]:
                    continue
                try:    # take the other spelling only for the same entry
                    a = os.lstat("/" + "/".join(out[:i + 1]))
                    b = os.lstat("/" + "/".join(out[:i] + [told_names[i]]))
                except OSError:
                    continue
                if (a.st_dev, a.st_ino) == (b.st_dev, b.st_ino):
                    out[i] = told_names[i]
    return "/" + "/".join(out)


def resolve_member(arg):
    """A member directory's real path, ending in one separator, or Stop."""
    try:
        if WINDOWS:
            given = arg
            if not given.startswith("\\\\?\\"):
                # normpath, not abspath: abspath drops a trailing dot or space
                given = os_path(os.path.normpath(os.path.join(os.getcwd(), given)))
            real = plain_windows_path(os.path.realpath(given, strict=True))
        else:
            real = os.path.realpath(arg, strict=True)
            real = spell_as_disk("/" + real.lstrip("/"))    # exactly one leading /
        is_dir = stat.S_ISDIR(os.stat(os_path(real)).st_mode)
    except (OSError, ValueError) as err:
        raise Stop("member directory %s can't be used: %s" % (show(arg), show(err)))
    if not is_dir:
        raise Stop("member directory %s is not a directory" % show(arg))
    if WINDOWS and not (re.match(r"[A-Z]:\\", real) or re.match(r"\\\\[^\\?.][^\\]*\\[^\\]+", real)):
        raise Stop("member directory %s is at %s, which has no drive letter and no share: "
                   "no path a reader accepts can name it" % (show(arg), show(real)))
    if not real.endswith(SEP):
        real += SEP
    if not has_utf8(real):
        raise Stop("member directory %s has a real path with no UTF-8 form: %s"
                   % (show(arg), show(with_replacements(real))))
    if any(c in real for c in "\t\r\n"):
        raise Stop("member directory %s has a tab, CR or LF in its real path %s: "
                   "a @SET DIR row can't hold it" % (show(arg), show(real)))
    return real


def inside_members(target, members):
    """Is this real path a member directory, or inside one?  Whole segments, exactly."""
    probe = target if target.endswith(SEP) else target + SEP
    return any(probe.startswith(member) for member in members)


def is_broken_link(err):
    """A link is broken when nothing exists where it points."""
    if WINDOWS:
        return getattr(err, "winerror", None) in (2, 3, 1921)
    return err.errno in (errno.ENOENT, errno.ENOTDIR, errno.ELOOP)


# ---------------------------------------------------------------------------
# The walk
# ---------------------------------------------------------------------------

class Walk:
    """Walks the member directories without following a link.

    Leaves `errors`, the #error rows the walk finds, and `files`, the path of
    every regular file, both in the order found.
    """

    def __init__(self, members):
        self.members = members
        self.errors = []        # (message, path)
        self.files = []         # path
        self.seen = set()       # every path that will have a row
        self.listed = {}        # a listed directory's (device, inode) -> its member and path

    def run(self):
        for member in self.members:
            self.member = member
            self.twin = None
            self._walk(member)

    def _claim(self, path):
        if path in self.seen:
            raise Stop("the path %s turns up twice: two member directories overlap, or two "
                       "entries would share one row. Change the set." % show(path))
        if self.twin:
            raise Stop("the directory %s is also in the backup as %s, under another member "
                       "directory: the same files turn up under two member directories. "
                       "Change the set." % (show(self.twin[0]), show(self.twin[1])))
        self.seen.add(path)

    def _error(self, message, path):
        path = spell(path)
        self._claim(path)
        self.errors.append((clean_message(message), path))

    def _list(self, directory):
        try:
            info = os.stat(os_path(directory))
            with os.scandir(os_path(directory)) as it:
                entries = list(it)
        except OSError as err:
            raise Stop("the directory %s can't be listed: %s"
                       % (show(directory), os_error_text(err)))
        # The paths built here can't see one directory reached under two real
        # paths (a macOS firmlink, a bind mount), so go by the directory itself
        # too: one already listed under another member directory is an overlap
        # as soon as it holds anything that would get a row.
        self.twin = None
        if info.st_ino:
            first = self.listed.setdefault((info.st_dev, info.st_ino), (self.member, directory))
            if first[0] != self.member:
                self.twin = (directory, first[1])
        entries.sort(key=lambda entry: entry.name)
        return entries

    def _walk(self, member):
        pending = [member]
        while pending:
            checkpoint()
            directory = pending.pop()
            below = []
            for entry in self._list(directory):
                name = entry.name
                if not has_utf8(name):
                    raise Stop("an entry in %s has a name with no UTF-8 form: %s. Rename it."
                               % (show(directory), show(with_replacements(name))))
                path = directory + name
                try:
                    is_junction = getattr(entry, "is_junction", None)
                    if (is_junction is not None and is_junction()) or entry.is_symlink():
                        kind = "link"
                    elif entry.is_dir(follow_symlinks=False):
                        kind = "dir"
                    elif entry.is_file(follow_symlinks=False):
                        kind = "file"
                    else:
                        kind = "other"      # a pipe, socket or device, or it has vanished
                except OSError as err:
                    self._error("type can't be determined: " + os_error_text(err), path)
                    continue
                if kind == "dir":
                    below.append(path + SEP)
                elif kind == "file":
                    if any(c in path for c in "\t\r\n"):
                        raise Stop("the file %s has a tab, CR or LF in its path, which a "
                                   "snapshot can't hold. Rename it." % show(path))
                    self._claim(path)
                    self.files.append(path)
                elif kind == "link":
                    self._link(path)
            pending.extend(reversed(below))     # depth first, in name order

    def _link(self, path):
        """A link gets an #error row when it leads out of the backup, or
        somewhere this computer can't resolve; otherwise none."""
        try:
            held = os.readlink(os_path(path))
            if WINDOWS:
                held = plain_windows_path(held) if held.startswith("\\\\?\\") else held
            held = with_replacements(held)
        except OSError:
            held = "?"
        try:
            target = os.path.realpath(os_path(path), strict=True)
            mode = os.stat(target).st_mode
        except OSError as err:
            if is_broken_link(err):
                return                          # broken: no row
            self._error("link to somewhere this computer can't resolve (%s): %s"
                        % (os_error_text(err), held), path)
            return
        if stat.S_ISDIR(mode):
            to_dir = True
        elif stat.S_ISREG(mode):
            to_dir = False
        else:
            return                              # to a pipe, socket or device: no row
        if WINDOWS:
            target = plain_windows_path(target)
        if inside_members(target, self.members):
            return                              # into the backup: recorded where it lies
        if not WINDOWS:
            respelled = spell_as_disk(target)   # only when it seems to lead out
            if respelled != target and inside_members(respelled, self.members):
                return
        if to_dir:
            self._error("link to a folder outside the backup: " + held, path + SEP)
        else:
            self._error("link to a file outside the backup: " + held, path)


# ---------------------------------------------------------------------------
# Reading files
# ---------------------------------------------------------------------------

_OPEN_FLAGS = (os.O_RDONLY | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOFOLLOW", 0)
               | getattr(os, "O_NONBLOCK", 0) | getattr(os, "O_NOCTTY", 0)
               | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOINHERIT", 0))


def open_regular(path):
    """Open a regular file without following a link.  Returns (fd, fstat)."""
    target = os_path(path)
    if not hasattr(os, "O_NOFOLLOW"):
        # Windows has no O_NOFOLLOW: look before opening, then check the handle.
        before = os.lstat(target)
        if not stat.S_ISREG(before.st_mode) or getattr(before, "st_reparse_tag", 0) in (
                0xA0000003, 0xA000000C):
            raise OSError(errno.EINVAL, "no longer a regular file")
    try:
        fd = os.open(target, _OPEN_FLAGS)
    except OSError as err:
        if err.errno == errno.ELOOP:
            raise OSError(errno.ELOOP, "no longer a regular file (now a link)")
        raise
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode):
            raise OSError(errno.EINVAL, "no longer a regular file")
    except BaseException:
        os.close(fd)
        raise
    return fd, info


def read_some(fd, want):
    """Read `want` bytes, or fewer only at the end of the file."""
    chunks, got = [], 0
    while got < want:
        chunk = os.read(fd, min(want - got, 1 << 20))
        if not chunk:
            break
        chunks.append(chunk)
        got += len(chunk)
    return b"".join(chunks)


def hash_file(path):
    """One file's row: ("-", hash, size, mtime in ms) or ("#error", message).

    The size and the time come from one fstat of the open handle, just before
    its content is hashed.
    """
    for _attempt in range(3):
        checkpoint()
        try:
            fd, info = open_regular(path)
        except OSError as err:
            return ("#error", os_error_text(err))
        try:
            mtime = round_ms(info.st_mtime_ns)
            if not MS_MIN <= mtime <= MS_MAX:
                return ("#error", "modification time outside the years 0000 to 9999")
            digest, count = hashlib.sha256(), 0
            while True:
                chunk = os.read(fd, 1 << 20)
                if not chunk:
                    break
                digest.update(chunk)
                count += len(chunk)
                checkpoint()
            after = os.fstat(fd)
        except OSError as err:
            return ("#error", os_error_text(err))
        finally:
            os.close(fd)
        if count != info.st_size:
            return ("#error", "read returned %d bytes where the file held %d"
                    % (count, info.st_size))
        if (after.st_size, after.st_mtime_ns) == (info.st_size, info.st_mtime_ns):
            return ("-", digest.hexdigest(), info.st_size, mtime)
        # its size or time moved while it was read: read it again
    return ("#error", "changed while it was read, three times over")


# ---------------------------------------------------------------------------
# The snapshot text
# ---------------------------------------------------------------------------

def canonical_line(kind, col2="", col3="", col4="", col5=""):
    """One row in canonical form: five fields, split by four tabs.

    Column 1 unpadded, column 2 padded on the right to 64, column 3 on the left
    to 12, column 4 on the right to 24 (in code points), the last never padded.
    """
    for field in (kind, col2, col3, col4, col5):
        if "\t" in field or "\n" in field or "\r" in field:
            raise Stop("internal error: a field holds a tab or line ending: %s" % show(field))
    return "%s\t%s\t%s\t%s\t%s\n" % (kind, col2.ljust(64), col3.rjust(12), col4.ljust(24), col5)


def snapshot_text(rows):
    return "".join(canonical_line(*row) for row in rows) + ".\n"


def _path_parts(path):
    """(kind, root, segments) of a path, by its first characters alone."""
    if re.match(r"[A-Za-z]:[\\/]", path):
        return "windows", path[0].upper() + ":", re.split(r"[\\/]", path[3:])
    if re.match(r"[\\/]{2}", path):
        return "windows", "\\\\", re.split(r"[\\/]", path[2:])
    if path.startswith("/"):
        return "posix", "/", path[1:].split("/")
    return None, None, []


def _dir_parts(path):
    kind, root, segments = _path_parts(path)
    while segments and segments[-1] == "":
        segments.pop()
    if kind == "windows":
        segments = [s.lower() for s in segments]
        if root == "\\\\" and len(segments) < 2:
            kind = None
    return kind, root, segments


def check_snapshot(packed):
    """Read the snapshot back the way the spec tells a reader to, and Stop on
    anything a reader would refuse, whole or one path at a time, or that is
    not canonical.  Returns the hashes its file rows name, and their sizes."""
    def bad(why):
        raise Stop("internal error: the snapshot this run built is not valid (%s); "
                   "nothing was uploaded for it" % why)

    unpacker = zlib.decompressobj(wbits=31)
    try:
        data = unpacker.decompress(packed) + unpacker.flush()
    except zlib.error as err:
        bad("gzip: %s" % err)
    if not unpacker.eof or unpacker.unused_data:
        bad("not exactly one gzip stream")
    try:
        text = data.decode("utf-8", "strict")
    except UnicodeDecodeError as err:
        bad("not UTF-8: %s" % err)
    if text.startswith("﻿"):
        bad("starts with a BOM")
    lines = text.split("\n")
    if len(lines) < 3 or lines[-1] != "" or lines[-2] != ".":
        bad("doesn't end with the . line")
    lines = lines[:-2]
    heading = lines[0].split("\t", 4)
    if (len(heading) != 5 or [f.strip(TRIM) for f in heading[:4]] != ["@S3CAB", "FORMAT", "size", "time"]
            or heading[4] != FORMAT_URL):
        bad("no heading row")
    dirs, per_path, files, once = [], set(), [], {}
    declared_files = declared_size = None
    for line in lines:
        if "\r" in line:
            bad("a CR in a row")
        if line.strip(TRIM) == "":
            bad("a blank line")
        fields = line.split("\t", 4)
        if len(fields) != 5 or "\t" in fields[4]:
            bad("a row without exactly five fields: %s" % show(line))
        kind, col2, col3, col4 = [f.strip(TRIM) for f in fields[:4]]
        last = fields[4]
        if line + "\n" != canonical_line(kind, col2, col3, col4, last):
            bad("a row not in canonical form: %s" % show(line))
        if kind == "-":
            files.append((col2, col3, col4, last))
        elif kind[:1] not in ("@", "#"):
            bad("an unknown row type %s" % show(kind))
        if kind == "-" or kind[:1] == "#":
            if last in per_path:
                bad("the path %s in two rows" % show(last))
            per_path.add(last)
        if kind == "@SET" and col2 == "DIR":
            dirs.append(_dir_parts(last))
        if (kind, col2) in (("@S3CAB", "SPEC"), ("@CLIENT", "NAME"), ("@CLIENT", "VERSION")):
            once[(kind, col2)] = once.get((kind, col2), 0) + 1
        if kind == "@SNAPSHOT" and col2 == "FILES":
            declared_files = last
        if kind == "@SNAPSHOT" and col2 == "SIZE":
            declared_size = last
    for key in (("@S3CAB", "SPEC"), ("@CLIENT", "NAME"), ("@CLIENT", "VERSION")):
        if once.get(key) != 1:
            bad("not exactly one %s %s row" % key)
    named, total, file_paths = {}, 0, set()
    for digest, size, mtime, path in files:
        if not HASH.fullmatch(digest) or not re.fullmatch(r"[0-9]+", size):
            bad("a malformed file row for %s" % show(path))
        if not INSTANT.fullmatch(mtime):
            bad("a malformed time for %s" % show(path))
        kind, root, segments = _path_parts(path)
        if kind is None or "\0" in path or any(s in ("", ".", "..") for s in segments):
            bad("a file row whose path is not a clean absolute path: %s" % show(path))
        compare = [s.lower() for s in segments] if kind == "windows" else segments
        under = equal = False
        for dkind, droot, dsegs in dirs:
            if dkind != kind or droot != root:
                continue
            if compare[:len(dsegs)] == dsegs:
                under = under or len(compare) > len(dsegs)
                equal = equal or len(compare) == len(dsegs)
        if not under or equal:
            bad("a file row not strictly inside a @SET DIR: %s" % show(path))
        named[digest] = int(size)
        total += int(size)
        file_paths.add(path)
    for path in file_paths:        # no file row's path runs through another's
        kind = _path_parts(path)[0]
        for i, ch in enumerate(path):
            if (ch == "/" or (kind == "windows" and ch == "\\")) and path[:i] in file_paths:
                bad("the file row %s runs through another file row" % show(path))
    if declared_files != str(len(files)):
        bad("@SNAPSHOT FILES disagrees with the file rows")
    if declared_size != "%d (%s)" % (total, readable_size(total)):
        bad("@SNAPSHOT SIZE disagrees with the size column")
    return named


# ---------------------------------------------------------------------------
# The bucket
# ---------------------------------------------------------------------------

def b64(digest):
    return base64.b64encode(digest).decode("ascii")


def status_of(err):
    return err.response.get("ResponseMetadata", {}).get("HTTPStatusCode")


def code_of(err):
    return err.response.get("Error", {}).get("Code")


def is_miss(err):
    """A missing key, and nothing else: not a missing bucket, not a 403."""
    return status_of(err) == 404 and code_of(err) in ("NoSuchKey", "NotFound", "404")


class Bucket:
    def __init__(self, name, endpoint):
        import boto3
        from botocore.config import Config
        from botocore.exceptions import ClientError
        self.ClientError = ClientError
        self.name = name
        # boto3 reads AWS_DEFAULT_REGION and never AWS_REGION; a tool for this
        # format starts in AWS_REGION, else AWS_DEFAULT_REGION, else us-east-1.
        region = os.environ.get("AWS_REGION") or os.environ.get("AWS_DEFAULT_REGION") or "us-east-1"
        config = Config(
            # "standard", not "legacy": legacy sends a body S3 refused as a
            # BadDigest five times over.  Still retries a 5xx and a dropped connection.
            retries={"mode": "standard", "total_max_attempts": 6},
            connect_timeout=10, read_timeout=60,
            # The endpoint comes from the two variables read in main(), passed
            # in here, and from nowhere else.
            ignore_configured_endpoint_urls=True,
        )
        self.s3 = boto3.client("s3", region_name=region, endpoint_url=endpoint, config=config)
        model = self.s3.meta.service_model
        for operation in ("PutObject", "CompleteMultipartUpload"):
            if "IfNoneMatch" not in model.operation_model(operation).input_shape.members:
                raise Stop("this boto3 (%s) can't make %s conditional (no IfNoneMatch); "
                           "a newer boto3 is needed" % (boto3.__version__, operation))

    def get(self, key):
        """The bytes at a key, or None when the key is missing."""
        checkpoint()
        try:
            return self.s3.get_object(Bucket=self.name, Key=key)["Body"].read()
        except self.ClientError as err:
            if is_miss(err):
                return None
            raise

    def exists(self, key):
        checkpoint()
        try:
            self.s3.head_object(Bucket=self.name, Key=key)
            return True
        except self.ClientError as err:
            if is_miss(err):
                return False
            raise

    def list(self, prefix, delimiter=None):
        """Every key under a prefix, every page of the listing."""
        request = {"Bucket": self.name, "Prefix": prefix}
        if delimiter:
            request["Delimiter"] = delimiter
        while True:
            checkpoint()
            page = self.s3.list_objects_v2(**request)
            for item in page.get("Contents", []):
                yield item
            if not page.get("IsTruncated"):
                return
            request["ContinuationToken"] = page["NextContinuationToken"]

    def put_new(self, key, body, digest=None):
        """A no-overwrite PUT (If-None-Match: *).  True when it stored the key,
        False when the key was already there (412).

        The SHA-256 goes with it as x-amz-checksum-sha256, so the store itself
        refuses bytes that don't match and stores nothing; for an object the
        digest is the key's own, not one worked out from the body.  Nothing
        else is set: no Content-Encoding, no metadata, no storage class.
        """
        if digest is None:
            digest = hashlib.sha256(body).digest()
        for attempt in range(4):
            checkpoint()
            try:
                answer = self.s3.put_object(Bucket=self.name, Key=key, Body=body,
                                            IfNoneMatch="*", ChecksumSHA256=b64(digest))
            except self.ClientError as err:
                if status_of(err) == 412:
                    return False
                if status_of(err) == 409 and attempt < 3:   # raced another conditional write
                    time.sleep(0.5 * (attempt + 1))
                    continue
                raise
            stored = answer.get("ChecksumSHA256")
            if stored is not None and stored != b64(digest):
                raise Stop("the store answered the PUT of %s with another checksum (%s)"
                           % (key, stored))
            return True

    def delete(self, key):
        self.s3.delete_object(Bucket=self.name, Key=key)

    def put_new_in_parts(self, key, fd, size, expect_hex):
        """A large object, sent in parts.  Each part goes with its own SHA-256,
        which the store checks; the whole is hashed from those same bytes, and
        the upload is completed, conditionally, only if that hash is the key.
        Otherwise it is aborted, which leaves nothing stored.

        Returns "stored", "exists" (412), or ("changed", why).
        """
        part_size = max(PART_SIZE, -(-size // MAX_PARTS))
        checkpoint()
        upload = self.s3.create_multipart_upload(Bucket=self.name, Key=key,
                                                 ChecksumAlgorithm="SHA256")["UploadId"]
        completed = False
        try:
            whole, parts, digests, sent = hashlib.sha256(), [], [], 0
            while True:
                checkpoint()
                chunk = read_some(fd, min(part_size, size - sent + 1))
                if not chunk:
                    break
                if sent + len(chunk) > size:
                    return ("changed", "it has grown since it was hashed")
                whole.update(chunk)
                digest = hashlib.sha256(chunk).digest()
                number = len(parts) + 1
                answer = self.s3.upload_part(Bucket=self.name, Key=key, UploadId=upload,
                                             PartNumber=number, Body=chunk,
                                             ChecksumSHA256=b64(digest))
                parts.append({"PartNumber": number, "ETag": answer["ETag"],
                              "ChecksumSHA256": b64(digest)})
                digests.append(digest)
                sent += len(chunk)
                del chunk
            if whole.hexdigest() != expect_hex or sent != size:
                return ("changed", "the bytes sent don't hash to its row")
            # What S3 will call the object's checksum: the hash of the parts'
            # hashes.  Sent with the completion, so S3 refuses any other set of parts.
            composite = "%s-%d" % (b64(hashlib.sha256(b"".join(digests)).digest()), len(parts))
            checkpoint()
            try:
                self.s3.complete_multipart_upload(
                    Bucket=self.name, Key=key, UploadId=upload,
                    MultipartUpload={"Parts": parts}, IfNoneMatch="*",
                    ChecksumSHA256=composite)
            except self.ClientError as err:
                if status_of(err) == 412:
                    return "exists"
                raise
            completed = True
            return "stored"
        finally:
            if not completed:
                try:    # a refused or unfinished upload stays open, and billed, until aborted
                    self.s3.abort_multipart_upload(Bucket=self.name, Key=key, UploadId=upload)
                except Exception as err:
                    warn("couldn't abort the multipart upload %s of %s: %s" % (upload, key, err))


# ---------------------------------------------------------------------------
# KEY=value files: a set's .info, and a lock
# ---------------------------------------------------------------------------

def parse_key_values(data):
    """Read as the spec reads .info: UTF-8 with U+FFFD for what isn't, split on
    LF, one trailing CR stripped, split at the first =, the last of a key counts."""
    fields = {}
    for line in data.decode("utf-8", "replace").split("\n"):
        if line.endswith("\r"):
            line = line[:-1]
        key, equals, value = line.partition("=")
        if equals:
            fields[key] = value
    return fields


def process_gone(pid):
    """Is the process with this pid gone?  Only a clear "no such process" says so."""
    if pid == os.getpid():
        return False
    if WINDOWS:
        # os.kill(pid, 0) is no test on Windows: 0 is CTRL_C_EVENT there.
        try:
            import ctypes
            from ctypes import wintypes
            kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
            kernel32.OpenProcess.restype = wintypes.HANDLE
            kernel32.OpenProcess.argtypes = (wintypes.DWORD, wintypes.BOOL, wintypes.DWORD)
            kernel32.GetExitCodeProcess.argtypes = (wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD))
            kernel32.CloseHandle.argtypes = (wintypes.HANDLE,)
            if pid > 0xFFFFFFFF:
                return True
            handle = kernel32.OpenProcess(0x1000, False, pid)   # PROCESS_QUERY_LIMITED_INFORMATION
            if not handle:
                return ctypes.get_last_error() == 87            # 87 gone; 5 alive, another user's
            try:
                code = wintypes.DWORD()
                if not kernel32.GetExitCodeProcess(handle, ctypes.byref(code)):
                    return False
                return code.value != 259                        # STILL_ACTIVE
            finally:
                kernel32.CloseHandle(handle)
        except Exception:
            return False
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return True                 # ESRCH
    except OverflowError:
        return True                 # larger than any pid this system can have
    except OSError:
        return False                # EPERM: alive, another user's
    return False


class Lock:
    """This run's upload lock: written first, and only then are locks/ listed."""

    def __init__(self, bucket, set_name, by):
        self.bucket = bucket
        self.set_name = set_name
        self.by = by
        self.os = sys.platform
        self.pidns = None
        if sys.platform == "linux":
            try:
                self.pidns = os.readlink("/proc/self/ns/pid")
            except OSError:
                self.pidns = None
        self.key = None

    def _body(self, started):
        lines = [("COMMAND", "backup"), ("SET", self.set_name), ("BY", self.by), ("OS", self.os)]
        if self.pidns is not None:
            lines.append(("PIDNS", self.pidns))
        lines += [("PID", str(os.getpid())), ("STARTED", started)]
        return "".join("%s=%s\n" % pair for pair in lines).encode("utf-8")

    def write(self):
        while True:
            instant = now_ms()                  # the clock, read again for each try
            key = "locks/upload-" + instant_basic(instant)
            body = self._body(instant_text(instant))
            if self.bucket.put_new(key, body) or self.bucket.get(key) == body:
                self.key = key                  # ours, or our own write retried
                return
            time.sleep(0.002)                   # another run took that instant

    def look(self):
        """List locks/.  Remove a dead run's; refuse on a live delete lock."""
        for item in list(self.bucket.list("locks/", delimiter="/")):
            key = item["Key"]
            name = key[len("locks/"):]
            if key == self.key or not name:
                continue
            if not (name.startswith("delete-") or name.startswith("upload-")):
                continue
            content = self.bucket.get(key)
            if content is None:
                continue                        # its run ended since the listing
            fields = parse_key_values(content)
            pid = fields.get("PID", "")
            ours = (fields.get("BY") == self.by and fields.get("OS") == self.os
                    and fields.get("PIDNS") == self.pidns and PID.fullmatch(pid))
            if ours and process_gone(int(pid)):
                self.bucket.delete(key)
                say("removed the lock %s, left by a run of this machine's that is gone (pid %s)"
                    % (name, pid))
                continue
            if name.startswith("delete-"):
                raise Stop("a delete is running, or left its lock: %s (by %s, pid %s, started %s). "
                           "Uploads and deletes take turns; run again once it has finished. "
                           "If its run is dead, a person has to remove that lock."
                           % (name, show(fields.get("BY", "?")), show(pid or "?"),
                              show(fields.get("STARTED", "?"))))

    def remove(self):
        if self.key is None:
            return
        try:
            self.bucket.delete(self.key)
            self.key = None
        except Exception as err:
            warn("couldn't remove this run's lock; remove it by hand: %s (%s)"
                 % (self.key[len("locks/"):], err))


# ---------------------------------------------------------------------------
# Who holds the set.  The pair this program wrote when it claimed a set is the
# one thing kept between runs: beside the program, keyed by endpoint, bucket
# and set.
# ---------------------------------------------------------------------------

STATE_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "s3cab-backup.state.json")


def _load_state():
    try:
        with open(STATE_FILE, "r", encoding="utf-8", newline="") as handle:
            state = json.load(handle)
    except FileNotFoundError:
        return {"claims": []}
    except (OSError, ValueError) as err:
        raise Stop("can't read %s: %s" % (STATE_FILE, err))
    if not isinstance(state, dict) or not isinstance(state.get("claims"), list):
        raise Stop("%s is not this program's state file" % STATE_FILE)
    return state


def kept_pair(endpoint, bucket, set_name):
    for claim in _load_state()["claims"]:
        if (claim.get("endpoint"), claim.get("bucket"), claim.get("set")) == (endpoint, bucket, set_name):
            return claim.get("OWNER"), claim.get("CLAIMED")
    return None


def keep_pair(endpoint, bucket, set_name, pair):
    """Keep a pair, or with pair None forget it."""
    state = _load_state()
    state["claims"] = [c for c in state["claims"]
                       if (c.get("endpoint"), c.get("bucket"), c.get("set")) != (endpoint, bucket, set_name)]
    if pair is not None:
        state["claims"].append({"endpoint": endpoint, "bucket": bucket, "set": set_name,
                                "OWNER": pair[0], "CLAIMED": pair[1]})
    scratch = STATE_FILE + ".new"
    try:
        with open(scratch, "w", encoding="utf-8", newline="\n") as handle:
            json.dump(state, handle, indent=1, ensure_ascii=False)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(scratch, STATE_FILE)
    except OSError as err:
        raise Stop("can't keep this program's claims in %s: %s" % (STATE_FILE, err))


def snapshot_names(bucket, set_name):
    """The snapshots of a set: keys directly in its folder, named as a reader takes one."""
    prefix = "snapshots/%s/" % set_name
    names = []
    for item in bucket.list(prefix, delimiter="/"):
        name = item["Key"][len(prefix):]
        if SNAPSHOT_FILE.fullmatch(name):
            names.append(name[:-len(".tsv.gz")])
    return sorted(names)


def hold_set(bucket, endpoint, set_name, by):
    """Make sure this program holds the set, claiming it if it is new.
    Returns the pair to check again just before the snapshot is uploaded."""
    key = "snapshots/%s.info" % set_name
    info = bucket.get(key)
    pair = kept_pair(endpoint, bucket.name, set_name)
    if info is None:
        if snapshot_names(bucket, set_name):
            raise Stop("the set %s has snapshots but no %s: it has no holder until someone "
                       "takes it over, and this program can't take a set over" % (set_name, key))
        claimed = instant_text(now_ms())        # the clock, read as the claim is made
        pair = (by, claimed)
        body = ("OWNER=%s\nCLAIMED=%s\nCREATED=%s\n" % (by, claimed, claimed)).encode("utf-8")
        keep_pair(endpoint, bucket.name, set_name, pair)    # kept before it is written
        if bucket.put_new(key, body) or bucket.get(key) == body:
            say("claimed the new set %s for %s" % (set_name, show(by)))
            return pair
        keep_pair(endpoint, bucket.name, set_name, None)
        raise Stop("the name %s was taken while this run claimed it" % set_name)
    fields = parse_key_values(info)
    if pair is None or (fields.get("OWNER"), fields.get("CLAIMED")) != pair:
        raise Stop("the set %s is held by %s (claimed %s), and that is not a claim this program "
                   "kept: the name is taken. Use another name, or have the set taken over."
                   % (set_name, show(fields.get("OWNER", "?")), show(fields.get("CLAIMED", "?"))))
    return pair


# ---------------------------------------------------------------------------
# Storing objects
# ---------------------------------------------------------------------------

def send_file(bucket, digest_hex, path, size, mtime):
    """Store one file's content at objects/<hash>, unless it has changed.

    Returns "stored", "exists", or ("changed", why).  The file is checked
    against its row on the handle the bytes are then read from; the bytes sent
    are hashed, and compared with the key before anything can become visible.
    """
    key = "objects/" + digest_hex
    try:
        fd, info = open_regular(path)
    except OSError as err:
        return ("changed", os_error_text(err))
    try:
        if info.st_size != size:
            return ("changed", "its size is now %d, not %d" % (info.st_size, size))
        if round_ms(info.st_mtime_ns) != mtime:
            return ("changed", "its modification time has changed")
        if size >= MULTIPART_FROM:
            return bucket.put_new_in_parts(key, fd, size, digest_hex)
        body = read_some(fd, size + 1)
        if hashlib.sha256(body).hexdigest() != digest_hex:
            return ("changed", "its content no longer hashes to its row")
        # These same bytes go out, with the key's own digest for S3 to check.
        return "stored" if bucket.put_new(key, body, bytes.fromhex(digest_hex)) else "exists"
    except OSError as err:
        return ("changed", os_error_text(err))
    finally:
        os.close(fd)


def store_objects(bucket, file_rows):
    """Upload every object the file rows name that the bucket doesn't hold.
    Returns the hashes that could not be stored, each with why."""
    wanted = {}                                 # hash -> its rows, in snapshot order
    for digest_hex, size, mtime, path in file_rows:
        wanted.setdefault(digest_hex, []).append((path, size, mtime))
    listed = {}
    for item in bucket.list("objects/"):        # stored: only on the bucket's word
        name = item["Key"][len("objects/"):]
        if HASH.fullmatch(name):
            listed[name] = item
    failed, sent, wrong = [], set(), 0
    for digest_hex, rows in wanted.items():
        checkpoint()
        if digest_hex in listed:
            item = listed[digest_hex]
            if item.get("Size") != rows[0][1]:
                wrong += 1
                warn("objects/%s is already stored with %s bytes where the file has %d: that "
                     "object is damaged, and is left as it is" % (digest_hex, item.get("Size"), rows[0][1]))
            if item.get("StorageClass") in ("GLACIER", "DEEP_ARCHIVE"):
                warn("objects/%s is stored in %s, which a plain GET can't read"
                     % (digest_hex, item["StorageClass"]))
            continue
        why = None
        for path, size, mtime in rows:          # content several paths share: any one will do
            result = send_file(bucket, digest_hex, path, size, mtime)
            if result in ("stored", "exists"):
                if result == "stored":
                    sent.add(digest_hex)
                why = None
                break
            why = "%s: %s" % (show(path), result[1])
        if why is not None:
            failed.append((digest_hex, why))
    return failed, sent, len(wanted), wrong


def confirm_stored(bucket, named, sent):
    """The last look before the snapshot goes up: every object it names is
    listed under objects/ now, and each one this run sent has its row's size."""
    listed = {}
    for item in bucket.list("objects/"):
        name = item["Key"][len("objects/"):]
        if name in named:
            listed[name] = item.get("Size")
    missing = sorted(set(named) - set(listed))
    if missing:
        raise Stop("%d object(s) the snapshot names are not in the bucket (the first: objects/%s): "
                   "the snapshot was not uploaded" % (len(missing), missing[0]))
    for digest_hex in sent:
        if listed[digest_hex] != named[digest_hex]:
            raise Stop("objects/%s was sent as %d bytes and is listed with %s: the snapshot was "
                       "not uploaded" % (digest_hex, named[digest_hex], listed[digest_hex]))


# ---------------------------------------------------------------------------
# The run
# ---------------------------------------------------------------------------

def run(bucket_name, set_name, directories):
    start_ns = time.time_ns()                   # one clock reading: START and the name
    start_ms = start_ns // 1000000              # cut down, not rounded
    name = time.strftime("%Y%m%dT%H%M", time.localtime(start_ns // 1000000000))
    if not re.fullmatch(r"[0-9]{8}T[0-9]{4}", name):
        raise Stop("the local time gives no snapshot name: %s" % show(name))
    zone = zone_name()
    by = user_at_machine()

    members = [resolve_member(d) for d in directories]      # resolved once, for walk and row both
    for i, member in enumerate(members):
        if member in members[:i]:
            raise Stop("the member directory %s is named twice. Change the set." % show(member))

    endpoint = os.environ.get("AWS_ENDPOINT_URL_S3") or os.environ.get("AWS_ENDPOINT_URL") or None
    bucket = Bucket(bucket_name, endpoint)
    snapshot_key = "snapshots/%s/%s.tsv.gz" % (set_name, name)

    lock = Lock(bucket, set_name, by)
    try:
        lock.write()                            # write first,
        lock.look()                             # look second

        pair = hold_set(bucket, endpoint or "", set_name, by)
        earlier = snapshot_names(bucket, set_name)
        if name in earlier:
            raise Stop("the set %s already has a snapshot named %s: a second snapshot in the "
                       "same minute is refused, never an overwrite" % (set_name, name))
        if earlier and earlier[-1] > name:
            warn("the clock has gone back: the snapshot %s will sort before %s, which readers "
                 "will go on taking for the latest" % (name, earlier[-1]))

        walk = Walk(members)
        walk.run()

        if bucket.exists(snapshot_key):         # the early answer; the 412 still decides
            raise Stop("the set %s already has a snapshot named %s: a second snapshot in the "
                       "same minute is refused, never an overwrite" % (set_name, name))

        rows = [
            ("@S3CAB", "FORMAT", "size", "time", FORMAT_URL),
            ("@S3CAB", "SPEC", "", "", SPEC_DATE),
            ("@CLIENT", "NAME", "", "", CLIENT_NAME),
            ("@CLIENT", "VERSION", "", "", CLIENT_VERSION),
            ("@SET", "NAME", "", "", set_name),
            ("@SET", "BUCKET", "", "", "s3://" + bucket_name),
        ]
        if endpoint:
            rows.append(("@SET", "ENDPOINT", "", "", spell(endpoint)))
        rows += [("@SET", "DIR", "", "", member) for member in members]
        rows += [
            ("@SNAPSHOT", "NAME", "", "", name),
            ("@SNAPSHOT", "BY", "", "", by),
            ("@SNAPSHOT", "START", "", instant_text(start_ms), spell(zone)),
        ]
        rows += [("#error", message, "", "", path) for message, path in walk.errors]
        file_rows, total = [], 0
        for path in walk.files:
            result = hash_file(path)
            if result[0] == "-":
                _, digest_hex, size, mtime = result
                rows.append(("-", digest_hex, str(size), instant_text(mtime), path))
                file_rows.append((digest_hex, size, mtime, path))
                total += size
            else:
                rows.append(("#error", clean_message(result[1]), "", "", path))
        error_rows = [row for row in rows if row[0] == "#error"]
        errors = len(error_rows)
        finish_ms = -(-time.time_ns() // 1000000)       # every row before FILES is in hand: rounded up
        rows += [
            ("@SNAPSHOT", "FILES", "", "", str(len(file_rows))),
            ("@SNAPSHOT", "SIZE", "", "", "%d (%s)" % (total, readable_size(total))),
            ("@SNAPSHOT", "FINISH", "", instant_text(finish_ms), duration_text(finish_ms - start_ms)),
        ]
        packed = gzip.compress(snapshot_text(rows).encode("utf-8"), 9, mtime=0)   # one stream, no name, no time
        named = check_snapshot(packed)
        if set(named) != set(row[0] for row in file_rows):
            raise Stop("internal error: the snapshot doesn't name the objects this run hashed")

        # Objects first.
        failed, sent, distinct, wrong = store_objects(bucket, file_rows)
        say("objects: %d distinct, %d sent, %d already stored"
            % (distinct, len(sent), distinct - len(sent) - len(failed)))
        if failed:
            for digest_hex, why in failed:
                warn("not stored: objects/%s: %s" % (digest_hex, why))
            raise Stop("%d file(s) changed after they were hashed, so the snapshot names content "
                       "the bucket doesn't hold: it was not uploaded. Run the backup again."
                       % len(failed))

        confirm_stored(bucket, named, sent)

        # Snapshot last, and only by the set's holder.
        info = bucket.get("snapshots/%s.info" % set_name)
        fields = parse_key_values(info) if info is not None else {}
        if info is None or (fields.get("OWNER"), fields.get("CLAIMED")) != pair:
            raise Stop("the set %s is no longer this program's to publish to (its .info %s): "
                       "the snapshot was not uploaded"
                       % (set_name, "is gone" if info is None else
                          "names %s, claimed %s" % (show(fields.get("OWNER", "?")),
                                                    show(fields.get("CLAIMED", "?")))))
        if not bucket.put_new(snapshot_key, packed):
            if bucket.get(snapshot_key) != packed:
                raise Stop("the set %s already has another snapshot named %s: a second snapshot "
                           "in the same minute is refused, never an overwrite" % (set_name, name))
        say("snapshot: s3://%s/%s  %d files, %d (%s), %d #error row(s)"
            % (bucket_name, snapshot_key, len(file_rows), total, readable_size(total), errors))
        for row in error_rows:
            warn("not backed up: %s (%s)" % (show(row[4]), show(row[1])))
        if errors:
            warn("%d entr%s could not be backed up; each has an #error row in the snapshot"
                 % (errors, "y" if errors == 1 else "ies"))
        return 1 if errors or wrong else 0
    finally:
        lock.remove()


def main(argv):
    for stream in (sys.stdout, sys.stderr):
        try:        # a path can hold anything; never die printing one
            stream.reconfigure(encoding="utf-8", errors="backslashreplace")
        except Exception:
            pass
    if len(argv) < 4:
        print("usage: python s3cab-backup.py <bucket> <set> <dir>...", file=sys.stderr)
        return 2
    # realpath(strict=True) came with 3.10; on Windows a junction can only be
    # told from a folder since 3.12, and walking into one would back up what
    # lies beyond it.
    needed = (3, 12) if WINDOWS else (3, 10)
    if sys.version_info < needed:
        print("s3cab-backup: Python %d.%d or later is needed here" % needed, file=sys.stderr)
        return 2
    bucket_name, set_name, directories = argv[1], argv[2], argv[3:]
    if bucket_name.startswith("s3://"):
        bucket_name = bucket_name[len("s3://"):]
    bucket_name = bucket_name.rstrip("/")
    if not bucket_name or "/" in bucket_name or any(c in bucket_name for c in "\t\r\n"):
        print("s3cab-backup: %s is not a bucket name" % show(argv[1]), file=sys.stderr)
        return 2
    if not SET_NAME.fullmatch(set_name):
        print("s3cab-backup: %s is not a set name: a to z and digits, with single hyphens "
              "between them" % show(set_name), file=sys.stderr)
        return 2
    for signum in ("SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"):
        if hasattr(signal, signum):
            try:
                signal.signal(getattr(signal, signum), _on_signal)
            except (OSError, ValueError):
                pass
    try:
        from botocore.exceptions import BotoCoreError, ClientError
    except ImportError as err:
        print("s3cab-backup: boto3 is needed: %s" % err, file=sys.stderr)
        return 2
    try:
        return run(bucket_name, set_name, directories)
    except Stop as stop:
        warn("stopped: %s" % stop)
        return 1
    except ClientError as err:
        warn("stopped: the bucket refused a request (%s %s): %s"
             % (status_of(err), code_of(err), err))
        return 1
    except BotoCoreError as err:
        warn("stopped: a request failed after its retries: %s" % err)
        return 1
    except KeyboardInterrupt:
        warn("stopped at once, as asked twice; a request may still have been in flight")
        return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
