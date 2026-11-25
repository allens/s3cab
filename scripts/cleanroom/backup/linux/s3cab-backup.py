#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
s3cab-backup.py -- an independent backup writer for the s3cab storage format.

    python s3cab-backup.py <bucket> <set> <dir>...

Written from the format spec of 2026-10-30 alone (format.md), with Python 3's
standard library and boto3.  It walks the member directories, stores every
file's content under objects/<sha256>, and then publishes the snapshot that
names them as snapshots/<set>/<YYYYMMDDTHHMM>.tsv.gz.

In order: resolve the member directories; write an upload lock, then look for
others; be the set's holder (claim a new set, or match the kept claim); walk;
refuse a second snapshot in the same minute; hash every file; build and check
the snapshot's text; list objects/ and send what it lacks, each object's bytes
hashed as they go and never visible under a key they don't hash to; check the
holder again; publish the snapshot; remove the lock.

Exit status:
    0  the snapshot is in the bucket, and everything in the member directories is in it
    1  the snapshot is in the bucket, but not everything will restore from it: it holds
       an #error row, or names an object the bucket lists with the wrong length or in
       an archive storage class
    2  the run stopped: no snapshot was published (the reason is on stderr)

The only thing kept between runs is the OWNER/CLAIMED pair of each set this
program has claimed, one small file each in s3cab-backup.state/ beside the
program, keyed by endpoint, bucket and set.  No file content, hash or snapshot
is cached.  Lose that folder and the sets it names can be backed up again only
after --takeover, which is a person's decision.

Nothing is left out: every regular file under a member directory gets a row.
A name no snapshot can hold (a tab, CR or LF in a file's path, or a name with
no UTF-8 form) stops the run, as the spec requires; rename it and run again.

Correct, not fast: one request at a time, every file read in full on every run.

Only Linux has run this program.  The Windows and macOS branches follow the
spec's hints and have been exercised only as far as Linux can simulate them.
"""

import base64
import errno
import gzip
import hashlib
import io
import json
import os
import re
import signal
import socket
import stat
import sys
import time

SPEC_DATE = "2026-10-30"
CLIENT_NAME = "s3cab-backup-py"
CLIENT_VERSION = "1.0.0"

HEADING = ("@S3CAB", "FORMAT", "size", "time", "https://s3cab.plantegral.com/guide/format")

IS_WIN = os.name == "nt"
SEP = "\\" if IS_WIN else "/"

# A file of PART_SIZE bytes or more goes up in parts of PART_SIZE (or larger,
# when 10,000 parts of that size would not hold it); a smaller one in one PUT.
PART_SIZE = 16 * 1024 * 1024
MAX_PARTS = 10000

# What the spec's trim removes from a leading field: JavaScript's trim() set.
TRIM = (
    "\t\n\x0b\x0c\r \u00a0\u1680"
    "\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a"
    "\u2028\u2029\u202f\u205f\u3000\ufeff"
)

EXIT_OK = 0
EXIT_INCOMPLETE = 1
EXIT_STOPPED = 2


class Stop(Exception):
    """The run stops and publishes no snapshot."""


# --------------------------------------------------------------------------
# Text
# --------------------------------------------------------------------------

def picture(text):
    """Spell a tab, CR or LF out as its Unicode Control Picture."""
    return text.replace("\t", "\u2409").replace("\r", "\u240d").replace("\n", "\u240a")


def show(text):
    """A string made safe to print: control characters and surrogates spelled out."""
    out = []
    for ch in text:
        cp = ord(ch)
        if cp < 0x20 or 0x7F <= cp <= 0x9F or cp in (0x2028, 0x2029) or 0xD800 <= cp <= 0xDFFF:
            out.append("\\x%02x" % cp if cp <= 0xFF else "\\u%04x" % cp)
        else:
            out.append(ch)
    return "".join(out)


def say(message):
    try:
        print(message, flush=True)
    except (OSError, ValueError):
        pass


def warn(message):
    try:
        print(message, file=sys.stderr, flush=True)
    except (OSError, ValueError):
        pass


def canonical_row(c1, c2="", c3="", c4="", c5=""):
    """One row in canonical form.  len() and ljust() count code points."""
    return "%s\t%s\t%s\t%s\t%s\n" % (c1, c2.ljust(64), c3.rjust(12), c4.ljust(24), c5)


def property_row(kind, prop, value="", instant=""):
    return canonical_row(kind, prop, "", instant, picture(value))


def message_text(message):
    """Column 2 of an #error row: no tab, CR or LF, and nothing a reader's trim would remove."""
    return picture(message).strip(TRIM) or "error"


# --------------------------------------------------------------------------
# Time
# --------------------------------------------------------------------------

def civil_from_days(days):
    """Days since 1970-01-01 to (year, month, day) in the proleptic Gregorian calendar."""
    z = days + 719468
    era = z // 146097
    doe = z - era * 146097
    yoe = (doe - doe // 1460 + doe // 36524 - doe // 146096) // 365
    doy = doe - (365 * yoe + yoe // 4 - yoe // 100)
    mp = (5 * doy + 2) // 153
    day = doy - (153 * mp + 2) // 5 + 1
    month = mp + 3 if mp < 10 else mp - 9
    year = yoe + era * 400 + (1 if month <= 2 else 0)
    return year, month, day


def instant_text(ms):
    """Milliseconds since the epoch as YYYY-MM-DDTHH:MM:SS.sssZ, or None outside 0000..9999."""
    days, rem = divmod(ms, 86400000)
    year, month, day = civil_from_days(days)
    if not 0 <= year <= 9999:
        return None
    hour, rem = divmod(rem, 3600000)
    minute, rem = divmod(rem, 60000)
    second, milli = divmod(rem, 1000)
    return "%04d-%02d-%02dT%02d:%02d:%02d.%03dZ" % (year, month, day, hour, minute, second, milli)


def round_ms(ns):
    """Nanoseconds to the nearest millisecond, a tie to the later one."""
    return (ns + 500000) // 1000000


def now_ms():
    """The clock, cut down to the millisecond."""
    return time.time_ns() // 1000000


def duration_text(ms):
    seconds = max(0, ms) // 1000
    if seconds < 60:
        return "%ds" % seconds
    if seconds < 3600:
        return "%dm %02ds" % (seconds // 60, seconds % 60)
    return "%dh %02dm" % (seconds // 3600, seconds % 3600 // 60)


def readable_size(n):
    if n < 1000:
        return "%dB" % n
    unit = 1000
    for name in ("kB", "MB", "GB", "TB", "PB"):
        tenths = (20 * n + unit) // (2 * unit)      # one decimal place, half up
        if tenths < 10000 or name == "PB":
            return "%d.%d%s" % (tenths // 10, tenths % 10, name)
        unit *= 1000


def zone_name(start_seconds):
    """The best name there is for the local time zone.  Free text, for people."""
    tz = os.environ.get("TZ")
    if tz:
        tz = tz[1:] if tz.startswith(":") else tz
        if "zoneinfo/" in tz:
            tz = tz.rsplit("zoneinfo/", 1)[1]
        if tz:
            return tz
    if IS_WIN:
        try:
            import ctypes
            icu = ctypes.CDLL("icu.dll")
            fn = icu.ucal_getDefaultTimeZone
            fn.restype = ctypes.c_int32
            fn.argtypes = (ctypes.c_wchar_p, ctypes.c_int32, ctypes.POINTER(ctypes.c_int))
            buf = ctypes.create_unicode_buffer(256)
            err = ctypes.c_int(0)
            n = fn(buf, 255, ctypes.byref(err))
            if err.value <= 0 and 0 < n < 255 and buf.value:
                return buf.value
        except Exception:
            pass
    else:
        try:
            real = os.path.realpath("/etc/localtime")
            if "zoneinfo/" in real:
                name = real.rsplit("zoneinfo/", 1)[1]
                if name:
                    return name
        except Exception:
            pass
    try:
        lt = time.localtime(start_seconds)
        name = time.tzname[1 if lt.tm_isdst > 0 else 0]
        off = lt.tm_gmtoff
        sign = "+" if off >= 0 else "-"
        off = abs(off)
        return "%s (UTC%s%02d:%02d)" % (name, sign, off // 3600, off % 3600 // 60)
    except Exception:
        return "unknown"


# --------------------------------------------------------------------------
# Who and where
# --------------------------------------------------------------------------

def user_at_machine():
    user = None
    try:
        import pwd
        user = pwd.getpwuid(os.getuid()).pw_name
    except Exception:
        user = None
    if not user:
        try:
            user = os.getlogin()
        except Exception:
            user = None
    if not user:
        try:
            import getpass
            user = getpass.getuser()
        except Exception:
            user = None
    try:
        machine = socket.gethostname()
    except Exception:
        machine = None
    text = "%s@%s" % (user or "unknown", machine or "unknown")
    # One line of a KEY=value file, and one field of a snapshot row.
    text = picture(text)
    return text.encode("utf-8", "replace").decode("utf-8")


def pid_namespace():
    if sys.platform != "linux":
        return None
    try:
        return os.readlink("/proc/self/ns/pid")
    except OSError:
        return None


def process_alive(pid):
    """Whether a process with this pid is in this machine's process table."""
    if IS_WIN:
        try:
            import ctypes
            from ctypes import wintypes
            kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
            kernel32.OpenProcess.restype = wintypes.HANDLE
            kernel32.OpenProcess.argtypes = (wintypes.DWORD, wintypes.BOOL, wintypes.DWORD)
            kernel32.GetExitCodeProcess.restype = wintypes.BOOL
            kernel32.GetExitCodeProcess.argtypes = (wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD))
            kernel32.CloseHandle.argtypes = (wintypes.HANDLE,)
            if pid > 0xFFFFFFFF:
                return True
            handle = kernel32.OpenProcess(0x1000, False, pid)   # PROCESS_QUERY_LIMITED_INFORMATION
            if not handle:
                return ctypes.get_last_error() != 87            # 87: no such process
            try:
                code = wintypes.DWORD(0)
                if not kernel32.GetExitCodeProcess(handle, ctypes.byref(code)):
                    return True
                return code.value == 259                        # STILL_ACTIVE
            finally:
                kernel32.CloseHandle(handle)
        except Exception:
            return True
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except Exception:
        return True          # EPERM is another user's live process; anything else is not judged
    return True


# --------------------------------------------------------------------------
# Paths.  On POSIX every filesystem call takes bytes, so a name is exactly the
# bytes the directory holds whatever the locale; on Windows it takes str,
# always behind the \\?\ prefix.
# --------------------------------------------------------------------------

def name_text(name):
    """A listed name as text, and whether that text is the name (it has a UTF-8 form)."""
    if IS_WIN:
        try:
            name.encode("utf-8")
            return name, True
        except UnicodeEncodeError:
            return name.encode("utf-8", "surrogatepass").decode("utf-8", "replace"), False
    try:
        return name.decode("utf-8"), True
    except UnicodeDecodeError:
        return name.decode("utf-8", "replace"), False


def loose_text(value):
    """Any path-like value as text for a message, U+FFFD for what does not decode."""
    if isinstance(value, bytes):
        return value.decode("utf-8", "replace")
    return value.encode("utf-8", "surrogatepass").decode("utf-8", "replace")


def fs_join(parent, name):
    sep = SEP if IS_WIN else b"/"
    return parent + name if parent.endswith(sep) else parent + sep + name


def win_extended(path):
    if path.startswith("\\\\?\\"):
        return path
    if path.startswith("\\\\"):
        return "\\\\?\\UNC\\" + path[2:]
    return "\\\\?\\" + path


def win_plain(path):
    if path.startswith("\\\\?\\UNC\\"):
        return "\\\\" + path[8:]
    if path.startswith("\\\\?\\"):
        return path[4:]
    return path


def is_broken(error):
    """Whether following a link failed because nothing exists where it points."""
    if IS_WIN:
        return getattr(error, "winerror", None) in (2, 3, 1921)
    return error.errno in (errno.ENOENT, errno.ENOTDIR, errno.ELOOP)


def posix_disk_name(parent, name):
    """The name as the parent's listing spells it: the entry that is the same file."""
    try:
        names = os.listdir(parent)
    except OSError:
        if sys.platform == "darwin":
            try:
                import fcntl
                fd = os.open(fs_join(parent, name), os.O_RDONLY)
                try:
                    full = fcntl.fcntl(fd, fcntl.F_GETPATH, bytes(1024)).split(b"\0", 1)[0]
                finally:
                    os.close(fd)
                last = full.rsplit(b"/", 1)[-1]
                if last:
                    return last
            except Exception:
                pass
        return name
    if name in names:
        return name
    try:
        want = os.lstat(fs_join(parent, name))
    except OSError:
        return name
    for other in names:
        try:
            st = os.lstat(fs_join(parent, other))
        except OSError:
            continue
        if (st.st_dev, st.st_ino) == (want.st_dev, want.st_ino):
            return other
    return name


def posix_respell(real):
    """A real path, each name spelled as its parent's listing spells it."""
    current = b"/"
    for name in real.split(b"/"):
        if name:
            current = fs_join(current, posix_disk_name(current, name))
    return current


class Member:
    """A member directory, resolved once: for the walk and for its @SET DIR row both."""

    def __init__(self, typed):
        self.typed = typed
        shown = show(loose_text(typed))
        if IS_WIN:
            try:
                absolute = os.path.normpath(os.path.join(os.getcwd(), typed))
                real = os.path.realpath(win_extended(absolute), strict=True)
                is_dir = stat.S_ISDIR(os.stat(real).st_mode)
            except (OSError, ValueError) as e:
                raise Stop("member directory %s can't be resolved: %s" % (shown, e))
            if not is_dir:
                raise Stop("member directory %s is not a directory" % shown)
            plain = win_plain(real)
            drive = re.match(r"^([A-Za-z]):(\\.*)$", plain, re.S)
            share = re.match(r"^\\\\[^\\]+\\[^\\]+(\\.*)?$", plain, re.S)
            if drive and not plain.startswith("\\\\"):
                plain = drive.group(1).upper() + ":" + drive.group(2)
            elif not (share and not plain.startswith("\\\\?\\") and not plain.startswith("\\\\.\\")):
                raise Stop("member directory %s is on a volume with no drive letter and no share (%s): "
                           "no path a reader accepts can name it" % (shown, show(loose_text(plain))))
            plain = plain.rstrip("\\") + "\\"
            self.plain = plain                      # ends with one separator
            self.fs = win_extended(plain)
            text, faithful = name_text(plain)
        else:
            raw = os.fsencode(typed)
            try:
                real = os.path.realpath(raw, strict=True)
                is_dir = stat.S_ISDIR(os.stat(real).st_mode)
            except (OSError, ValueError) as e:
                raise Stop("member directory %s can't be resolved: %s" % (shown, e))
            if not is_dir:
                raise Stop("member directory %s is not a directory" % shown)
            real = posix_respell(real)
            plain = b"/" + real.strip(b"/")          # exactly one leading separator
            if plain != b"/":
                plain += b"/"
            self.plain = plain                       # ends with one separator
            self.fs = plain
            text, faithful = name_text(plain)
        if not faithful:
            raise Stop("member directory %s has a real path with no UTF-8 form: %s" % (shown, show(text)))
        if any(c in text for c in "\t\r\n"):
            raise Stop("member directory %s has a tab, CR or LF in its real path: %s" % (shown, show(text)))
        self.text = text                             # exactly what its @SET DIR row holds


def lies_in(members, plain, is_dir):
    """Whether a real path is a member directory or lies inside one, by whole segments."""
    sep = SEP if IS_WIN else b"/"
    if is_dir and not plain.endswith(sep):
        plain += sep
    return any(plain.startswith(m.plain) for m in members)


# --------------------------------------------------------------------------
# The walk
# --------------------------------------------------------------------------

def entry_is_link(entry):
    is_junction = getattr(entry, "is_junction", None)
    if is_junction is not None:
        if is_junction():
            return True
    elif IS_WIN:
        tag = getattr(entry.stat(follow_symlinks=False), "st_reparse_tag", 0)
        if tag == 0xA0000003:
            return True
    return entry.is_symlink()


def link_row(members, fs_path, text_path):
    """The #error row a link gets, as (message, path), or None when it gets no row."""
    try:
        held = os.readlink(fs_path)
        target = loose_text(win_plain(held) if IS_WIN else held)
    except (OSError, ValueError) as e:
        target = "(unreadable link: %s)" % e
    try:
        st = os.stat(fs_path)
    except OSError as e:
        if is_broken(e):
            return None                                   # broken: no row
        return ("link to somewhere this computer can't resolve (%s): %s" % (error_text(e), target), text_path)
    except ValueError as e:
        return ("link to somewhere this computer can't resolve (%s): %s" % (e, target), text_path)
    is_dir = stat.S_ISDIR(st.st_mode)
    if not is_dir and not stat.S_ISREG(st.st_mode):
        return None                                       # to a pipe, socket or device: no row
    try:
        real = os.path.realpath(fs_path, strict=True)
    except OSError as e:
        if is_broken(e):
            return None
        return ("link to somewhere this computer can't resolve (%s): %s" % (error_text(e), target), text_path)
    except ValueError as e:
        return ("link to somewhere this computer can't resolve (%s): %s" % (e, target), text_path)
    if IS_WIN:
        plain = win_plain(real)
        if re.match(r"^[a-z]:", plain):
            plain = plain[0].upper() + plain[1:]
        inside = lies_in(members, plain, is_dir)
    else:
        inside = lies_in(members, real, is_dir) or lies_in(members, posix_respell(real), is_dir)
    if inside:
        return None                                       # into the backup: recorded where it lies
    what = "folder" if is_dir else "file"
    return ("link to a %s outside the backup: %s" % (what, target), text_path + (SEP if is_dir else ""))


def error_text(error):
    """An OSError as ENAME: message, without the path Python appends."""
    code = errno.errorcode.get(error.errno, "") if error.errno is not None else ""
    winerror = getattr(error, "winerror", None)
    text = error.strerror or error.__class__.__name__
    if winerror:
        return "winerror %d: %s" % (winerror, text)
    return "%s: %s" % (code, text) if code else text


class Walk:
    def __init__(self, members):
        self.members = members
        self.files = []          # (fs path, text path) of each regular file, in walk order
        self.errors = []         # (message, text path) of each #error row the walk finds
        self.seen = set()        # every path given a row, to catch one found twice

    def claim_path(self, text_path):
        if text_path in self.seen:
            raise Stop("the same path turns up twice, as it does when one member directory is inside "
                       "another: %s -- change the set" % show(text_path))
        self.seen.add(text_path)

    def run(self):
        for member in self.members:
            self.walk(member.fs, member.text)

    def walk(self, fs_root, text_root):
        stack = [(fs_root, text_root)]
        while stack:
            fs_dir, text_dir = stack.pop()
            try:
                with os.scandir(fs_dir) as listing:
                    entries = list(listing)
            except OSError as e:
                raise Stop("directory %s can't be listed: %s" % (show(text_dir), error_text(e)))
            entries.sort(key=lambda entry: entry.name)
            below = []
            for entry in entries:
                name, faithful = name_text(entry.name)
                text_path = text_dir + name
                if not faithful:
                    raise Stop("a name has no UTF-8 form, so a snapshot can't hold it: %s -- "
                               "rename it and run again" % show(text_path))
                fs_path = fs_join(fs_dir, entry.name)
                try:
                    if entry_is_link(entry):
                        kind = "link"
                    elif entry.is_dir(follow_symlinks=False):
                        kind = "dir"
                    elif entry.is_file(follow_symlinks=False):
                        kind = "file"
                    else:
                        kind = None      # a pipe, socket or device, or it vanished: no row
                except OSError as e:
                    self.claim_path(text_path)
                    self.errors.append(("type can't be determined (%s)" % error_text(e), text_path))
                    continue
                if kind == "dir":
                    below.append((fs_path, text_path + SEP))
                elif kind == "file":
                    if any(c in text_path for c in "\t\r\n"):
                        raise Stop("a file has a tab, CR or LF in its path, which no snapshot row can hold: "
                                   "%s -- rename it and run again" % show(text_path))
                    self.claim_path(text_path)
                    self.files.append((fs_path, text_path))
                elif kind == "link":
                    found = link_row(self.members, fs_path, text_path)
                    if found is not None:
                        self.claim_path(found[1])
                        self.errors.append(found)
            stack.extend(reversed(below))


# --------------------------------------------------------------------------
# Reading files
# --------------------------------------------------------------------------

OPEN_FLAGS = (os.O_RDONLY | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOINHERIT", 0)
              | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NONBLOCK", 0) | getattr(os, "O_NOFOLLOW", 0))


def read_chunk(fd, size):
    """Up to size bytes, short only at the end of the file."""
    parts = []
    got = 0
    while got < size:
        data = os.read(fd, min(size - got, 1 << 20))
        if not data:
            break
        parts.append(data)
        got += len(data)
    return parts[0] if len(parts) == 1 else b"".join(parts)


def hash_file(fs_path):
    """One check of the file, then its content hashed.

    Returns ("-", hash, size, mtime in ms) or ("#error", message)."""
    try:
        fd = os.open(fs_path, OPEN_FLAGS)
    except OSError as e:
        if e.errno == errno.ENOENT:
            return ("#error", "vanished before it was read (%s)" % error_text(e))
        if e.errno in (errno.ELOOP, getattr(errno, "EMLINK", -1)):
            return ("#error", "no longer a regular file (%s)" % error_text(e))
        return ("#error", error_text(e))
    except ValueError as e:
        return ("#error", "can't be opened: %s" % e)
    try:
        st = os.fstat(fd)
        if not stat.S_ISREG(st.st_mode):
            return ("#error", "no longer a regular file")
        size = st.st_size
        ms = round_ms(st.st_mtime_ns)
        digest = hashlib.sha256()
        count = 0
        while True:
            data = os.read(fd, 1 << 20)
            if not data:
                break
            digest.update(data)
            count += len(data)
    except OSError as e:
        return ("#error", error_text(e))
    finally:
        os.close(fd)
    if count != size:
        return ("#error", "read %d bytes of a file whose size was %d: it changed while it was read" % (count, size))
    if instant_text(ms) is None:
        return ("#error", "modification time outside the years 0000 to 9999 (%d ms from 1970)" % ms)
    return ("-", digest.hexdigest(), size, ms)


# --------------------------------------------------------------------------
# The snapshot's text
# --------------------------------------------------------------------------

def trim(field):
    return field.strip(TRIM)


def is_windows_path(path):
    return bool(re.match(r"^(?:[A-Za-z]:[\\/]|[\\/]{2})", path))


def path_segments(path):
    """The segments of an absolute path past its root, or None when it has no root."""
    if is_windows_path(path):
        if path[1] == ":":
            return re.split(r"[\\/]", path[3:])
        return re.split(r"[\\/]", path[2:])
    if path.startswith("/"):
        return path[1:].split("/")
    return None


def real_instant(text):
    m = re.fullmatch(r"(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)\.(\d{3})Z", text, re.A)
    if not m:
        return False
    year, month, day, hour, minute, second = (int(g) for g in m.groups()[:6])
    if not (1 <= month <= 12 and hour <= 23 and minute <= 59 and second <= 59):
        return False
    leap = year % 4 == 0 and (year % 100 != 0 or year % 400 == 0)
    days = (31, 29 if leap else 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31)[month - 1]
    return 1 <= day <= days


def check_snapshot(data, expect_files):
    """Read the finished text back by the spec's rules, before it is published.

    Raises Stop for anything a reader would refuse, whole or one path at a
    time, and for a line that is not in canonical form: each would be this
    program's own fault, and none of them belongs in a bucket."""
    def bad(why):
        raise Stop("internal check failed, nothing was published: " + why)

    if data.startswith(b"\xef\xbb\xbf"):
        bad("the text starts with a BOM")
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError as e:
        bad("the text is not UTF-8 (%s)" % e)
    if "\r" in text:
        bad("the text holds a CR")
    if not text.endswith("\n.\n"):
        bad("the text does not end with the '.' line")
    lines = text[:-2].split("\n")
    if lines.pop() != "":
        bad("the last row is not ended by LF")
    dirs, counts, rows, seen = [], {}, [], set()
    for number, line in enumerate(lines, 1):
        fields = line.split("\t")
        if len(fields) != 5:
            bad("line %d has %d fields" % (number, len(fields)))
        if trim(line.replace("\t", "")) == "":
            bad("line %d is blank" % number)
        kind, second, third, fourth = (trim(f) for f in fields[:4])
        last = fields[4]
        if line + "\n" != canonical_row(kind, second, third, fourth, last):
            bad("line %d is not in canonical form" % number)
        if number == 1:
            if (kind, second, third, fourth, last) != HEADING:
                bad("the first line is not the heading row")
            continue
        if kind == ".":
            bad("line %d reads as a second '.'" % number)
        if kind == "-":
            if not re.fullmatch(r"[0-9a-f]{64}", second):
                bad("line %d: hash" % number)
            if not re.fullmatch(r"[0-9]+", third, re.A):
                bad("line %d: size" % number)
            if not real_instant(fourth):
                bad("line %d: time" % number)
            segments = path_segments(last)
            if segments is None or "\0" in last or any(s in ("", ".", "..") for s in segments):
                bad("line %d: path %s" % (number, show(last)))
            rows.append((second, int(third), last))
        elif kind.startswith("#"):
            if third or fourth:
                bad("line %d: a # row with a size or a time" % number)
            if path_segments(last) is None:
                bad("line %d: path %s is not absolute" % (number, show(last)))
        elif kind.startswith("@"):
            counts[(kind, second)] = counts.get((kind, second), 0) + 1
            if (kind, second) == ("@SET", "DIR"):
                dirs.append(last)
            if (kind, second) == ("@SNAPSHOT", "FILES") and last != str(len(expect_files)):
                bad("FILES is %s for %d file rows" % (last, len(expect_files)))
            continue
        else:
            bad("line %d has an unknown type %s" % (number, show(kind)))
        if last in seen:
            bad("line %d: path %s is in two rows" % (number, show(last)))
        seen.add(last)
    for key in (("@S3CAB", "SPEC"), ("@CLIENT", "NAME"), ("@CLIENT", "VERSION"),
                ("@SET", "NAME"), ("@SNAPSHOT", "NAME"), ("@SNAPSHOT", "BY"), ("@SNAPSHOT", "START"),
                ("@SNAPSHOT", "FILES"), ("@SNAPSHOT", "SIZE"), ("@SNAPSHOT", "FINISH")):
        if counts.get(key, 0) != 1:
            bad("%s %s appears %d times" % (key[0], key[1], counts.get(key, 0)))
    if not dirs:
        bad("no @SET DIR row")
    for d in dirs:
        segments = path_segments(d)
        if segments is None or (d[-1] != "/" and not (is_windows_path(d) and d[-1] == "\\")):
            bad("@SET DIR %s" % show(d))
    if rows != expect_files:
        bad("the file rows read back are not the ones written")
    file_paths = set(path for _, _, path in rows)
    for _, _, path in rows:
        under = [d for d in dirs if path.startswith(d)]
        if not under:
            bad("file row %s is under no @SET DIR" % show(path))
        windows = is_windows_path(path)
        for i, ch in enumerate(path):
            if (ch == "/" or (windows and ch == "\\")) and path[:i] in file_paths:
                bad("file row %s runs through file row %s" % (show(path), show(path[:i])))
    if not lines or not lines[-1].startswith("@SNAPSHOT\tFINISH"):
        bad("the line before the '.' is not @SNAPSHOT FINISH")


# --------------------------------------------------------------------------
# The bucket
# --------------------------------------------------------------------------

def parse_key_values(data):
    """A .info or lock file: KEY=value lines, the last of a repeated key counting."""
    found = {}
    for line in data.decode("utf-8", "replace").split("\n"):
        if line.endswith("\r"):
            line = line[:-1]
        if "=" in line:
            key, value = line.split("=", 1)
            found[key] = value
    return found


class Bucket:
    def __init__(self, name, endpoint):
        import boto3
        import botocore.exceptions
        from botocore.config import Config
        self.ClientError = botocore.exceptions.ClientError
        self.name = name
        self.endpoint = endpoint
        region = os.environ.get("AWS_REGION") or os.environ.get("AWS_DEFAULT_REGION") or "us-east-1"
        options = {
            "region_name": region,
            # standard mode: a refused digest is not sent again; a 5xx and a dropped connection are.
            "config": Config(retries={"mode": "standard"}, connect_timeout=10, read_timeout=60),
        }
        if endpoint:
            options["endpoint_url"] = endpoint
        self._options = options
        self._boto3 = boto3
        self.no_overwrite = False
        self.unanswered = False      # a request left without an answer may still be in flight
        self._connect()

    def _connect(self):
        self.s3 = self._boto3.client("s3", **self._options)
        self.s3.meta.events.register("before-call.s3.PutObject", self._add_condition)
        self.s3.meta.events.register("before-call.s3.CompleteMultipartUpload", self._add_condition)

    def _add_condition(self, params, **kwargs):
        if self.no_overwrite:
            params["headers"]["If-None-Match"] = "*"

    def call(self, operation, **arguments):
        """One request.  An answer, even a refusal, means it is over; anything else leaves it unanswered."""
        self.unanswered = True
        try:
            result = getattr(self.s3, operation)(**arguments)
        except self.ClientError:
            self.unanswered = False
            raise
        self.unanswered = False
        return result

    def settle(self):
        """Before the lock goes: let nothing of this run still be on its way to the bucket.

        A request cut off by an interrupt or a timeout has no answer, and may yet land. Its
        connection is dropped, so nothing more of it is sent, and what S3 already holds whole
        is given a moment to land before the lock that covers it is removed."""
        if not self.unanswered:
            return
        self.close()
        time.sleep(5)
        self._connect()
        self.unanswered = False

    def close(self):
        try:
            self.s3.close()
        except Exception:
            pass

    @staticmethod
    def code(error):
        return str(error.response.get("Error", {}).get("Code", ""))

    @staticmethod
    def status(error):
        return error.response.get("ResponseMetadata", {}).get("HTTPStatusCode")

    def refused_as_existing(self, error):
        return self.status(error) == 412 or self.code(error) == "PreconditionFailed"

    def put(self, key, body, digest=None, overwrite=False):
        """One PUT of these bytes, refused with 412 where the key holds anything unless overwrite.

        S3 is sent the SHA-256 the bytes must have, and stores nothing on a mismatch."""
        if digest is None:
            digest = hashlib.sha256(body).digest()
        self.no_overwrite = not overwrite
        try:
            return self.call("put_object", Bucket=self.name, Key=key, Body=body,
                             ChecksumSHA256=base64.b64encode(digest).decode("ascii"))
        finally:
            self.no_overwrite = False

    def get(self, key):
        """The key's bytes, or None when the bucket holds no such key."""
        try:
            response = self.call("get_object", Bucket=self.name, Key=key)
        except self.ClientError as e:
            if self.status(e) == 404 and self.code(e) in ("NoSuchKey", "NotFound"):
                return None
            raise
        return response["Body"].read()

    def exists(self, key):
        try:
            self.call("head_object", Bucket=self.name, Key=key)
        except self.ClientError as e:
            if self.status(e) == 404 and self.code(e) in ("404", "NotFound", "NoSuchKey"):
                return False
            raise
        return True

    def listing(self, prefix, delimiter=None):
        """Every (key, size, storage class) under the prefix, every page of the listing."""
        options = {"Bucket": self.name, "Prefix": prefix}
        if delimiter:
            options["Delimiter"] = delimiter
        while True:
            page = self.call("list_objects_v2", **options)
            for item in page.get("Contents", []):
                yield item["Key"], item.get("Size"), item.get("StorageClass")
            if not page.get("IsTruncated"):
                return
            options["ContinuationToken"] = page["NextContinuationToken"]

    def keys(self, prefix, delimiter=None):
        for item in self.listing(prefix, delimiter):
            yield item[0]

    def delete(self, key):
        self.call("delete_object", Bucket=self.name, Key=key)


# --------------------------------------------------------------------------
# Locks
# --------------------------------------------------------------------------

class Lock:
    def __init__(self, bucket, set_name, by):
        self.bucket = bucket
        self.set_name = set_name
        self.by = by
        self.os_name = sys.platform
        self.pidns = pid_namespace()
        self.id = None
        self.body = None

    def write(self):
        """Write first..."""
        while True:
            ms = now_ms()                      # the clock again for each try
            started = instant_text(ms)
            lock_id = "upload-" + started.replace("-", "").replace(":", "")
            lines = ["COMMAND=backup", "SET=" + self.set_name, "BY=" + self.by, "OS=" + self.os_name]
            if self.pidns is not None:
                lines.append("PIDNS=" + self.pidns)
            lines += ["PID=%d" % os.getpid(), "STARTED=" + started]
            body = ("\n".join(lines) + "\n").encode("utf-8")
            try:
                self.bucket.put("locks/" + lock_id, body)
            except self.bucket.ClientError as e:
                if not self.bucket.refused_as_existing(e):
                    raise
                if self.bucket.get("locks/" + lock_id) != body:
                    time.sleep(0.002)          # another run took that instant: take a fresh one
                    continue
            self.id = lock_id
            self.body = body
            return

    def prove_no_overwrite(self):
        """Every promise not to overwrite rests on If-None-Match: * being honoured.

        AWS honours it; of other stores the spec says only that they are untested. So ask:
        this run's own lock, sent again with its own bytes, must be refused with 412. A store
        that takes it would as quietly replace a snapshot or another holder's .info."""
        try:
            self.bucket.put("locks/" + self.id, self.body)
        except self.bucket.ClientError as e:
            if self.bucket.refused_as_existing(e):
                return
            raise
        raise Stop("this store accepted a second PUT of locks/%s sent with If-None-Match: *, so it does not "
                   "refuse to overwrite: a snapshot or a set's .info could be replaced, and nothing was uploaded"
                   % self.id)

    def look(self):
        """...look second.  Returns the ids of the delete locks still alive."""
        alive = []
        for key in list(self.bucket.keys("locks/")):
            lock_id = key[len("locks/"):]
            if lock_id == self.id or "/" in lock_id:
                continue
            if not (lock_id.startswith("upload-") or lock_id.startswith("delete-")):
                continue
            body = self.bucket.get(key)
            if body is None:
                continue                       # its run ended between the listing and the read
            if self.is_dead(parse_key_values(body)):
                self.bucket.delete(key)
                say("removed the lock of a dead run: %s" % show(lock_id))
                continue
            if lock_id.startswith("delete-"):
                alive.append(lock_id)
        return alive

    def is_dead(self, fields):
        if fields.get("BY") != self.by:
            return False
        if "OS" not in fields or fields["OS"] != self.os_name:
            return False
        if fields.get("PIDNS") != self.pidns:          # absent on both sides matches
            return False
        pid = fields.get("PID", "")
        if not re.fullmatch(r"[1-9][0-9]*", pid, re.A):
            return False
        if pid == str(os.getpid()):
            return False
        return not process_alive(int(pid))

    def remove(self):
        if self.id is None:
            return
        try:
            self.bucket.delete("locks/" + self.id)
            self.id = None
        except Exception as e:
            warn("could not remove this run's lock, remove it by hand: locks/%s (%s)" % (self.id, e))


# --------------------------------------------------------------------------
# Who holds the set
# --------------------------------------------------------------------------

SNAPSHOT_KEY = re.compile(r"[0-9]{8}T[0-9]{4}\.tsv\.gz", re.A)


class State:
    """The OWNER and CLAIMED this program wrote, kept beside it, per endpoint, bucket and set.

    One small file per claim, so two runs for two sets never rewrite each other's pair."""

    def __init__(self):
        here = os.path.dirname(os.path.abspath(__file__))
        self.folder = os.path.join(here, "s3cab-backup.state")

    def _path(self, endpoint, bucket, set_name):
        tag = hashlib.sha256(("%s\n%s\n%s" % (endpoint, bucket, set_name)).encode("utf-8")).hexdigest()[:16]
        return os.path.join(self.folder, "claim-%s-%s.json" % (set_name, tag))

    def get(self, endpoint, bucket, set_name):
        path = self._path(endpoint, bucket, set_name)
        try:
            with open(path, "r", encoding="utf-8", newline="") as f:
                c = json.load(f)
        except FileNotFoundError:
            return None
        except (OSError, ValueError) as e:
            raise Stop("the kept claim %s can't be read (%s): move it away, and take the set over if it "
                       "is held" % (path, e))
        if not isinstance(c, dict) or (c.get("endpoint"), c.get("bucket"), c.get("set")) != (endpoint, bucket, set_name):
            return None
        return c.get("owner"), c.get("claimed")

    def put(self, endpoint, bucket, set_name, owner, claimed):
        path = self._path(endpoint, bucket, set_name)
        os.makedirs(self.folder, exist_ok=True)
        temp = "%s.%d.tmp" % (path, os.getpid())
        with open(temp, "w", encoding="utf-8", newline="\n") as f:
            json.dump({"endpoint": endpoint, "bucket": bucket, "set": set_name,
                       "owner": owner, "claimed": claimed}, f, indent=1, sort_keys=True)
            f.write("\n")
            f.flush()
            os.fsync(f.fileno())
        os.replace(temp, path)


class Holder:
    def __init__(self, bucket, state, set_name, by):
        self.bucket = bucket
        self.state = state
        self.set_name = set_name
        self.by = by
        self.key = "snapshots/%s.info" % set_name
        self.pair = None

    def snapshot_files(self):
        """The file names of the set's snapshots: the keys directly in its folder, named as one."""
        prefix = "snapshots/%s/" % self.set_name
        return [key[len(prefix):] for key in self.bucket.keys(prefix, delimiter="/")
                if SNAPSHOT_KEY.fullmatch(key[len(prefix):])]

    def has_snapshot(self):
        return bool(self.snapshot_files())

    def matches(self, info):
        fields = parse_key_values(info)
        return (self.pair is not None and None not in self.pair
                and fields.get("OWNER") == self.pair[0] and fields.get("CLAIMED") == self.pair[1])

    def _create(self, what):
        """A conditional PUT of a fresh .info, CREATED equal to CLAIMED."""
        claimed = instant_text(now_ms())               # the clock, read as the claim is made
        body = ("OWNER=%s\nCLAIMED=%s\nCREATED=%s\n" % (self.by, claimed, claimed)).encode("utf-8")
        self.pair = (self.by, claimed)
        # Kept before the PUT: a pair that matches nothing is harmless, a claim with no pair is not.
        self.state.put(self.bucket.endpoint, self.bucket.name, self.set_name, self.by, claimed)
        try:
            self.bucket.put(self.key, body)
        except self.bucket.ClientError as e:
            if not self.bucket.refused_as_existing(e):
                raise
            if self.bucket.get(self.key) != body:      # its own bytes: its own write, retried
                raise Stop("the set name %s was taken in the bucket as this run claimed it" % self.set_name)
        say("%s set %s for %s (CLAIMED %s)" % (what, self.set_name, self.by, claimed))

    def begin(self, takeover):
        """Before the walk: be the holder, become it, or refuse."""
        self.pair = self.state.get(self.bucket.endpoint, self.bucket.name, self.set_name)
        info = self.bucket.get(self.key)
        if info is not None:
            if self.matches(info):
                return
            fields = parse_key_values(info)
            if not takeover:
                raise Stop("the set %s is held by %s (CLAIMED %s), and not by this program's claim: "
                           "take it over with --takeover, if that is what you mean to do"
                           % (self.set_name, show(fields.get("OWNER", "?")), show(fields.get("CLAIMED", "?"))))
            claimed = instant_text(now_ms())
            created = fields.get("CREATED") or claimed
            keep = []
            for line in info.decode("utf-8", "replace").split("\n"):
                line = line[:-1] if line.endswith("\r") else line
                if "=" in line and line.split("=", 1)[0] not in ("OWNER", "CLAIMED", "CREATED"):
                    keep.append(line)
            lines = ["OWNER=" + self.by, "CLAIMED=" + claimed, "CREATED=" + created] + keep
            body = ("\n".join(lines) + "\n").encode("utf-8")
            self.pair = (self.by, claimed)
            self.state.put(self.bucket.endpoint, self.bucket.name, self.set_name, self.by, claimed)
            self.bucket.put(self.key, body, overwrite=True)
            say("took over set %s from %s (CLAIMED %s)" % (self.set_name, show(fields.get("OWNER", "?")), claimed))
            return
        if self.has_snapshot():
            if not takeover:
                raise Stop("the set %s has snapshots and no .info, so no holder: "
                           "take it over with --takeover, if that is what you mean to do" % self.set_name)
            self._create("took over")
            return
        self._create("claimed new")

    def check(self):
        """Immediately before the snapshot's upload."""
        info = self.bucket.get(self.key)
        if info is None:
            raise Stop("%s has gone from the bucket: the set has no holder, and the snapshot was not published"
                       % self.key)
        if not self.matches(info):
            fields = parse_key_values(info)
            raise Stop("the set %s is now held by %s (CLAIMED %s): the snapshot was not published"
                       % (self.set_name, show(fields.get("OWNER", "?")), show(fields.get("CLAIMED", "?"))))


# --------------------------------------------------------------------------
# Objects
# --------------------------------------------------------------------------

class Uploader:
    def __init__(self, bucket):
        self.bucket = bucket
        self.open_upload = None      # (key, upload id) of a multipart upload not yet completed or aborted

    def stored_hashes(self):
        """What the bucket's own listing of objects/ says is stored: each hash, with the
        length and the storage class it lists."""
        stored = {}
        for key, size, storage in self.bucket.listing("objects/"):
            m = re.fullmatch(r"objects/([0-9a-f]{64})", key)
            if m:
                stored[m.group(1)] = (size, storage)
        return stored

    def abort_open(self):
        if self.open_upload is None:
            return
        key, upload_id = self.open_upload
        try:
            self.bucket.call("abort_multipart_upload", Bucket=self.bucket.name, Key=key, UploadId=upload_id)
            self.open_upload = None
        except Exception as e:
            if isinstance(e, self.bucket.ClientError) and self.bucket.code(e) == "NoSuchUpload":
                self.open_upload = None          # already completed or aborted: nothing is left open
                return
            warn("could not abort the multipart upload %s of %s, abort it by hand (%s)" % (upload_id, key, e))

    def send(self, fs_path, digest_hex, size, ms):
        """Store one file's bytes at objects/<digest_hex>.

        Returns "sent", or "there" when the bucket refused the upload because the key
        already holds an object, or else the reason nothing was sent, in brackets.
        The size and time are checked against the row first; the bytes that go
        out are the bytes hashed here, and S3 is given the digest they must have,
        so nothing becomes visible under the key unless it hashes to the key."""
        key = "objects/" + digest_hex
        try:
            fd = os.open(fs_path, OPEN_FLAGS)
        except (OSError, ValueError) as e:
            return "[can't be opened again: %s]" % (error_text(e) if isinstance(e, OSError) else e)
        try:
            st = os.fstat(fd)
            if not stat.S_ISREG(st.st_mode):
                return "[no longer a regular file]"
            if st.st_size != size or round_ms(st.st_mtime_ns) != ms:
                return "[size or modification time changed since it was hashed]"
            if size < PART_SIZE:
                body = read_chunk(fd, size + 1)
                if len(body) != size or hashlib.sha256(body).hexdigest() != digest_hex:
                    return "[content changed since it was hashed]"
                try:
                    self.bucket.put(key, body, digest=bytes.fromhex(digest_hex))
                except self.bucket.ClientError as e:
                    if self.bucket.refused_as_existing(e):
                        return "there"                   # 412: the bucket's word that it is stored
                    if self.bucket.code(e) in ("BadDigest", "XAmzContentSHA256Mismatch"):
                        return "[arrived as other bytes than were sent (%s), so nothing was stored]" % self.bucket.code(e)
                    raise
                return "sent"
            return self._send_in_parts(fd, key, digest_hex, size)
        except OSError as e:
            return "[can't be read again: %s]" % error_text(e)
        finally:
            os.close(fd)

    def _send_in_parts(self, fd, key, digest_hex, size):
        call, name = self.bucket.call, self.bucket.name
        part_size = max(PART_SIZE, -(-size // MAX_PARTS))
        upload_id = call("create_multipart_upload", Bucket=name, Key=key, ChecksumAlgorithm="SHA256")["UploadId"]
        self.open_upload = (key, upload_id)
        try:
            whole = hashlib.sha256()
            total = 0
            parts = []
            while True:
                chunk = read_chunk(fd, part_size)
                if not chunk:
                    break
                whole.update(chunk)
                total += len(chunk)
                if total > size:
                    break
                checksum = base64.b64encode(hashlib.sha256(chunk).digest()).decode("ascii")
                number = len(parts) + 1
                answer = call("upload_part", Bucket=name, Key=key, UploadId=upload_id, PartNumber=number,
                              Body=chunk, ChecksumSHA256=checksum)
                parts.append({"PartNumber": number, "ETag": answer["ETag"], "ChecksumSHA256": checksum})
            if total != size or whole.hexdigest() != digest_hex:
                return "[content changed since it was hashed]"        # aborted below: nothing stored
            self.bucket.no_overwrite = True
            try:
                call("complete_multipart_upload", Bucket=name, Key=key, UploadId=upload_id,
                     MultipartUpload={"Parts": parts})
            except self.bucket.ClientError as e:
                if self.bucket.refused_as_existing(e):
                    return "there"                       # 412: already stored; the upload is aborted below
                raise
            finally:
                self.bucket.no_overwrite = False
            self.open_upload = None
            return "sent"
        finally:
            self.abort_open()


# --------------------------------------------------------------------------
# The run
# --------------------------------------------------------------------------

USAGE = "usage: python s3cab-backup.py [--takeover] <bucket> <set> <dir>..."


def parse_arguments(argv):
    takeover = False
    rest = []
    options = True
    for a in argv:
        if options and a == "--":
            options = False
        elif options and a == "--takeover":
            takeover = True
        elif options and a in ("-h", "--help"):
            say(__doc__.strip())
            say("\n" + USAGE)
            say("\n--takeover  make this program the set's holder when another holds it, or when\n"
                "            its .info is gone: a person's decision, never made without being asked")
            sys.exit(EXIT_OK)
        elif options and a.startswith("--"):
            raise Stop("unknown option %s\n%s" % (a, USAGE))
        else:
            rest.append(a)
    if len(rest) < 3:
        raise Stop(USAGE)
    bucket = rest[0]
    if bucket.startswith("s3://"):
        bucket = bucket[5:]
    bucket = bucket.rstrip("/")
    if not bucket or "/" in bucket or any(c in bucket for c in "\t\r\n"):
        raise Stop("not a bucket name: %s" % show(loose_text(rest[0])))
    set_name = rest[1]
    if not re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", set_name, re.A):
        raise Stop("not a set name: %s -- a set's name is a to z and digits, with single hyphens between them"
                   % show(loose_text(set_name)))
    return bucket, set_name, rest[2:], takeover


def run(argv):
    start_ns = time.time_ns()            # one clock reading: START's instant and the snapshot's name
    start_ms = start_ns // 1000000
    bucket_name, set_name, typed_dirs, takeover = parse_arguments(argv)
    by = user_at_machine()
    endpoint = os.environ.get("AWS_ENDPOINT_URL_S3") or os.environ.get("AWS_ENDPOINT_URL") or ""

    members = [Member(d) for d in typed_dirs]
    for i, member in enumerate(members):
        for other in members[:i]:
            if other.text == member.text:
                raise Stop("a member directory is named twice: %s -- change the set" % show(member.text))

    local = time.localtime(start_ns // 1000000000)
    snapshot_name = "%04d%02d%02dT%02d%02d" % (local.tm_year, local.tm_mon, local.tm_mday,
                                               local.tm_hour, local.tm_min)
    snapshot_key = "snapshots/%s/%s.tsv.gz" % (set_name, snapshot_name)

    bucket = Bucket(bucket_name, endpoint)
    lock = Lock(bucket, set_name, by)
    uploader = Uploader(bucket)
    try:
        # Write first, look second.
        lock.write()
        lock.prove_no_overwrite()
        deletes = lock.look()
        if deletes:
            raise Stop("a delete is running in this bucket (locks/%s): nothing was uploaded. "
                       "Run again when it has finished" % ", locks/".join(show(d) for d in deletes))

        holder = Holder(bucket, State(), set_name, by)
        holder.begin(takeover)

        walk = Walk(members)
        walk.run()
        say("walked %d member director%s: %d file%s to hash, %d entr%s in error"
            % (len(members), "y" if len(members) == 1 else "ies", len(walk.files),
               "" if len(walk.files) == 1 else "s", len(walk.errors), "y" if len(walk.errors) == 1 else "ies"))

        # The same early answer a local copy would give; the conditional PUT still decides.
        if bucket.exists(snapshot_key):
            raise Stop("%s is already in the bucket: a second snapshot of a set in the same minute is refused, "
                       "never an overwrite. Run again in a minute" % snapshot_key)
        later = [f for f in holder.snapshot_files() if f > snapshot_name + ".tsv.gz"]
        if later:
            warn("warning: this snapshot's name, %s, sorts before %d already in the set (the last is %s): "
                 "the clock has gone back, and a reader taking the last name as the latest will not take this one"
                 % (snapshot_name, len(later), max(later)[:-7]))

        # Spelling a tab, CR or LF out must not make two rows' paths read as one.
        written = set(text_path for _, text_path in walk.files)
        for _, text_path in walk.errors:
            spelled = picture(text_path)
            if spelled in written:
                raise Stop("two entries' paths read the same once a tab, CR or LF is spelled out, "
                           "and a path may be in one row only: %s -- rename one" % show(spelled))
            written.add(spelled)

        body_rows = []                   # in order: ("-", hash, size, ms, path) or ("#error", message, path)
        for fs_path, text_path in walk.files:
            result = hash_file(fs_path)
            if result[0] == "-":
                body_rows.append(("-", result[1], result[2], result[3], text_path))
            else:
                body_rows.append(("#error", result[1], text_path))
        finish_ms = -(-time.time_ns() // 1000000)      # every row before FILES is known: rounded up

        file_rows = [r for r in body_rows if r[0] == "-"]
        error_count = len(walk.errors) + len(body_rows) - len(file_rows)
        total = sum(r[2] for r in file_rows)

        lines = [canonical_row(*HEADING),
                 property_row("@S3CAB", "SPEC", SPEC_DATE),
                 property_row("@CLIENT", "NAME", CLIENT_NAME),
                 property_row("@CLIENT", "VERSION", CLIENT_VERSION),
                 property_row("@SET", "NAME", set_name),
                 property_row("@SET", "BUCKET", "s3://" + bucket_name)]
        if endpoint:
            lines.append(property_row("@SET", "ENDPOINT", endpoint))
        for member in members:
            lines.append(property_row("@SET", "DIR", member.text))
        lines += [property_row("@SNAPSHOT", "NAME", snapshot_name),
                  property_row("@SNAPSHOT", "BY", by),
                  property_row("@SNAPSHOT", "START", zone_name(start_ns // 1000000000), instant_text(start_ms))]
        for message, text_path in walk.errors:
            lines.append(canonical_row("#error", message_text(message), "", "", picture(text_path)))
        for r in body_rows:
            if r[0] == "-":
                lines.append(canonical_row("-", r[1], "%d" % r[2], instant_text(r[3]), r[4]))
            else:
                lines.append(canonical_row("#error", message_text(r[1]), "", "", picture(r[2])))
        lines += [property_row("@SNAPSHOT", "FILES", "%d" % len(file_rows)),
                  property_row("@SNAPSHOT", "SIZE", "%d (%s)" % (total, readable_size(total))),
                  property_row("@SNAPSHOT", "FINISH", duration_text(finish_ms - start_ms), instant_text(finish_ms)),
                  ".\n"]
        text = "".join(lines).encode("utf-8")
        check_snapshot(text, [(r[1], r[2], r[4]) for r in file_rows])

        packed = io.BytesIO()
        with gzip.GzipFile(filename="", mode="wb", compresslevel=9, fileobj=packed, mtime=0) as gz:
            gz.write(text)
        packed = packed.getvalue()
        if gzip.decompress(packed) != text:
            raise Stop("internal check failed, nothing was published: the gzip stream does not read back")

        # Objects first.  Content several paths share is sent once, from any path that still holds it.
        stored = uploader.stored_hashes()
        paths_of = {}
        for r in file_rows:
            paths_of.setdefault(r[1], []).append(r)
        fs_of = dict((text_path, fs_path) for fs_path, text_path in walk.files)
        sent = listed = there = 0
        failed = []
        damaged = []
        for digest_hex, rows in paths_of.items():
            if digest_hex in stored:
                listed += 1
                # Stored, on the bucket's word.  A length that is not the file's is damage, and an
                # archive class is an object no plain GET reads; this run can mend neither, since
                # the PUT that would store it again is refused while the key holds anything.  The
                # snapshot still names it, so say so, and exit nonzero.
                length, storage = stored[digest_hex]
                if length is not None and length != rows[0][2]:
                    damaged.append((digest_hex, "holds %d bytes, and the content it is named for has %d"
                                    % (length, rows[0][2]), rows))
                elif storage in ("GLACIER", "DEEP_ARCHIVE"):
                    damaged.append((digest_hex, "is in the storage class %s, which a plain GET cannot read"
                                    % storage, rows))
                continue
            reasons = []
            for r in rows:
                outcome = uploader.send(fs_of[r[4]], digest_hex, r[2], r[3])
                if outcome in ("sent", "there"):
                    break
                reasons.append("%s %s" % (show(r[4]), outcome))
            else:
                failed.append((digest_hex, reasons))
                continue
            if outcome == "there":
                there += 1
                continue
            sent += 1
            if sent % 100 == 0:
                say("  ...%d objects sent" % sent)
        say("objects: %d sent, %d already stored (%d listed, %d refused as already there), %d not stored"
            % (sent, listed + there, listed, there, len(failed)))
        if failed:
            for digest_hex, reasons in failed:
                for reason in reasons:
                    warn("not stored: objects/%s: %s" % (digest_hex, reason))
            raise Stop("%d object%s could not be stored as hashed, so the snapshot naming %s was not published. "
                       "Run a fresh backup" % (len(failed), "" if len(failed) == 1 else "s",
                                               "it" if len(failed) == 1 else "them"))

        # Snapshot last: the holder checked immediately before, the upload refused over any other bytes.
        holder.check()
        try:
            bucket.put(snapshot_key, packed)
        except bucket.ClientError as e:
            if not bucket.refused_as_existing(e):
                raise
            if bucket.get(snapshot_key) != packed:
                raise Stop("%s is already in the bucket with other bytes: a second snapshot of a set in the "
                           "same minute is refused, never an overwrite. Run again in a minute" % snapshot_key)
        say("published s3://%s/%s: %d file%s, %d bytes (%s)"
            % (bucket_name, snapshot_key, len(file_rows), "" if len(file_rows) == 1 else "s",
               total, readable_size(total)))
        for digest_hex, why, rows in damaged:
            warn("not restorable as stored: objects/%s %s. This run could not replace it, so these files "
                 "will not restore from this snapshot: %s"
                 % (digest_hex, why, ", ".join(show(r[4]) for r in rows)))
        if error_count:
            for message, text_path in walk.errors:
                warn("#error %s: %s" % (show(picture(text_path)), show(message_text(message))))
            for r in body_rows:
                if r[0] != "-":
                    warn("#error %s: %s" % (show(picture(r[2])), show(message_text(r[1]))))
            warn("%d entr%s not backed up: see the #error rows above, and in the snapshot"
                 % (error_count, "y was" if error_count == 1 else "ies were"))
        if error_count or damaged:
            return EXIT_INCOMPLETE
        return EXIT_OK
    finally:
        # One request at a time, so none is in flight unless the last was left without an answer.
        try:
            bucket.settle()
            uploader.abort_open()
        finally:
            lock.remove()
            bucket.close()


def main():
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="backslashreplace")
        except Exception:
            pass
    if sys.version_info < (3, 10):
        warn("s3cab-backup.py needs Python 3.10 or later")
        return EXIT_STOPPED

    def terminated(signum, frame):
        raise KeyboardInterrupt()
    try:
        signal.signal(signal.SIGTERM, terminated)
    except Exception:
        pass

    try:
        return run(sys.argv[1:])
    except Stop as e:
        warn("stopped: %s" % e)
        return EXIT_STOPPED
    except KeyboardInterrupt:
        warn("stopped: interrupted; no snapshot was published")
        return EXIT_STOPPED
    except Exception as e:
        name = e.__class__.__name__
        if e.__class__.__module__.startswith(("botocore", "boto3", "urllib3")):
            warn("stopped: the bucket could not be reached or refused a request (%s: %s); "
                 "no snapshot was published" % (name, e))
            return EXIT_STOPPED
        import traceback
        traceback.print_exc()
        warn("stopped: an error in this program (%s); no snapshot was published" % name)
        return EXIT_STOPPED


if __name__ == "__main__":
    sys.exit(main())
