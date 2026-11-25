#!/usr/bin/env python3
"""s3cab-backup.py: an independent backup writer for the s3cab repository format.

    python s3cab-backup.py <bucket> <set> <dir>...

Written from the format spec of 2026-10-30 alone. It walks the member directories, stores
every file's content at objects/<sha256>, then uploads the snapshot that names them to
snapshots/<set>/<YYYYMMDDTHHMM>.tsv.gz, holding an upload lock and the set's .info claim
as the spec's "writing a snapshot" and "uploading" checklists set out.

Python 3.10+ with the standard library and boto3. Nothing is cached between runs except
the OWNER/CLAIMED pair of each set this program has claimed, kept beside the program in
s3cab-backup.state.json and keyed by endpoint, bucket and set.

Exit status: 0 the snapshot is uploaded and has no #error row; 1 the snapshot is uploaded
with #error rows, or the run stopped or was refused (the last lines say which); 2 usage.
"""

import sys

sys.dont_write_bytecode = True  # this program writes its state file beside itself, and nothing else

import base64
import errno
import hashlib
import json
import os
import re
import socket
import stat
import time
import zlib

SPEC_DATE = "2026-10-30"
CLIENT_NAME = "cleanroom-backup"
CLIENT_VERSION = "1.0.0"
HEADING_URL = "https://s3cab.plantegral.com/guide/format"

WINDOWS = os.name == "nt"
SEP = "\\" if WINDOWS else "/"
PART_SIZE = 16 * 1024 * 1024  # a file this size or more is sent in parts
READ_CHUNK = 1024 * 1024

HASH_RE = re.compile(r"[0-9a-f]{64}\Z")
SET_RE = re.compile(r"[a-z0-9]+(?:-[a-z0-9]+)*\Z")
SNAPSHOT_FILE_RE = re.compile(r"[0-9]{8}T[0-9]{4}\.tsv\.gz\Z")
PID_RE = re.compile(r"[1-9][0-9]*\Z")
INSTANT_RE = re.compile(r"([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})\.([0-9]{3})Z\Z")


class Stop(Exception):
    """The run stops here: no snapshot is written or uploaded."""


# --------------------------------------------------------------------------- text

def spell(text):
    """Tab, CR and LF as the Unicode Control Pictures, for every field but a file row's path."""
    return text.replace("\t", "\u2409").replace("\r", "\u240d").replace("\n", "\u240a")


def show(text):
    """A path or other value made safe to print: control characters and lone surrogates escaped."""
    out = []
    for ch in text:
        o = ord(ch)
        if o < 0x20 or 0x7F <= o <= 0x9F or o in (0x2028, 0x2029):
            out.append("\\x%02x" % o if o < 0x100 else "\\u%04x" % o)
        elif 0xD800 <= o <= 0xDFFF:
            out.append("\\u%04x" % o)
        else:
            out.append(ch)
    return "".join(out)


def has_utf8_form(text):
    try:
        text.encode("utf-8")
        return True
    except UnicodeEncodeError:
        return False


def say(message):
    print(message, flush=True)


# --------------------------------------------------------------------------- instants

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


def instant_fields(ms):
    days, rest = divmod(ms, 86400000)
    year, month, day = civil_from_days(days)
    hour, rest = divmod(rest, 3600000)
    minute, rest = divmod(rest, 60000)
    second, milli = divmod(rest, 1000)
    return year, month, day, hour, minute, second, milli


def instant_text(ms):
    """Milliseconds since 1970 as YYYY-MM-DDTHH:MM:SS.sssZ, or None outside the years 0000 to 9999."""
    f = instant_fields(ms)
    if not 0 <= f[0] <= 9999:
        return None
    return "%04d-%02d-%02dT%02d:%02d:%02d.%03dZ" % f


def instant_basic(ms):
    """The same instant in ISO 8601's basic form, as a lock's key spells it."""
    return "%04d%02d%02dT%02d%02d%02d.%03dZ" % instant_fields(ms)


def round_ms(ns):
    """Nanoseconds to the nearest millisecond, a tie to the later one."""
    return (ns + 500000) // 1000000


def now_ms_down():
    return time.time_ns() // 1000000


def now_ms_up():
    return -(-time.time_ns() // 1000000)


def zone_name():
    """The best name there is for the local time zone. Written for people."""
    tz = os.environ.get("TZ")
    if tz:
        return tz[1:] if tz.startswith(":") and len(tz) > 1 else tz
    if WINDOWS:
        try:
            import ctypes
            path = os.path.join(os.environ.get("SystemRoot", r"C:\Windows"), "System32", "icu.dll")
            icu = ctypes.CDLL(path)
            buf = ctypes.create_unicode_buffer(256)
            status = ctypes.c_int(0)
            icu.ucal_getDefaultTimeZone.restype = ctypes.c_int32
            n = icu.ucal_getDefaultTimeZone(buf, 256, ctypes.byref(status))
            if status.value <= 0 and 0 < n < 256 and buf.value:
                return buf.value
        except Exception:
            pass
    else:
        try:
            real = os.path.realpath("/etc/localtime")
            marker = "zoneinfo/"
            at = real.rfind(marker)
            if at >= 0 and real[at + len(marker):]:
                return real[at + len(marker):]
        except Exception:
            pass
    try:
        name = time.tzname[1 if time.localtime().tm_isdst > 0 else 0]
        if name:
            return name
    except Exception:
        pass
    return "unknown"


def duration_text(ms):
    seconds = (max(ms, 0) + 500) // 1000
    if seconds < 60:
        return "%ds" % seconds
    if seconds < 3600:
        return "%dm %02ds" % (seconds // 60, seconds % 60)
    return "%dh %02dm" % (seconds // 3600, (seconds % 3600) // 60)


def readable_size(n):
    if n < 1000:
        return "%dB" % n
    units = ("kB", "MB", "GB", "TB", "PB")
    for i, unit in enumerate(units):
        scale = 1000 ** (i + 1)
        tenths = (n * 20 + scale) // (2 * scale)  # one decimal place, rounded half up
        if tenths < 10000 or unit == "PB":
            return "%d.%d%s" % (tenths // 10, tenths % 10, unit)


# --------------------------------------------------------------------------- who and where

def user_at_machine():
    user = None
    try:
        if WINDOWS:
            user = os.getlogin()
        else:
            import pwd
            user = pwd.getpwuid(os.geteuid()).pw_name
    except Exception:
        user = None
    if not user:
        import getpass
        user = getpass.getuser()
    text = spell("%s@%s" % (user, socket.gethostname()))
    return text.encode("utf-8", "replace").decode("utf-8")


def pid_namespace():
    if sys.platform.startswith("linux"):
        try:
            return os.readlink("/proc/self/ns/pid")
        except OSError:
            return None
    return None


def process_alive(pid):
    """Whether a process with this id exists. Anything that can't be told counts as alive."""
    if WINDOWS:
        import ctypes
        from ctypes import wintypes
        if pid > 0xFFFFFFFF:
            return True
        k32 = ctypes.WinDLL("kernel32", use_last_error=True)
        k32.OpenProcess.restype = wintypes.HANDLE
        k32.OpenProcess.argtypes = (wintypes.DWORD, wintypes.BOOL, wintypes.DWORD)
        k32.GetExitCodeProcess.argtypes = (wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD))
        k32.CloseHandle.argtypes = (wintypes.HANDLE,)
        handle = k32.OpenProcess(0x1000, False, pid)  # PROCESS_QUERY_LIMITED_INFORMATION
        if not handle:
            return ctypes.get_last_error() != 87  # 87: no such process; 5: alive, another user's
        try:
            code = wintypes.DWORD(0)
            if not k32.GetExitCodeProcess(handle, ctypes.byref(code)):
                return True
            return code.value == 259  # STILL_ACTIVE
        finally:
            k32.CloseHandle(handle)
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except OSError:
        return True
    return True


# --------------------------------------------------------------------------- paths

def fs(path):
    r"""The path to hand the operating system. On Windows that is through \\?\, which takes
    every name exactly as written: a trailing dot or space, a reserved name, any length."""
    if not WINDOWS or path.startswith("\\\\?\\"):
        return path
    if path.startswith("\\\\"):
        return "\\\\?\\UNC\\" + path[2:]
    return "\\\\?\\" + path


def unprefixed(path):
    if path.startswith("\\\\?\\UNC\\"):
        return "\\\\" + path[8:]
    if path.startswith("\\\\?\\"):
        return path[4:]
    return path


def windows_absolute(path):
    """An absolute path made with normpath, which keeps a name's trailing dot or space."""
    if path.startswith("\\\\?\\"):
        return path
    p = os.path.normpath(path)
    drive, tail = os.path.splitdrive(p)
    if not tail.startswith("\\"):
        base = os.path.abspath(drive) if drive else os.getcwd()
        p = base if tail in ("", ".") else os.path.join(base, tail)
    elif not drive:
        p = os.path.splitdrive(os.getcwd())[0] + tail
    return os.path.normpath(p)


def spelled_from_listings(real):
    """A POSIX real path with each name spelled as its parent's listing spells it, matched
    by the file (device and inode), not by the name. A parent that can't be listed keeps the
    name as it came."""
    current = "/"
    for name in [part for part in real.split("/") if part]:
        spelled = name
        try:
            want = os.lstat(current + name)
            found = None
            with os.scandir(current) as it:
                for entry in it:
                    if entry.name == name:
                        found = name
                        break
                    if found is None and entry.inode() == want.st_ino:
                        try:
                            if entry.stat(follow_symlinks=False).st_dev == want.st_dev:
                                found = entry.name
                        except OSError:
                            pass
            if found is not None:
                spelled = found
        except OSError:
            pass
        current = current + spelled + "/"
    return current if current == "/" else current[:-1]


def real_path(path, member):
    """The real path of a directory or link target, spelled as the filesystem spells it,
    without a trailing separator except for a root. Raises OSError as the system does."""
    if WINDOWS:
        typed = windows_absolute(path) if member else path
        real = unprefixed(os.path.realpath(fs(typed), strict=True))
        if re.match(r"[A-Za-z]:", real):
            real = real[0].upper() + real[1:]
        return real
    real = os.path.realpath(path, strict=True)
    real = "/" + real.lstrip("/")
    if member:
        real = spelled_from_listings(real)
    return real


def as_directory(path):
    """A directory's path ending in exactly one separator, so a root stays / or C:\\."""
    return path.rstrip(SEP) + SEP


def under_a_member(target, dirs):
    """Whether a real path is a member directory or lies inside one: whole segments, exactly."""
    t = as_directory(target)
    return any(t.startswith(d) for d in dirs)


def resolve_member(typed):
    """A member directory as typed to its @SET DIR string, or Stop."""
    try:
        real = real_path(typed, member=True)
    except (OSError, ValueError) as ex:
        exists = False
        try:
            exists = stat.S_ISDIR(os.stat(fs(windows_absolute(typed)) if WINDOWS else typed).st_mode)
        except (OSError, ValueError):
            pass
        if exists and WINDOWS:
            raise Stop("member directory %s has no real path with a drive letter or share (%s); "
                       "no path a reader accepts can name it" % (show(typed), failure(ex)))
        raise Stop("member directory %s doesn't exist or can't be resolved: %s" % (show(typed), failure(ex)))
    try:
        if not stat.S_ISDIR(os.stat(fs(real)).st_mode):
            raise Stop("member directory %s isn't a directory" % show(real))
    except OSError as ex:
        raise Stop("member directory %s can't be checked: %s" % (show(real), failure(ex)))
    if WINDOWS:
        drive = re.match(r"[A-Z]:\\", real) is not None
        share = re.match(r"\\\\[^\\?.][^\\]*\\[^\\]+", real) is not None
        if not (drive or share):
            raise Stop("member directory %s has no drive letter and no share in its real path %s; "
                       "no path a reader accepts can name it" % (show(typed), show(real)))
    elif not real.startswith("/"):
        raise Stop("member directory %s has no absolute real path" % show(typed))
    directory = as_directory(real)
    if not has_utf8_form(directory):
        raise Stop("member directory %s has a real path with no UTF-8 form, which no @SET DIR row "
                   "can hold" % show(directory))
    if any(c in directory for c in "\t\r\n"):
        raise Stop("member directory %s has a tab or line ending in its real path, which no "
                   "@SET DIR row can hold" % show(directory))
    return directory


def failure(ex):
    """An OSError as a short message with no path in it."""
    if isinstance(ex, OSError):
        winerror = getattr(ex, "winerror", None)
        text = ex.strerror or ex.__class__.__name__
        if winerror:
            return "WinError %d: %s" % (winerror, text)
        if ex.errno:
            return "%s: %s" % (errno.errorcode.get(ex.errno, "errno %d" % ex.errno), text)
        return text
    return "%s: %s" % (ex.__class__.__name__, ex)


def error_message(text):
    """A message fit for column 2: no tab or line ending, valid UTF-8."""
    return spell(text).encode("utf-8", "replace").decode("utf-8").strip()


# --------------------------------------------------------------------------- the walk

def classify(entry):
    """'file', 'dir', 'link' or 'other' (a pipe, socket or device, or an entry that vanished).
    Raises OSError when the type can't be determined."""
    if WINDOWS:
        st = entry.stat(follow_symlinks=False)  # the listing's own data: no further call
        if (st.st_file_attributes & stat.FILE_ATTRIBUTE_REPARSE_POINT
                and st.st_reparse_tag in (stat.IO_REPARSE_TAG_SYMLINK, stat.IO_REPARSE_TAG_MOUNT_POINT)):
            return "link"  # a symbolic link or a junction; any other reparse point is ordinary
        if st.st_file_attributes & stat.FILE_ATTRIBUTE_DIRECTORY:
            return "dir"
        return "file"
    if entry.is_symlink():
        return "link"
    if entry.is_dir(follow_symlinks=False):
        return "dir"
    if entry.is_file(follow_symlinks=False):
        return "file"
    return "other"


def link_is_broken(ex):
    if WINDOWS:
        return getattr(ex, "winerror", None) in (2, 3, 1921)
    return ex.errno in (errno.ENOENT, errno.ENOTDIR, errno.ELOOP)


def link_row(path, dirs):
    """The #error row a link gets, as (message, path), or None where the spec gives it no row."""
    try:
        held = unprefixed(os.readlink(fs(path)))
    except (OSError, ValueError):
        held = None
    named = (" -> " + held) if held else ""
    try:
        real = real_path(path, member=False)
        st = os.stat(fs(real))
    except (OSError, ValueError) as ex:
        if isinstance(ex, OSError) and link_is_broken(ex):
            # Not found by its real path. A link to a volume with no drive letter fails the
            # same way, though something is there: ask the link itself before calling it broken.
            try:
                through = os.stat(fs(path))
            except (OSError, ValueError):
                return None  # broken: no row
            ending = SEP if stat.S_ISDIR(through.st_mode) else ""
            return (error_message("link to a place with no path a snapshot can name, not followed%s" % named),
                    path + ending)
        return (error_message("link this computer can't resolve, not followed%s (%s)" % (named, failure(ex))),
                path)
    if stat.S_ISDIR(st.st_mode):
        kind, ending = "folder", SEP
    elif stat.S_ISREG(st.st_mode):
        kind, ending = "file", ""
    else:
        return None  # a pipe, socket or device: no row
    inside = under_a_member(real, dirs)
    if not inside and not WINDOWS:
        inside = under_a_member(spelled_from_listings(real), dirs)
    if inside and not as_directory(real).startswith(as_directory(path)):
        return None  # into the backup: the target is recorded where it lies
    if inside:
        # It resolves to itself, as a volume mount point does: nothing records what it holds.
        return (error_message("link to a %s recorded nowhere else, not followed%s" % (kind, named)),
                path + ending)
    return (error_message("link to a %s outside the backup, not followed%s" % (kind, named)), path + ending)


def walk(dirs):
    """Every member directory, without following a link. Returns (rows, files): the #error
    rows the walk found as (message, path), and the regular files' paths, in listing order."""
    rows, files, seen = [], [], set()

    def once(path):
        if path in seen:
            raise Stop("%s turns up under two member directories; change the set so that no "
                       "member directory is inside another" % show(path))
        seen.add(path)

    for top in dirs:
        pending = [top]
        while pending:
            directory = pending.pop()
            try:
                with os.scandir(fs(directory)) as it:
                    entries = list(it)
            except OSError as ex:
                raise Stop("directory %s can't be listed: %s" % (show(directory), failure(ex)))
            below = []
            for entry in entries:
                name = entry.name
                if not has_utf8_form(name):
                    raise Stop("%s has a name with no UTF-8 form (it would read %s), so a snapshot "
                               "can't hold it; rename it or move it out of the set"
                               % (show(directory + name),
                                  show(name.encode("utf-8", "surrogatepass" if WINDOWS else "surrogateescape")
                                       .decode("utf-8", "replace"))))
                path = directory + name
                try:
                    kind = classify(entry)
                except OSError as ex:
                    once(path)
                    rows.append((error_message("type can't be determined (%s)" % failure(ex)), path))
                    continue
                if kind == "file":
                    if any(c in path for c in "\t\r\n"):
                        raise Stop("%s has a tab or line ending in its path, which a file row can't "
                                   "hold; rename it or move it out of the set" % show(path))
                    once(path)
                    files.append(path)
                elif kind == "dir":
                    below.append(path + SEP)
                elif kind == "link":
                    row = link_row(path, dirs)
                    if row is not None:
                        once(row[1])
                        rows.append(row)
            pending.extend(reversed(below))
    return rows, files


# --------------------------------------------------------------------------- files

def open_file(path):
    flags = os.O_RDONLY
    for name in ("O_BINARY", "O_NOINHERIT", "O_SEQUENTIAL", "O_CLOEXEC", "O_NONBLOCK", "O_NOFOLLOW"):
        flags |= getattr(os, name, 0)
    return os.fdopen(os.open(fs(path), flags), "rb", buffering=0)


def is_plain_file(st):
    if not stat.S_ISREG(st.st_mode):
        return False
    if WINDOWS and (getattr(st, "st_file_attributes", 0) & stat.FILE_ATTRIBUTE_REPARSE_POINT
                    and getattr(st, "st_reparse_tag", 0) in (stat.IO_REPARSE_TAG_SYMLINK,
                                                            stat.IO_REPARSE_TAG_MOUNT_POINT)):
        return False
    return True


def hash_file(path):
    """One file to its row: ('-', hash, size, mtime, path) or ('#error', message, path)."""
    def error(text):
        return ("#error", error_message(text), path)

    try:
        before = os.lstat(fs(path))
    except FileNotFoundError:
        return error("gone before it could be read")
    except OSError as ex:
        return error("can't be read (%s)" % failure(ex))
    if not is_plain_file(before):
        return error("no longer a regular file")
    try:
        f = open_file(path)
    except FileNotFoundError:
        return error("gone before it could be read")
    except OSError as ex:
        if not WINDOWS and ex.errno == errno.ELOOP:
            return error("no longer a regular file")
        return error("can't be read (%s)" % failure(ex))
    try:
        with f:
            st = os.fstat(f.fileno())  # one check of the file, just before hashing it
            if not stat.S_ISREG(st.st_mode):
                return error("no longer a regular file")
            mtime = instant_text(round_ms(st.st_mtime_ns))
            if mtime is None:
                return error("modification time is outside the years 0000 to 9999")
            digest = hashlib.sha256()
            count = 0
            while True:
                chunk = f.read(READ_CHUNK)
                if not chunk:
                    break
                digest.update(chunk)
                count += len(chunk)
            if count != st.st_size:
                return error("read returned %d bytes of a file %d bytes long" % (count, st.st_size))
            return ("-", digest.hexdigest(), st.st_size, mtime, path)
    except OSError as ex:
        return error("can't be read (%s)" % failure(ex))


# --------------------------------------------------------------------------- the snapshot text

def line(kind, second="", size="", instant="", last=""):
    """One canonical line: column 1 unpadded, 2 to 4 padded to 64, 12 and 24, the last verbatim."""
    return "%s\t%s\t%s\t%s\t%s\n" % (kind, second.ljust(64), size.rjust(12), instant.ljust(24), last)


def snapshot_text(run, walk_rows, file_rows, finish_ms):
    out = [line("@S3CAB", "FORMAT", "size", "time", HEADING_URL),
           line("@S3CAB", "SPEC", last=SPEC_DATE),
           line("@CLIENT", "NAME", last=CLIENT_NAME),
           line("@CLIENT", "VERSION", last=CLIENT_VERSION),
           line("@SET", "NAME", last=run["set"]),
           line("@SET", "BUCKET", last="s3://" + run["bucket"])]
    if run["endpoint"]:
        out.append(line("@SET", "ENDPOINT", last=spell(run["endpoint"])))
    for directory in run["dirs"]:
        out.append(line("@SET", "DIR", last=directory))
    out.append(line("@SNAPSHOT", "NAME", last=run["name"]))
    out.append(line("@SNAPSHOT", "BY", last=run["by"]))
    out.append(line("@SNAPSHOT", "START", instant=instant_text(run["start_ms"]), last=spell(run["zone"])))
    for message, path in walk_rows:
        out.append(line("#error", message, last=spell(path)))
    count = total = 0
    for row in file_rows:
        if row[0] == "-":
            out.append(line("-", row[1], str(row[2]), row[3], row[4]))
            count += 1
            total += row[2]
        else:
            out.append(line("#error", row[1], last=spell(row[2])))
    out.append(line("@SNAPSHOT", "FILES", last=str(count)))
    out.append(line("@SNAPSHOT", "SIZE", last="%d (%s)" % (total, readable_size(total))))
    out.append(line("@SNAPSHOT", "FINISH", instant=instant_text(finish_ms),
                    last=duration_text(finish_ms - run["start_ms"])))
    out.append(".\n")
    return "".join(out)


def gzip_one_stream(data):
    """Plain single-stream gzip with no name and no time in its header."""
    packer = zlib.compressobj(9, zlib.DEFLATED, 31)
    return packer.compress(data) + packer.flush()


TRIM = ("\t\n\v\f\r \u00a0\u1680" + "".join(chr(c) for c in range(0x2000, 0x200B))
        + "\u202f\u205f\u3000\u2028\u2029\ufeff")


def real_instant(text):
    m = INSTANT_RE.match(text)
    if not m:
        return False
    year, month, day, hour, minute, second, _ = (int(g) for g in m.groups())
    if not (1 <= month <= 12 and hour <= 23 and minute <= 59 and second <= 59):
        return False
    leap = year % 4 == 0 and (year % 100 != 0 or year % 400 == 0)
    return 1 <= day <= (31, 29 if leap else 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31)[month - 1]


def path_parts(path):
    """(kind, root, segments) of an absolute path as the spec tells a Windows path from a
    POSIX one, or None when it isn't absolute."""
    if re.match(r"[A-Za-z]:[\\/]", path):
        rest = path[3:]
        return "windows", path[0].upper() + ":", re.split(r"[\\/]", rest) if rest else []
    if len(path) >= 2 and path[0] in "\\/" and path[1] in "\\/":
        parts = re.split(r"[\\/]", path[2:])
        if len(parts) < 2 or not parts[0] or not parts[1]:
            return None
        return "windows", "\\\\" + parts[0] + "\\" + parts[1], parts[2:]
    if path.startswith("/"):
        rest = path[1:]
        return "posix", "/", rest.split("/") if rest else []
    return None


def snapshot_faults(packed):
    """This program's own reading of the snapshot it is about to upload, by the spec's rules
    for a valid file and its canonical form. Returns what is wrong, which should be nothing."""
    faults = []
    unpacker = zlib.decompressobj(wbits=31)
    try:
        raw = unpacker.decompress(packed) + unpacker.flush()
    except zlib.error as ex:
        return ["not gzip: %s" % ex]
    if not unpacker.eof or unpacker.unused_data:
        return ["not one whole gzip stream"]
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError as ex:
        return ["not UTF-8: %s" % ex]
    if not text.endswith("\n"):
        return ["last line has no LF"]
    lines = text[:-1].split("\n")
    if lines[0] + "\n" != line("@S3CAB", "FORMAT", "size", "time", HEADING_URL):
        faults.append("first line isn't the heading row")
    if lines[-1] != ".":
        faults.append("last line isn't the .")
    singles = {("@S3CAB", "SPEC"): 0, ("@CLIENT", "NAME"): 0, ("@CLIENT", "VERSION"): 0}
    dirs, files, paths = [], [], {}
    count = total = 0
    stated = {}
    for number, text_line in enumerate(lines[1:-1], 2):
        where = "line %d" % number
        if "\r" in text_line:
            faults.append("%s holds a CR" % where)
        fields = text_line.split("\t", 4)
        if len(fields) != 5 or "\t" in fields[4]:
            faults.append("%s isn't five fields" % where)
            continue
        kind, second, size, instant = (f.strip(TRIM) for f in fields[:4])
        last = fields[4]
        if text_line + "\n" != line(kind, second, size, instant, last):
            faults.append("%s isn't in canonical form" % where)
        if kind == "-":
            count += 1
            if not HASH_RE.match(second):
                faults.append("%s: hash" % where)
            if not re.match(r"[0-9]+\Z", size):
                faults.append("%s: size" % where)
            else:
                total += int(size)
            if not real_instant(instant):
                faults.append("%s: time" % where)
            files.append((where, last))
        elif kind.startswith("@"):
            if (kind, second) in singles:
                singles[(kind, second)] += 1
            if (kind, second) == ("@SET", "DIR"):
                dirs.append(last)
            if kind == "@SNAPSHOT":
                stated[second] = (instant, last)
            if size:
                faults.append("%s: an @ row with a size" % where)
        elif kind.startswith("#"):
            if size or instant:
                faults.append("%s: a # row with a size or time" % where)
        else:
            faults.append("%s: unknown type" % where)
        if kind == "-" or kind.startswith("#"):
            if last in paths:
                faults.append("%s: path already in %s" % (where, paths[last]))
            paths[last] = where
            if path_parts(last) is None:
                faults.append("%s: path isn't absolute" % where)
    for key, n in singles.items():
        if n != 1:
            faults.append("%d %s %s rows" % (n, key[0], key[1]))
    if stated.get("FILES", ("", ""))[1] != str(count):
        faults.append("FILES disagrees with the file rows")
    if not stated.get("SIZE", ("", ""))[1].startswith("%d (" % total):
        faults.append("SIZE disagrees with the size column")
    for key in ("START", "FINISH"):
        if not real_instant(stated.get(key, ("", ""))[0]):
            faults.append("%s has no real instant" % key)
    parsed_dirs = []
    for d in dirs:
        parts = path_parts(d)
        if parts is None or not d.endswith(("\\", "/") if parts[0] == "windows" else "/"):
            faults.append("@SET DIR %r isn't an absolute path ending in a separator" % d)
            continue
        kind, root, segments = parts
        while segments and segments[-1] == "":
            segments = segments[:-1]
        if "" in segments:
            faults.append("@SET DIR %r has an empty segment" % d)
            continue
        fold = (lambda s: s.lower()) if kind == "windows" else (lambda s: s)
        parsed_dirs.append((kind, fold(root), [fold(s) for s in segments]))
    file_set = set(p for _, p in files)
    for where, path in files:
        parts = path_parts(path)
        if parts is None:
            continue
        kind, root, segments = parts
        if "\x00" in path or not segments or any(s in ("", ".", "..") for s in segments):
            faults.append("%s: a segment isn't a name" % where)
            continue
        fold = (lambda s: s.lower()) if kind == "windows" else (lambda s: s)
        mine = [fold(s) for s in segments]
        under = equal = False
        for dkind, droot, dsegs in parsed_dirs:
            if dkind == kind and droot == fold(root) and mine[:len(dsegs)] == dsegs:
                if len(mine) == len(dsegs):
                    equal = True
                else:
                    under = True
        if not under or equal:
            faults.append("%s: not strictly inside a @SET DIR" % where)
        seps = "\\/" if kind == "windows" else "/"
        for i, ch in enumerate(path):
            if ch in seps and path[:i] in file_set:
                faults.append("%s: runs through another file row's path" % where)
                break
    return faults


# --------------------------------------------------------------------------- the bucket

class Bucket:
    """The few requests a backup makes, each one real."""

    def __init__(self, name):
        import boto3
        from botocore.config import Config
        from botocore.exceptions import ClientError
        self.ClientError = ClientError
        self.name = name
        region = (os.environ.get("AWS_REGION") or os.environ.get("AWS_DEFAULT_REGION")
                  or boto3.session.Session().region_name or "us-east-1")
        config = Config(retries={"mode": "standard", "max_attempts": 6}, connect_timeout=10, read_timeout=60)
        # The endpoint this run was told to use, if any: the SDK's own two variables, in the
        # SDK's order, handed to boto3 explicitly so that what is recorded is what is used.
        told = None
        if os.environ.get("AWS_IGNORE_CONFIGURED_ENDPOINT_URLS", "").lower() != "true":
            told = os.environ.get("AWS_ENDPOINT_URL_S3") or os.environ.get("AWS_ENDPOINT_URL") or None
        self.s3 = boto3.client("s3", region_name=region, endpoint_url=told, config=config)
        if told is None:
            # boto3 also takes an endpoint from the shared config file: that is told, too.
            try:
                plain = boto3.client("s3", region_name=region,
                                     config=config.merge(Config(ignore_configured_endpoint_urls=True)))
                if plain.meta.endpoint_url != self.s3.meta.endpoint_url:
                    told = self.s3.meta.endpoint_url
            except TypeError:
                pass  # a boto3 too old to take one from there
        self.endpoint = told or ""

        def never_overwrite(params, **_):
            params["headers"]["If-None-Match"] = "*"

        # Every PUT this program makes is a no-overwrite PUT.
        self.s3.meta.events.register("before-call.s3.PutObject", never_overwrite)
        self.s3.meta.events.register("before-call.s3.CompleteMultipartUpload", never_overwrite)

    def status(self, ex):
        return ex.response.get("ResponseMetadata", {}).get("HTTPStatusCode")

    def code(self, ex):
        return ex.response.get("Error", {}).get("Code")

    def get(self, key):
        """The key's bytes, or None when it isn't there."""
        try:
            return self.s3.get_object(Bucket=self.name, Key=key)["Body"].read()
        except self.ClientError as ex:
            if self.status(ex) == 404 and self.code(ex) in ("NoSuchKey", "NotFound"):
                return None
            raise

    def has(self, key):
        try:
            self.s3.head_object(Bucket=self.name, Key=key)
            return True
        except self.ClientError as ex:
            if self.status(ex) == 404 and self.code(ex) in ("404", "NoSuchKey", "NotFound"):
                return False
            raise

    def keys(self, prefix, delimiter=None):
        """Every key under a prefix, every page of the listing."""
        args = {"Bucket": self.name, "Prefix": prefix}
        if delimiter:
            args["Delimiter"] = delimiter
        while True:
            page = self.s3.list_objects_v2(**args)
            for item in page.get("Contents", []):
                yield item["Key"]
            if not page.get("IsTruncated"):
                return
            args["ContinuationToken"] = page["NextContinuationToken"]

    def conditionally(self, request):
        """Run a no-overwrite write. True when it stored the key, False on a 412: the key was
        already there. A 409 is another conditional write in flight: try again."""
        for attempt in range(6):
            try:
                request()
                return True
            except self.ClientError as ex:
                if self.status(ex) == 412:
                    return False
                if self.status(ex) == 409 and self.code(ex) == "ConditionalRequestConflict" and attempt < 5:
                    time.sleep(0.5 * (attempt + 1))
                    continue
                raise

    def put_new(self, key, data):
        """A no-overwrite PUT of these bytes, which S3 checks against their SHA-256."""
        digest = base64.b64encode(hashlib.sha256(data).digest()).decode("ascii")
        return self.conditionally(lambda: self.s3.put_object(
            Bucket=self.name, Key=key, Body=data, ChecksumSHA256=digest))

    def delete(self, key):
        self.s3.delete_object(Bucket=self.name, Key=key)


def key_values(data):
    """KEY=value lines as .info and a lock are read."""
    fields = {}
    for text_line in data.decode("utf-8", "replace").split("\n"):
        if text_line.endswith("\r"):
            text_line = text_line[:-1]
        if "=" in text_line:
            key, value = text_line.split("=", 1)
            fields[key] = value
    return fields


# --------------------------------------------------------------------------- state beside the program

STATE_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "s3cab-backup.state.json")


def load_state():
    try:
        with open(STATE_FILE, "r", encoding="utf-8") as f:
            state = json.load(f)
        if isinstance(state, dict) and isinstance(state.get("claims"), list):
            return state
    except FileNotFoundError:
        pass
    except (OSError, ValueError) as ex:
        raise Stop("state file %s can't be read: %s" % (STATE_FILE, ex))
    return {"claims": []}


def kept_pair(endpoint, bucket, set_name):
    for claim in load_state()["claims"]:
        if (claim.get("endpoint"), claim.get("bucket"), claim.get("set")) == (endpoint, bucket, set_name):
            return {"OWNER": claim.get("OWNER"), "CLAIMED": claim.get("CLAIMED")}
    return None


def keep_pair(endpoint, bucket, set_name, pair):
    """Keep the pair this program is about to claim with. Two runs for two sets may get here
    together, so the read, change and replace happen under a small lock file of their own."""
    guard = STATE_FILE + ".lock"
    deadline = time.monotonic() + 30
    while True:
        try:
            os.close(os.open(guard, os.O_CREAT | os.O_EXCL | os.O_WRONLY))
            break
        except FileExistsError:
            try:
                if time.time() - os.stat(guard).st_mtime > 120:
                    os.remove(guard)  # left by a run that died here
                    continue
            except OSError:
                continue
            if time.monotonic() > deadline:
                raise Stop("state file %s is locked by another run (%s)" % (STATE_FILE, guard))
            time.sleep(0.05)
    try:
        state = load_state()
        state["claims"] = [c for c in state["claims"]
                           if (c.get("endpoint"), c.get("bucket"), c.get("set")) != (endpoint, bucket, set_name)]
        state["claims"].append({"endpoint": endpoint, "bucket": bucket, "set": set_name,
                                "OWNER": pair["OWNER"], "CLAIMED": pair["CLAIMED"]})
        temporary = STATE_FILE + ".new"
        with open(temporary, "w", encoding="utf-8", newline="\n") as f:
            json.dump(state, f, indent=1, ensure_ascii=True)
            f.write("\n")
        os.replace(temporary, STATE_FILE)
    finally:
        try:
            os.remove(guard)
        except OSError:
            pass


# --------------------------------------------------------------------------- holder and lock

def info_key(set_name):
    return "snapshots/%s.info" % set_name


def snapshots_of(bucket, set_name):
    """The names of the keys directly in the set's folder that a reader takes for snapshots."""
    prefix = "snapshots/%s/" % set_name
    return sorted(key[len(prefix):] for key in bucket.keys(prefix, "/")
                  if SNAPSHOT_FILE_RE.match(key[len(prefix):]))


def hold_set(bucket, set_name, by):
    """Before the walk: be the set's holder, by the pair kept beside the program or by
    claiming a set that is new. Returns the pair, or Stop."""
    data = bucket.get(info_key(set_name))
    pair = kept_pair(bucket.endpoint, bucket.name, set_name)
    if data is not None:
        there = key_values(data)
        if pair and there.get("OWNER") == pair["OWNER"] and there.get("CLAIMED") == pair["CLAIMED"]:
            say("holder of set %s since %s" % (set_name, show(pair["CLAIMED"])))
            return pair
        raise Stop("set %s is held by %s (claimed %s), and that isn't a claim this program made and "
                   "kept; taking a set over is a person's decision, which this program doesn't make"
                   % (set_name, show(there.get("OWNER", "?")), show(there.get("CLAIMED", "?"))))
    if snapshots_of(bucket, set_name):
        raise Stop("set %s has snapshots and no .info: it exists and has no holder until one takes "
                   "it over, which this program doesn't do" % set_name)
    claimed = instant_text(now_ms_down())  # the clock as the claim is made
    pair = {"OWNER": by, "CLAIMED": claimed}
    body = ("OWNER=%s\nCLAIMED=%s\nCREATED=%s\n" % (by, claimed, claimed)).encode("utf-8")
    keep_pair(bucket.endpoint, bucket.name, set_name, pair)
    if not bucket.put_new(info_key(set_name), body) and bucket.get(info_key(set_name)) != body:
        raise Stop("set name %s is taken: another claim landed first" % set_name)
    say("claimed new set %s as %s at %s" % (set_name, show(by), claimed))
    return pair


def still_holder(bucket, set_name, pair):
    """Immediately before the snapshot's upload."""
    data = bucket.get(info_key(set_name))
    if data is None:
        raise Stop("set %s has no .info any more, so no holder: the snapshot isn't uploaded" % set_name)
    there = key_values(data)
    if there.get("OWNER") != pair["OWNER"] or there.get("CLAIMED") != pair["CLAIMED"]:
        raise Stop("set %s is now held by %s (claimed %s): the snapshot isn't uploaded"
                   % (set_name, show(there.get("OWNER", "?")), show(there.get("CLAIMED", "?"))))


class UploadLock:
    def __init__(self, bucket, set_name, by):
        self.bucket, self.set_name, self.by = bucket, set_name, by
        self.pidns = pid_namespace()
        self.id = None

    def body(self, ms):
        lines = ["COMMAND=backup", "SET=" + self.set_name, "BY=" + self.by, "OS=" + sys.platform]
        if self.pidns:
            lines.append("PIDNS=" + self.pidns)
        lines += ["PID=%d" % os.getpid(), "STARTED=" + instant_text(ms)]
        return ("\n".join(lines) + "\n").encode("utf-8")

    def take(self):
        """Write first, look second."""
        while True:
            ms = now_ms_down()  # a fresh reading for every try
            lock_id = "upload-" + instant_basic(ms)
            body = self.body(ms)
            if self.bucket.put_new("locks/" + lock_id, body) or self.bucket.get("locks/" + lock_id) == body:
                self.id = lock_id
                break
            time.sleep(0.002)
        for key in list(self.bucket.keys("locks/", "/")):
            other = key[len("locks/"):]
            if other == self.id or not other.startswith(("upload-", "delete-")):
                continue
            data = self.bucket.get(key)
            if data is None:
                continue  # removed since the listing
            fields = key_values(data)
            if self.dead_run(fields):
                self.bucket.delete(key)
                say("removed the lock %s of a run of this machine's whose process %s is gone"
                    % (show(other), fields.get("PID")))
                continue
            if other.startswith("delete-"):
                self.release()
                raise Stop("a delete is running, or its lock was left behind: %s (by %s, pid %s). "
                           "Uploads and deletes take turns; a person who knows that run is dead "
                           "removes the lock" % (show(other), show(fields.get("BY", "?")),
                                                 show(fields.get("PID", "?"))))

    def dead_run(self, fields):
        if fields.get("BY") != self.by or fields.get("OS") != sys.platform:
            return False
        if fields.get("PIDNS") != self.pidns:
            return False
        pid = fields.get("PID")
        if pid is None or not PID_RE.match(pid):
            return False
        return not process_alive(int(pid))

    def release(self):
        if self.id is None:
            return
        lock_id, self.id = self.id, None
        try:
            self.bucket.delete("locks/" + lock_id)
        except Exception as ex:
            say("COULD NOT REMOVE THE LOCK %s (%s): remove locks/%s by hand" % (lock_id, ex, lock_id))


# --------------------------------------------------------------------------- uploading objects

class Changed(Exception):
    """The file is no longer what its row says: it isn't sent."""


def read_up_to(f, limit):
    parts, have = [], 0
    while have < limit:
        chunk = f.read(min(READ_CHUNK, limit - have))
        if not chunk:
            break
        parts.append(chunk)
        have += len(chunk)
    return b"".join(parts)


def send_object(bucket, row):
    """Store one file row's content at objects/<hash>, sending exactly bytes that hash to the
    key. Returns 'sent', or 'there' when the bucket already held the key. Raises Changed."""
    _, wanted, size, mtime, path = row
    key = "objects/" + wanted
    try:
        f = open_file(path)
    except OSError as ex:
        raise Changed("can't be opened (%s)" % failure(ex))
    with f:
        st = os.fstat(f.fileno())
        if not stat.S_ISREG(st.st_mode):
            raise Changed("is no longer a regular file")
        if st.st_size != size or instant_text(round_ms(st.st_mtime_ns)) != mtime:
            raise Changed("has changed size or modification time since it was hashed")
        if size < PART_SIZE:
            try:
                data = read_up_to(f, size + 1)
            except OSError as ex:
                raise Changed("can't be read (%s)" % failure(ex))
            if hashlib.sha256(data).hexdigest() != wanted:
                raise Changed("no longer holds the bytes that were hashed")
            return "sent" if bucket.put_new(key, data) else "there"  # the bytes just hashed
        if bucket.has(key):
            return "there"
        part_size = max(PART_SIZE, -(-size // 10000))
        s3 = bucket.s3
        upload = s3.create_multipart_upload(Bucket=bucket.name, Key=key, ChecksumAlgorithm="SHA256")["UploadId"]
        try:
            whole = hashlib.sha256()
            parts, total = [], 0
            while True:
                try:
                    chunk = read_up_to(f, part_size)
                except OSError as ex:
                    raise Changed("can't be read (%s)" % failure(ex))
                if not chunk:
                    break
                total += len(chunk)
                if total > size:
                    raise Changed("has grown since it was hashed")
                whole.update(chunk)
                digest = base64.b64encode(hashlib.sha256(chunk).digest()).decode("ascii")
                number = len(parts) + 1
                answer = s3.upload_part(Bucket=bucket.name, Key=key, UploadId=upload, PartNumber=number,
                                        Body=chunk, ChecksumSHA256=digest)
                parts.append({"PartNumber": number, "ETag": answer["ETag"], "ChecksumSHA256": digest})
            # Nothing is visible under the key until the upload is completed, and it is
            # completed only if the bytes that went out hash to the key.
            if whole.hexdigest() != wanted:
                raise Changed("no longer holds the bytes that were hashed")
            stored = bucket.conditionally(lambda: s3.complete_multipart_upload(
                Bucket=bucket.name, Key=key, UploadId=upload, MultipartUpload={"Parts": parts}))
        except BaseException:
            try:
                s3.abort_multipart_upload(Bucket=bucket.name, Key=key, UploadId=upload)
            except Exception as ex:
                say("could not abort multipart upload %s of %s: %s" % (upload, key, ex))
            raise
        if not stored:  # refused with 412: the key is there, and AWS leaves the upload open
            s3.abort_multipart_upload(Bucket=bucket.name, Key=key, UploadId=upload)
            return "there"
        return "sent"


def store_objects(bucket, file_rows):
    """Every object the snapshot names, before the snapshot. Returns (sent, there, failed)."""
    by_hash = {}
    for row in file_rows:
        if row[0] == "-":
            by_hash.setdefault(row[1], []).append(row)
    listed = set()
    for key in bucket.keys("objects/"):
        if HASH_RE.match(key[len("objects/"):]):
            listed.add(key[len("objects/"):])
    sent = there = 0
    failed = []
    for wanted, rows in by_hash.items():
        if wanted in listed:
            there += 1
            continue
        reasons = []
        for row in rows:  # content several paths share is sent once, from any one of them
            try:
                outcome = send_object(bucket, row)
            except Changed as ex:
                reasons.append("%s %s" % (show(row[4]), ex))
                continue
            if outcome == "sent":
                sent += 1
                if sent % 100 == 0:
                    say("  %d objects sent" % sent)
            else:
                there += 1
            break
        else:
            failed.append((wanted, reasons))
    return sent, there, failed


# --------------------------------------------------------------------------- the run

def run(argv):
    if len(argv) < 3:
        print("usage: python s3cab-backup.py <bucket> <set> <dir>...", file=sys.stderr)
        return 2
    start_ns = time.time_ns()  # one clock reading for START and the name
    start_ms = start_ns // 1000000
    name = time.strftime("%Y%m%dT%H%M", time.localtime(start_ns // 1000000000))

    bucket_name = argv[0]
    if bucket_name.startswith("s3://"):
        bucket_name = bucket_name[5:]
    bucket_name = bucket_name.rstrip("/")
    set_name = argv[1]
    if not bucket_name or "/" in bucket_name:
        raise Stop("%s isn't a bucket name" % show(argv[0]))
    if not SET_RE.match(set_name):
        raise Stop("%s isn't a set name: a to z and digits, with single hyphens between them" % show(set_name))

    dirs = []
    for typed in argv[2:]:
        directory = resolve_member(typed)
        if directory in dirs:
            raise Stop("member directory %s is named twice; change the set" % show(directory))
        dirs.append(directory)

    by = user_at_machine()
    bucket = Bucket(bucket_name)
    run_facts = {"set": set_name, "bucket": bucket_name, "endpoint": bucket.endpoint, "dirs": dirs,
                 "name": name, "by": by, "start_ms": start_ms, "zone": zone_name()}
    key = "snapshots/%s/%s.tsv.gz" % (set_name, name)
    say("backing up set %s to s3://%s as %s" % (set_name, bucket_name, key))
    for directory in dirs:
        say("  member directory %s" % show(directory))

    pair = hold_set(bucket, set_name, by)
    lock = UploadLock(bucket, set_name, by)
    try:
        lock.take()  # before the walk, and held for the whole run
        walk_rows, files = walk(dirs)
        walked_ms = now_ms_up()
        say("walked: %d files, %d entries that get an #error row" % (len(files), len(walk_rows)))

        earlier = snapshots_of(bucket, set_name)
        if name + ".tsv.gz" in earlier:
            raise Stop("set %s already has a snapshot named %s: a second snapshot in the same minute "
                       "is refused, never an overwrite" % (set_name, name))
        if earlier and earlier[-1] > name + ".tsv.gz":
            say("warning: %s sorts before the set's latest snapshot %s (the clock went back?), so a "
                "reader asked for the latest takes that one" % (name, earlier[-1][:-len(".tsv.gz")]))

        file_rows = [hash_file(path) for path in files]
        # FINISH: every row before FILES is known. The last file hashed, or with no file to
        # hash, the walk over. Rounded up, so no row was made after the instant it names.
        finish_ms = now_ms_up() if files else walked_ms
        text = snapshot_text(run_facts, walk_rows, file_rows, finish_ms)
        packed = gzip_one_stream(text.encode("utf-8"))
        faults = snapshot_faults(packed)
        if faults:
            raise Stop("this program built a snapshot its own reading refuses, which is a bug in it; "
                       "nothing was uploaded: " + "; ".join(faults[:10]))
        count = sum(1 for row in file_rows if row[0] == "-")
        errors = len(walk_rows) + len(file_rows) - count
        say("hashed: %d file rows, %d #error rows" % (count, errors))

        sent, there, failed = store_objects(bucket, file_rows)
        say("objects: %d sent, %d already in the bucket" % (sent, there))
        if failed:
            for wanted, reasons in failed:
                say("NOT STORED objects/%s: %s" % (wanted, "; ".join(reasons)))
            raise Stop("%d object(s) the snapshot names aren't in the bucket, so the snapshot isn't "
                       "uploaded; run the backup again" % len(failed))

        still_holder(bucket, set_name, pair)
        if bucket.put_new(key, packed):
            say("uploaded %s (%d bytes)" % (key, len(packed)))
        elif bucket.get(key) == packed:
            say("%s already holds these bytes: uploaded" % key)
        else:
            raise Stop("%s already exists with other bytes: a second snapshot in the same minute is "
                       "refused, never an overwrite" % key)
    finally:
        lock.release()

    for message, path in walk_rows:
        say("#error %s: %s" % (show(path), show(message)))
    for row in file_rows:
        if row[0] != "-":
            say("#error %s: %s" % (show(row[2]), show(row[1])))
    if errors:
        say("done, with %d #error row(s): exit 1" % errors)
        return 1
    say("done")
    return 0


def main(argv):
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="backslashreplace")
        except Exception:
            pass
    if sys.version_info < (3, 10):
        print("s3cab-backup.py needs Python 3.10 or later", file=sys.stderr)
        return 2
    try:
        return run(argv)
    except Stop as ex:
        say("STOPPED: %s" % ex)
        return 1
    except KeyboardInterrupt:
        say("STOPPED: interrupted")
        return 1
    except Exception as ex:
        if ex.__class__.__module__.startswith(("botocore", "boto3", "urllib3")):
            say("STOPPED: the bucket couldn't be reached or refused a request: %s" % ex)
            return 1
        raise


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
