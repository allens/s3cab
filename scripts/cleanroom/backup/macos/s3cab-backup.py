#!/usr/bin/env python3
"""s3cab-backup.py -- a clean-room backup writer for the s3cab repository format.

    python s3cab-backup.py <bucket> <set> <dir>...

Written from the format spec of 2026-10-30 alone.  Standard library plus boto3.
It walks the member directories, uploads every object the snapshot names, then the
snapshot, and keeps the set's holder pair (OWNER/CLAIMED) in a JSON file beside this
program, keyed by bucket and set.

Exit status: 0 when the snapshot was uploaded and holds no #error row; 1 when the run
stopped, was refused, or the snapshot holds an #error row (or could not be uploaded
because a file changed under it); 2 for a usage error.
"""

import base64
import errno
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

import boto3
from botocore.config import Config
from botocore.exceptions import BotoCoreError, ClientError

SPEC_DATE = "2026-10-30"
CLIENT_NAME = "s3cab-backup"
CLIENT_VERSION = "0.1.0"
FORMAT_URL = "https://s3cab.plantegral.com/guide/format"
HEADING = ("@S3CAB", "FORMAT", "size", "time", FORMAT_URL)

PART_SIZE = 16 * 1024 * 1024          # multipart part size, and the threshold for using it
READ_CHUNK = 1024 * 1024
STATE_FILE = "s3cab-backup.state.json"  # beside this program: the holder pair per bucket+set

IS_WIN = sys.platform == "win32"
SEP = "\\" if IS_WIN else "/"


# ----------------------------------------------------------------------------- errors

class Stop(Exception):
    """The run stops without writing a snapshot (exit 1)."""


class Refused(Exception):
    """The repository refused the run: lock, holder, or snapshot conflict (exit 1)."""


# ----------------------------------------------------------------------------- time

def civil_from_days(z):
    """Proleptic Gregorian (year, month, day) for a day count since 1970-01-01.  Works for
    negative counts and for year 0000 (a leap year), which datetime can't hold."""
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


def iso_from_ms(ms):
    """YYYY-MM-DDTHH:MM:SS.sssZ for a millisecond count since the epoch, or None when the
    year falls outside 0000..9999."""
    days, rem = divmod(ms, 86_400_000)
    y, mo, d = civil_from_days(days)
    if not 0 <= y <= 9999:
        return None
    hh, rem = divmod(rem, 3_600_000)
    mi, rem = divmod(rem, 60_000)
    ss, mss = divmod(rem, 1000)
    return f"{y:04d}-{mo:02d}-{d:02d}T{hh:02d}:{mi:02d}:{ss:02d}.{mss:03d}Z"


def basic_from_iso(iso):
    """20261027T140205.123Z from 2026-10-27T14:02:05.123Z (the lock id's form)."""
    return iso.replace("-", "").replace(":", "")


def ns_round_to_ms(ns):
    """Nearest millisecond, a tie to the later one; floor division so negatives work."""
    return (ns + 500_000) // 1_000_000


def ns_floor_to_ms(ns):
    return ns // 1_000_000


def ns_ceil_to_ms(ns):
    return -((-ns) // 1_000_000)


def duration_text(ms):
    s = ms // 1000
    if s < 60:
        return f"{s}s"
    if s < 3600:
        return f"{s // 60}m {s % 60:02d}s"
    return f"{s // 3600}h {(s % 3600) // 60:02d}m"


def readable_size(n):
    if n < 1000:
        return f"{n}B"
    for unit, k in (("kB", 1), ("MB", 2), ("GB", 3), ("TB", 4), ("PB", 5)):
        u = 1000 ** k
        tenths = (n * 10 + u // 2) // u      # one decimal, rounded half up
        if tenths < 10000 or unit == "PB":
            return f"{tenths // 10}.{tenths % 10}{unit}"


def local_zone_name():
    """Best name for the local zone: TZ, then /etc/localtime, then ICU on Windows."""
    tz = os.environ.get("TZ")
    if tz:
        return tz.lstrip(":")
    try:
        rp = os.path.realpath("/etc/localtime")
        if "zoneinfo/" in rp:
            return rp.split("zoneinfo/", 1)[1]
    except OSError:
        pass
    if IS_WIN:
        try:
            import ctypes
            icu = ctypes.WinDLL("icu.dll")
            fn = icu.ucal_getDefaultTimeZone
            fn.restype = ctypes.c_int32
            buf = ctypes.create_unicode_buffer(256)
            status = ctypes.c_int32(0)
            n = fn(buf, 256, ctypes.byref(status))
            if status.value <= 0 and n > 0:
                return buf.value[:n]
        except Exception:
            pass
    return time.strftime("%Z") or "local"


# ----------------------------------------------------------------------------- text

def spelled(s):
    """Tab, CR and LF written as their Control Pictures U+2409, U+240D, U+240A (for every
    field but a file row's path, which refuses them instead)."""
    return s.replace("\t", "\u2409").replace("\r", "\u240d").replace("\n", "\u240a")


def shown(s):
    """A path or name for a message: control characters spelled out, nothing raw."""
    out = []
    for c in s:
        o = ord(c)
        if o < 32 or o == 0x7f or o == 0x85 or o in (0x2028, 0x2029):
            out.append(f"\\x{o:02x}" if o < 256 else f"\\u{o:04x}")
        else:
            out.append(c)
    return "".join(out)


def row(c1, c2="", c3="", c4="", c5=""):
    """One canonical line: column 1 unpadded, 2 right-padded to 64 code points, 3
    left-padded to 12, 4 right-padded to 24, 5 verbatim."""
    return f"{c1}\t{c2:<64}\t{c3:>12}\t{c4:<24}\t{c5}\n"


def undecodable_shown(name):
    """A name with no UTF-8 form, with U+FFFD for each part that doesn't decode."""
    if IS_WIN:
        return name.encode("utf-8", "surrogatepass").decode("utf-8", "replace")
    return os.fsencode(name).decode("utf-8", "replace")


def has_utf8_form(name):
    try:
        name.encode("utf-8")
        return True
    except UnicodeEncodeError:
        return False


# ----------------------------------------------------------------------------- paths

def os_path(p):
    """The path to hand the operating system.  On Windows every call goes through \\\\?\\
    so a name ending in a dot or space, a reserved name, or a long path is taken as is."""
    if not IS_WIN:
        return p
    if p.startswith("\\\\?\\"):
        return p
    if p.startswith("\\\\"):
        return "\\\\?\\UNC\\" + p[2:]
    return "\\\\?\\" + p


def strip_win_prefix(p):
    if p.startswith("\\\\?\\UNC\\"):
        return "\\\\" + p[8:]
    if p.startswith("\\\\?\\"):
        return p[4:]
    return p


def is_windows_path(p):
    return bool(re.match(r"^[A-Za-z]:[\\/]", p)) or bool(re.match(r"^[\\/]{2}", p))


def segments(p):
    """Whole path segments (root dropped) for exact, segment-wise comparison."""
    if is_windows_path(p):
        parts = re.split(r"[\\/]", p)
    else:
        parts = p.split("/")
    return [s for s in parts if s != ""]


def path_kind(p):
    if is_windows_path(p):
        return "unc" if re.match(r"^[\\/]{2}", p) else "drive"
    return "posix"


def is_under_or_equal(path, directory):
    """Is `path` the directory, or inside it, comparing whole segments exactly?"""
    if path_kind(path) != path_kind(directory):
        return False
    ps, ds = segments(path), segments(directory)
    return ps[:len(ds)] == ds


def _posix_true_case(rp):
    """Spell each segment of an already-real POSIX path as its directory lists it.
    realpath keeps the case as typed on macOS and in a case-folding Linux directory, so
    look each name up by identity in its parent's listing.  macOS's F_GETPATH is tried
    first; it reports the on-disk spelling in one call."""
    if sys.platform == "darwin":
        try:
            import fcntl
            fd = os.open(rp, os.O_RDONLY | getattr(os, "O_NONBLOCK", 0))
            try:
                got = fcntl.fcntl(fd, fcntl.F_GETPATH, bytes(1024)).rstrip(b"\0")
                got = os.fsdecode(got)
                if got:
                    return got
            finally:
                os.close(fd)
        except OSError:
            pass
    out = "/"
    for seg in segments(rp):
        chosen = seg
        try:
            names = os.listdir(out)
        except OSError:
            names = None
        if names is not None and seg not in names:
            try:
                want = os.lstat(os.path.join(out, seg))
                for n in names:
                    try:
                        if os.path.samestat(os.lstat(os.path.join(out, n)), want):
                            chosen = n
                            break
                    except OSError:
                        continue
            except OSError:
                pass
        out = os.path.join(out, chosen)
    return out


def true_path(p):
    """The real path of `p`, every part resolved, spelled as the filesystem reports it.
    Raises OSError when it can't be resolved."""
    if IS_WIN:
        absolute = os.path.normpath(os.path.join(os.getcwd(), p))   # normpath keeps a trailing dot
        rp = os.path.realpath(os_path(absolute), strict=True)
        rp = strip_win_prefix(rp)
        if re.match(r"^[a-z]:", rp):
            rp = rp[0].upper() + rp[1:]
        return rp
    rp = os.path.realpath(p, strict=True)
    return _posix_true_case(rp)


def with_one_trailing_sep(p):
    """A directory path ending in exactly one separator of its kind: `/` stays `/`,
    `C:` becomes `C:\\`, `\\\\server\\share\\\\` becomes `\\\\server\\share\\`."""
    if re.fullmatch(r"[A-Za-z]:", p):
        return p + "\\"
    win = is_windows_path(p)
    seps = "\\/" if win else "/"
    sep = "\\" if win else "/"
    stripped = p.rstrip(seps)
    if not win and stripped == "":
        return "/"
    return stripped + sep


# ----------------------------------------------------------------------------- process

def process_alive(pid):
    """True while the process exists (or belongs to another user), False once it is gone."""
    if IS_WIN:
        import ctypes
        k32 = ctypes.WinDLL("kernel32", use_last_error=True)
        k32.OpenProcess.restype = ctypes.c_void_p
        k32.OpenProcess.argtypes = (ctypes.c_uint32, ctypes.c_int, ctypes.c_uint32)
        k32.GetExitCodeProcess.argtypes = (ctypes.c_void_p, ctypes.POINTER(ctypes.c_ulong))
        k32.CloseHandle.argtypes = (ctypes.c_void_p,)
        PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
        h = k32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid)
        if not h:
            err = ctypes.get_last_error()
            return err != 87          # 87: no such process; 5: alive, another user's
        try:
            code = ctypes.c_ulong()
            if k32.GetExitCodeProcess(h, ctypes.byref(code)):
                return code.value == 259
            return True
        finally:
            k32.CloseHandle(h)
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    except OSError:
        return True


def pid_namespace():
    if sys.platform.startswith("linux"):
        try:
            return os.readlink("/proc/self/ns/pid")
        except OSError:
            return None
    return None


def user_at_machine():
    try:
        import getpass
        user = getpass.getuser()
    except Exception:
        user = os.environ.get("USER") or os.environ.get("USERNAME") or "unknown"
    return f"{user}@{socket.gethostname()}"


# ----------------------------------------------------------------------------- key=value files

def parse_kv(data):
    """`.info` and lock files: UTF-8 (bad bytes as U+FFFD), split on LF, one trailing CR
    stripped, split at the first `=`, last repeated key wins, lines without `=` skipped."""
    out = {}
    text = data.decode("utf-8", "replace")
    for line in text.split("\n"):
        if line.endswith("\r"):
            line = line[:-1]
        if "=" not in line:
            continue
        k, v = line.split("=", 1)
        out[k] = v
    return out


# ----------------------------------------------------------------------------- the store

class Store:
    def __init__(self, bucket):
        self.bucket = bucket
        self.endpoint = os.environ.get("AWS_ENDPOINT_URL_S3") or os.environ.get("AWS_ENDPOINT_URL") or None
        region = os.environ.get("AWS_REGION") or os.environ.get("AWS_DEFAULT_REGION") or "us-east-1"
        cfg = Config(retries={"mode": "standard", "max_attempts": 5},
                     connect_timeout=10, read_timeout=60)
        self.client = boto3.client("s3", region_name=region, config=cfg)
        # Server-side encryption with S3's own keys is asked of AWS, and no other provider.
        self.sse = {} if self.endpoint else {"ServerSideEncryption": "AES256"}

    @staticmethod
    def _status(e):
        return e.response.get("ResponseMetadata", {}).get("HTTPStatusCode")

    @staticmethod
    def _code(e):
        return e.response.get("Error", {}).get("Code")

    def put_new(self, key, body, extra=None):
        """Conditional PUT (If-None-Match: *) with S3 checking the SHA-256 of the body.
        Returns True when stored, False on 412 (the key already exists)."""
        digest = hashlib.sha256(body).digest()
        params = dict(Bucket=self.bucket, Key=key, Body=body, IfNoneMatch="*",
                      ChecksumSHA256=base64.b64encode(digest).decode("ascii"))
        params.update(extra or {})
        for attempt in range(6):
            try:
                self.client.put_object(**params)
                return True
            except ClientError as e:
                if self._status(e) == 412 or self._code(e) == "PreconditionFailed":
                    return False
                if self._status(e) == 409 and attempt < 5:
                    time.sleep(0.5 * (attempt + 1))     # a concurrent conditional write in progress
                    continue
                raise

    def get(self, key):
        """The object's bytes, or None when the key is missing."""
        try:
            r = self.client.get_object(Bucket=self.bucket, Key=key)
            return r["Body"].read()
        except ClientError as e:
            if self._code(e) in ("NoSuchKey", "NotFound", "404"):
                return None
            raise

    def head(self, key):
        """True when the key exists, False on a miss; anything else is raised."""
        try:
            self.client.head_object(Bucket=self.bucket, Key=key)
            return True
        except ClientError as e:
            if self._code(e) in ("404", "NoSuchKey", "NotFound"):
                return False
            raise

    def delete(self, key):
        self.client.delete_object(Bucket=self.bucket, Key=key)

    def list_folder(self, prefix):
        """Keys directly under `prefix` (ListObjectsV2 with the delimiter `/`)."""
        keys = []
        paginator = self.client.get_paginator("list_objects_v2")
        for page in paginator.paginate(Bucket=self.bucket, Prefix=prefix, Delimiter="/"):
            for o in page.get("Contents", []):
                keys.append(o["Key"])
        return keys


SNAPSHOT_NAME_RE = re.compile(r"^[0-9]{8}T[0-9]{4}\.tsv\.gz$")
SET_NAME_RE = re.compile(r"^[a-z0-9]+(-[a-z0-9]+)*$")
PID_RE = re.compile(r"^[1-9][0-9]*$")


# ----------------------------------------------------------------------------- state

def state_path():
    return os.path.join(os.path.dirname(os.path.abspath(__file__)), STATE_FILE)


def state_key(store):
    return store.bucket if not store.endpoint else f"{store.endpoint}#{store.bucket}"


def load_state():
    try:
        with open(state_path(), "rb") as f:
            return json.loads(f.read().decode("utf-8"))
    except FileNotFoundError:
        return {}
    except (OSError, ValueError) as e:
        print(f"warning: state file unreadable, treating as empty: {e}", file=sys.stderr)
        return {}


def save_state(state):
    p = state_path()
    tmp = p + ".tmp"
    with open(tmp, "wb") as f:
        f.write(json.dumps(state, indent=2, sort_keys=True).encode("utf-8") + b"\n")
    os.replace(tmp, p)


# ----------------------------------------------------------------------------- the walk

class Walk:
    def __init__(self, member_dirs):
        self.member_dirs = member_dirs          # list of DIR strings, each ending in a separator
        self.pre_rows = []                      # #excluded / #error rows the walk finds
        self.files = []                         # row paths of regular files, in walk order

    def inside_backup(self, real):
        return any(is_under_or_equal(real, d) for d in self.member_dirs)

    def run(self):
        for d in self.member_dirs:
            self.walk_dir(d)

    def walk_dir(self, dir_row_path):
        try:
            with os.scandir(os_path(dir_row_path)) as it:
                entries = list(it)
        except OSError as e:
            raise Stop(f"directory can't be listed: {shown(dir_row_path)} ({describe(e)})")
        entries.sort(key=lambda en: en.name)
        for en in entries:
            name = en.name
            if not has_utf8_form(name):
                raise Stop(f"name has no UTF-8 form: {shown(dir_row_path + undecodable_shown(name))}")
            row_path = dir_row_path + name
            try:
                is_link = en.is_symlink() or (IS_WIN and hasattr(en, "is_junction") and en.is_junction())
                if is_link:
                    kind = "link"
                elif en.is_dir(follow_symlinks=False):
                    kind = "dir"
                elif en.is_file(follow_symlinks=False):
                    kind = "file"
                else:
                    kind = "other"
            except FileNotFoundError:
                continue                        # vanished between the listing and its type
            except OSError as e:
                self.pre_rows.append(row("#error", spelled(describe(e)), "", "", spelled(row_path)))
                continue
            if kind == "dir":
                self.walk_dir(row_path + SEP)
            elif kind == "file":
                if any(c in row_path for c in "\t\r\n"):
                    raise Stop(f"a file's path holds a tab, CR or LF: {shown(row_path)}")
                self.files.append(row_path)
            elif kind == "link":
                self.link(row_path)
            # pipes, sockets, devices: no row

    def link(self, row_path):
        """Into the backup: no row.  Broken, or to a pipe/socket/device: no row.  Out of the
        backup, or unresolvable here: an #error row naming the target as the link holds it."""
        try:
            target_text = os.readlink(os_path(row_path))
            if IS_WIN:
                target_text = strip_win_prefix(target_text)
        except OSError as e:
            target_text = f"(unreadable link: {describe(e)})"
        try:
            resolved = os.path.realpath(os_path(row_path), strict=True)
        except OSError as e:
            if is_broken_link_error(e):
                return                          # broken: nothing is where it points
            self.pre_rows.append(row("#error", spelled(f"link somewhere this computer can't resolve ({describe(e)}): {target_text}"),
                                     "", "", spelled(row_path)))
            return
        try:
            st = os.stat(resolved)
        except OSError as e:
            if is_broken_link_error(e):
                return
            self.pre_rows.append(row("#error", spelled(f"link somewhere this computer can't resolve ({describe(e)}): {target_text}"),
                                     "", "", spelled(row_path)))
            return
        is_dir = stat.S_ISDIR(st.st_mode)
        if not is_dir and not stat.S_ISREG(st.st_mode):
            return                              # a link to a pipe, socket or device
        if IS_WIN:
            resolved = strip_win_prefix(resolved)
            if re.match(r"^[a-z]:", resolved):
                resolved = resolved[0].upper() + resolved[1:]
        else:
            try:
                resolved = _posix_true_case(resolved)
            except OSError:
                pass
        if self.inside_backup(resolved):
            return                              # into the backup: recorded where it lies
        what = "folder" if is_dir else "file"
        path = row_path + SEP if is_dir else row_path
        self.pre_rows.append(row("#error", spelled(f"link to a {what} outside the backup: {target_text}"), "", "", spelled(path)))


def is_broken_link_error(e):
    if IS_WIN:
        return getattr(e, "winerror", None) in (2, 3, 1921)
    return e.errno in (errno.ENOENT, errno.ENOTDIR, errno.ELOOP)


def describe(e):
    code = errno.errorcode.get(e.errno, type(e).__name__) if getattr(e, "errno", None) else type(e).__name__
    msg = getattr(e, "strerror", None) or str(e)
    if IS_WIN and getattr(e, "winerror", None) is not None:
        return f"{code}: {msg} (winerror {e.winerror})"
    return f"{code}: {msg}"


# ----------------------------------------------------------------------------- hashing

def open_regular(row_path):
    """Open a file without following a link at its name, and check it is still a regular
    file.  Returns (fd, stat) or raises OSError / a ValueError saying what it is now."""
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_BINARY", 0) | getattr(os, "O_NONBLOCK", 0)
    fd = os.open(os_path(row_path), flags)
    try:
        st = os.fstat(fd)
        if not stat.S_ISREG(st.st_mode):
            raise ValueError("no longer a regular file")
        return fd, st
    except BaseException:
        os.close(fd)
        raise


def hash_file(row_path):
    """A file row's fields (hash, size, mtime) or an #error message.  Size and time come
    from one fstat of the handle that is hashed, taken just before the read."""
    try:
        fd, st = open_regular(row_path)
    except FileNotFoundError:
        return None, "ENOENT: file vanished before it could be read"
    except OSError as e:
        if e.errno == errno.ELOOP:
            return None, "ELOOP: replaced by a link before it could be read"
        return None, describe(e)
    except ValueError as e:
        return None, str(e)
    try:
        size = st.st_size
        ms = ns_round_to_ms(st.st_mtime_ns)
        mtime = iso_from_ms(ms)
        if mtime is None:
            return None, f"modification time can't be held in the 24-character form ({ms} ms since 1970)"
        h = hashlib.sha256()
        count = 0
        while True:
            try:
                chunk = os.read(fd, READ_CHUNK)
            except OSError as e:
                return None, describe(e)
            if not chunk:
                break
            h.update(chunk)
            count += len(chunk)
        if count != size:
            return None, f"read returned {count} bytes, size was {size}"
        return (h.hexdigest(), size, mtime), None
    finally:
        os.close(fd)


# ----------------------------------------------------------------------------- upload

class Uploader:
    def __init__(self, store):
        self.store = store

    def ensure(self, hsh, size, mtime, row_path):
        """Make sure objects/<hash> holds exactly the bytes that hash to it.  Returns
        'stored', 'uploaded', or 'changed' (the file no longer matches its row; nothing
        was left under the key)."""
        key = "objects/" + hsh
        if self.store.head(key):
            return "stored"
        try:
            fd, st = open_regular(row_path)
        except (OSError, ValueError) as e:
            print(f"  changed: {shown(row_path)}: {e}")
            return "changed"
        try:
            if st.st_size != size or iso_from_ms(ns_round_to_ms(st.st_mtime_ns)) != mtime:
                print(f"  changed: {shown(row_path)}: size or time differs from its row")
                return "changed"
            if size < PART_SIZE:
                return self._put_whole(fd, key, hsh, size, row_path)
            return self._put_multipart(fd, key, hsh, size, row_path)
        finally:
            os.close(fd)

    def _read_exactly(self, fd, n):
        buf = bytearray()
        while len(buf) < n:
            chunk = os.read(fd, min(READ_CHUNK, n - len(buf)))
            if not chunk:
                break
            buf += chunk
        return bytes(buf)

    def _put_whole(self, fd, key, hsh, size, row_path):
        data = self._read_exactly(fd, size + 1)
        if len(data) != size or hashlib.sha256(data).hexdigest() != hsh:
            print(f"  changed: {shown(row_path)}: content no longer hashes to its row")
            return "changed"
        # S3 compares the body with the key's own digest (ChecksumSHA256), so a body that
        # doesn't hash to the key stores nothing.
        stored = self.store.put_new(key, data, self.store.sse)
        return "uploaded" if stored else "stored"

    def _put_multipart(self, fd, key, hsh, size, row_path):
        s = self.store
        params = dict(Bucket=s.bucket, Key=key, ChecksumAlgorithm="SHA256")
        params.update(s.sse)
        mp = s.client.create_multipart_upload(**params)
        upload_id = mp["UploadId"]
        whole = hashlib.sha256()
        parts = []
        total = 0
        try:
            n = 1
            while True:
                chunk = self._read_exactly(fd, PART_SIZE)
                if not chunk and n > 1:
                    break
                whole.update(chunk)
                total += len(chunk)
                r = s.client.upload_part(Bucket=s.bucket, Key=key, UploadId=upload_id, PartNumber=n,
                                         Body=chunk,
                                         ChecksumSHA256=base64.b64encode(hashlib.sha256(chunk).digest()).decode("ascii"))
                parts.append({"PartNumber": n, "ETag": r["ETag"], "ChecksumSHA256": r["ChecksumSHA256"]})
                if len(chunk) < PART_SIZE:
                    break
                n += 1
            if total != size or whole.hexdigest() != hsh:
                s.client.abort_multipart_upload(Bucket=s.bucket, Key=key, UploadId=upload_id)
                print(f"  changed: {shown(row_path)}: content no longer hashes to its row")
                return "changed"
            try:
                s.client.complete_multipart_upload(Bucket=s.bucket, Key=key, UploadId=upload_id,
                                                   MultipartUpload={"Parts": parts}, IfNoneMatch="*")
                return "uploaded"
            except ClientError as e:
                if Store._status(e) == 412 or Store._code(e) == "PreconditionFailed":
                    try:
                        s.client.abort_multipart_upload(Bucket=s.bucket, Key=key, UploadId=upload_id)
                    except ClientError:
                        pass
                    return "stored"
                raise
        except BaseException:
            try:
                s.client.abort_multipart_upload(Bucket=s.bucket, Key=key, UploadId=upload_id)
            except Exception:
                pass
            raise


# ----------------------------------------------------------------------------- locks

class Lock:
    def __init__(self, store, set_name, by):
        self.store = store
        self.set_name = set_name
        self.by = by
        self.os = sys.platform
        self.pidns = pid_namespace()
        self.key = None
        self.body = None

    def identity_lines(self, started_iso):
        lines = [f"COMMAND=backup", f"SET={self.set_name}", f"BY={self.by}", f"OS={self.os}"]
        if self.pidns is not None:
            lines.append(f"PIDNS={self.pidns}")
        lines += [f"PID={os.getpid()}", f"STARTED={started_iso}"]
        return ("\n".join(lines) + "\n").encode("utf-8")

    def acquire(self):
        """Write first, look second."""
        while True:
            iso = iso_from_ms(ns_floor_to_ms(time.time_ns()))
            key = f"locks/upload-{basic_from_iso(iso)}"
            body = self.identity_lines(iso)
            if self.store.put_new(key, body):
                break
            existing = self.store.get(key)
            if existing == body:
                break                           # our own write, retried after a lost response
            time.sleep(0.01)                    # another run took that instant: take a fresh one
        self.key, self.body = key, body
        print(f"lock written: {key[len('locks/'):]}")
        # Now look.
        for key in self.store.list_folder("locks/"):
            if key == self.key:
                continue
            lock_id = key[len("locks/"):]
            kind = lock_id.split("-", 1)[0]
            data = self.store.get(key)
            if data is None:
                continue                        # gone already
            fields = parse_kv(data)
            if self.is_dead_run_of_mine(fields):
                print(f"removing a dead run's lock: {lock_id}")
                self.store.delete(key)
                continue
            if kind == "delete":
                self.release()
                raise Refused(f"a delete is running (lock {lock_id}); refusing to upload")
            # another upload may run beside this one

    def is_dead_run_of_mine(self, f):
        if f.get("BY") != self.by or f.get("OS") != self.os or f.get("PIDNS") != self.pidns:
            return False
        if "OS" not in f:
            return False
        pid = f.get("PID")
        if pid is None or not PID_RE.match(pid):
            return False
        return not process_alive(int(pid))

    def release(self):
        if self.key is None:
            return
        try:
            self.store.delete(self.key)
            print(f"lock removed: {self.key[len('locks/'):]}")
        except Exception as e:
            print(f"warning: couldn't remove lock {self.key[len('locks/'):]}: {e}", file=sys.stderr)
        self.key = None


# ----------------------------------------------------------------------------- the holder

def read_info(store, set_name):
    data = store.get(f"snapshots/{set_name}.info")
    return None if data is None else parse_kv(data)


def set_has_snapshots(store, set_name):
    for key in store.list_folder(f"snapshots/{set_name}/"):
        if SNAPSHOT_NAME_RE.match(key[len(f"snapshots/{set_name}/"):]):
            return True
    return False


def establish_holder(store, set_name, by, state):
    """Return the (OWNER, CLAIMED) pair this run publishes under, claiming the set when
    it is new.  Raises Refused when another holder has it or it has history and no holder."""
    skey = state_key(store)
    kept = state.get(skey, {}).get(set_name)
    info = read_info(store, set_name)
    if info is not None:
        if kept and info.get("OWNER") == kept["OWNER"] and info.get("CLAIMED") == kept["CLAIMED"]:
            return kept["OWNER"], kept["CLAIMED"]
        if kept:
            state[skey].pop(set_name, None)     # it can never match again
            save_state(state)
        raise Refused(f"set {set_name!r} is held by {info.get('OWNER')!r} (claimed {info.get('CLAIMED')!r}); "
                      "taking a set over is a person's decision, which this tool doesn't make")
    # No .info.
    if set_has_snapshots(store, set_name):
        raise Refused(f"set {set_name!r} has snapshots but no holder; it must be taken over by a person")
    claimed = iso_from_ms(ns_floor_to_ms(time.time_ns()))
    body = f"OWNER={by}\nCLAIMED={claimed}\nCREATED={claimed}\n".encode("utf-8")
    if not store.put_new(f"snapshots/{set_name}.info", body):
        again = store.get(f"snapshots/{set_name}.info")
        if again != body:
            raise Refused(f"set name {set_name!r} is taken")
    print(f"claimed set {set_name}: OWNER={by} CLAIMED={claimed}")
    state.setdefault(skey, {})[set_name] = {"OWNER": by, "CLAIMED": claimed}
    save_state(state)
    return by, claimed


def check_holder(store, set_name, pair):
    info = read_info(store, set_name)
    if info is None:
        raise Refused(f"snapshots/{set_name}.info is gone: the set has no holder")
    if info.get("OWNER") != pair[0] or info.get("CLAIMED") != pair[1]:
        raise Refused(f"set {set_name!r} is now held by {info.get('OWNER')!r} (claimed {info.get('CLAIMED')!r}), not this tool")


# ----------------------------------------------------------------------------- main

def usage():
    print("usage: python s3cab-backup.py <bucket> <set> <dir>...", file=sys.stderr)
    return 2


def main(argv):
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="backslashreplace")
        sys.stderr.reconfigure(encoding="utf-8", errors="backslashreplace")
    except Exception:
        pass
    if len(argv) < 4:
        return usage()
    bucket, set_name, dirs = argv[1], argv[2], argv[3:]
    if bucket.startswith("s3://"):
        bucket = bucket[5:].rstrip("/")
    if not SET_NAME_RE.match(set_name):
        print(f"error: {set_name!r} is not a set name (a-z, 0-9, single hyphens between)", file=sys.stderr)
        return 2

    # One clock reading mints the name and START.
    start_ns = time.time_ns()
    start_iso = iso_from_ms(ns_floor_to_ms(start_ns))
    snapshot_name = time.strftime("%Y%m%dT%H%M", time.localtime(start_ns // 1_000_000_000))
    zone = local_zone_name()
    by = user_at_machine()

    store = Store(bucket)
    state = load_state()
    lock = Lock(store, set_name, by)
    exit_code = 0
    try:
        lock.acquire()
        pair = establish_holder(store, set_name, by, state)

        # Member directories: real paths, spelled as the filesystem reports them.
        member_dirs = []
        for d in dirs:
            try:
                real = true_path(d)
            except OSError as e:
                raise Stop(f"member directory doesn't exist or can't be resolved: {shown(d)} ({describe(e)})")
            if not os.path.isdir(os_path(real)):
                raise Stop(f"member directory isn't a directory: {shown(d)}")
            if IS_WIN and not is_windows_path(real):
                raise Stop(f"member directory has no drive letter and no share: {shown(real)}")
            member_dirs.append(with_one_trailing_sep(real))
        for i, a in enumerate(member_dirs):
            for b in member_dirs[i + 1:]:
                if is_under_or_equal(a, b) or is_under_or_equal(b, a):
                    raise Stop(f"member directories overlap: {shown(a)} and {shown(b)}")

        print(f"snapshot {snapshot_name} of set {set_name} -> s3://{bucket}")
        for d in member_dirs:
            print(f"  DIR {shown(d)}")

        walk = Walk(member_dirs)
        walk.run()
        print(f"walked: {len(walk.files)} files, {len(walk.pre_rows)} #error/#excluded rows")

        # Hash every file; size and time from the same check, just before the read.
        file_rows = []                           # (hash, size, mtime, path) or None
        body_rows = []
        total_size = 0
        first_path_for_hash = {}
        error_rows = len(walk.pre_rows)
        for p in walk.files:
            fields, err = hash_file(p)
            if err is not None:
                body_rows.append(row("#error", spelled(err), "", "", p))
                error_rows += 1
                continue
            hsh, size, mtime = fields
            body_rows.append(row("-", hsh, str(size), mtime, p))
            file_rows.append((hsh, size, mtime, p))
            total_size += size
            first_path_for_hash.setdefault(hsh, (size, mtime, p))
        # FINISH: when the last row before FILES was ready, i.e. when the last file was done
        # (this tool hashes first and writes the file afterwards).  Rounded up.
        finish_ns = time.time_ns()
        finish_iso = iso_from_ms(ns_ceil_to_ms(finish_ns))
        finish_ms = ns_ceil_to_ms(finish_ns) - ns_floor_to_ms(start_ns)
        print(f"hashed: {len(file_rows)} file rows, {len(first_path_for_hash)} distinct objects, {total_size} bytes")

        # Objects first.
        uploader = Uploader(store)
        changed = []
        counts = {"stored": 0, "uploaded": 0}
        for hsh, (size, mtime, p) in first_path_for_hash.items():
            result = uploader.ensure(hsh, size, mtime, p)
            if result == "changed":
                changed.append(p)
            else:
                counts[result] += 1
        print(f"objects: {counts['uploaded']} uploaded, {counts['stored']} already stored, {len(changed)} changed")

        # The snapshot text.
        lines = [row(*HEADING),
                 row("@S3CAB", "SPEC", "", "", SPEC_DATE),
                 row("@CLIENT", "NAME", "", "", CLIENT_NAME),
                 row("@CLIENT", "VERSION", "", "", CLIENT_VERSION),
                 row("@SET", "NAME", "", "", set_name),
                 row("@SET", "BUCKET", "", "", f"s3://{bucket}")]
        if store.endpoint:
            lines.append(row("@SET", "ENDPOINT", "", "", store.endpoint))
        for d in member_dirs:
            lines.append(row("@SET", "DIR", "", "", spelled(d)))
        lines += [row("@SNAPSHOT", "NAME", "", "", snapshot_name),
                  row("@SNAPSHOT", "BY", "", "", by),
                  row("@SNAPSHOT", "START", "", start_iso, spelled(zone))]
        lines += walk.pre_rows
        lines += body_rows
        lines += [row("@SNAPSHOT", "FILES", "", "", str(len(file_rows))),
                  row("@SNAPSHOT", "SIZE", "", "", f"{total_size} ({readable_size(total_size)})"),
                  row("@SNAPSHOT", "FINISH", "", finish_iso, duration_text(finish_ms)),
                  ".\n"]
        text = "".join(lines).encode("utf-8")
        buf = io.BytesIO()
        with gzip.GzipFile(filename="", mode="wb", fileobj=buf, mtime=0) as gz:
            gz.write(text)
        snapshot_bytes = buf.getvalue()

        if changed:
            print(f"error: {len(changed)} file(s) changed between the snapshot and the upload; "
                  f"the snapshot names objects the repository doesn't hold, so it isn't uploaded. Run again.")
            for p in changed:
                print(f"  {shown(p)}")
            return 1

        # Snapshot last, after the holder check.
        check_holder(store, set_name, pair)
        key = f"snapshots/{set_name}/{snapshot_name}.tsv.gz"
        if store.put_new(key, snapshot_bytes):
            print(f"snapshot uploaded: {key} ({len(snapshot_bytes)} bytes gzip, {len(text)} bytes text)")
        else:
            existing = store.get(key)
            if existing == snapshot_bytes:
                print(f"snapshot already uploaded, same bytes: {key}")
            else:
                raise Refused(f"a different snapshot already exists at {key} (a second snapshot of the set in the same minute)")
        if error_rows:
            print(f"{error_rows} #error row(s) in the snapshot; exit 1")
            exit_code = 1
        return exit_code
    except Stop as e:
        print(f"stopped, no snapshot written: {e}", file=sys.stderr)
        return 1
    except (ClientError, BotoCoreError) as e:
        print(f"error: a request to the store failed: {e}", file=sys.stderr)
        return 1
    except Refused as e:
        print(f"refused: {e}", file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        print("interrupted", file=sys.stderr)
        return 1
    finally:
        lock.release()


if __name__ == "__main__":
    sys.exit(main(sys.argv))
