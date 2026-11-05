#!/usr/bin/env python3
"""s3cab-backup.py: back up a set of directories into an s3cab repository.

    python s3cab-backup.py <bucket> <set> <dir>...

Written from the s3cab format spec of 2026-10-30 (format.md) alone, with the
Python standard library and boto3.  Correct rather than fast: nothing is kept
between runs except what the spec says a backup keeps, the OWNER/CLAIMED pair
of each set this program claimed, stored beside this file under
s3cab-backup.state/<bucket>/<set>.info.

Exit status: 0 when the snapshot was uploaded and holds no #error row,
1 when it was uploaded but holds one, 2 when the run stopped or refused
and no snapshot was written.
"""

import base64
import ctypes
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

import boto3
from botocore.config import Config
from botocore.exceptions import BotoCoreError, ClientError

SPEC_DATE = "2026-10-30"
CLIENT_NAME = "s3cab-backup"
CLIENT_VERSION = "0.1.0"
FORMAT_URL = "https://s3cab.plantegral.com/guide/format"
HEADING_FIELDS = ("@S3CAB", "FORMAT", "size", "time", FORMAT_URL)
KNOWN_TYPES = ("-", "#excluded", "#error", "@S3CAB", "@CLIENT", "@SET", "@SNAPSHOT")

MIB = 1024 * 1024
MULTIPART_THRESHOLD = 16 * MIB   # a file this large or larger goes up in parts
MIN_PART_SIZE = 16 * MIB
MAX_PARTS = 10000                # S3's limit
READ_CHUNK = MIB

WINDOWS = sys.platform == "win32"
SEP = os.sep
SET_NAME_RE = re.compile(r"^[a-z0-9]+(-[a-z0-9]+)*$")
SNAPSHOT_FILE_RE = re.compile(r"^[0-9]{8}T[0-9]{4}\.tsv\.gz$")
HEX64_RE = re.compile(r"^[0-9a-f]{64}$")
INSTANT_RE = re.compile(r"^([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})\.([0-9]{3})Z$")

EXIT_OK, EXIT_ERRORS, EXIT_STOPPED = 0, 1, 2

# JavaScript's trim() set, which is what the spec's leading-field trim removes.
TRIM_CHARS = ("\t\n\v\f\r         "
              "       　  ﻿")


class Stop(Exception):
    """The run stops or refuses: no snapshot is written."""


# ---------------------------------------------------------------- time

def civil_from_days(z):
    """Proleptic Gregorian (year, month, day) of a day count since 1970-01-01.

    Howard Hinnant's algorithm; Python's floor division keeps it right before 1970."""
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


def instant(ms):
    """The 24-character form of a millisecond count since the epoch, or None
    when the year falls outside 0000 to 9999."""
    secs, msec = divmod(ms, 1000)
    days, sod = divmod(secs, 86400)
    y, m, d = civil_from_days(days)
    if not 0 <= y <= 9999:
        return None
    hh, rem = divmod(sod, 3600)
    mm, ss = divmod(rem, 60)
    return "%04d-%02d-%02dT%02d:%02d:%02d.%03dZ" % (y, m, d, hh, mm, ss, msec)


def valid_instant(s):
    m = INSTANT_RE.match(s)
    if not m:
        return False
    y, mo, d, h, mi, sec, _ = (int(x) for x in m.groups())
    if not 1 <= mo <= 12:
        return False
    leap = (y % 4 == 0 and y % 100 != 0) or y % 400 == 0
    mdays = (31, 29 if leap else 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31)
    return 1 <= d <= mdays[mo - 1] and h <= 23 and mi <= 59 and sec <= 59


def round_ms(ns):
    """Nearest millisecond, a tie to the later one; on the integer count, never a float."""
    return (ns + 500_000) // 1_000_000


def floor_ms(ns):
    return ns // 1_000_000


def ceil_ms(ns):
    return -((-ns) // 1_000_000)


def basic_instant(ms):
    """20261027T140205.123Z, the form a lock id uses."""
    s = instant(ms)
    return s[0:4] + s[5:7] + s[8:10] + "T" + s[11:13] + s[14:16] + s[17:23] + "Z"


def snapshot_name(ns):
    """YYYYMMDDTHHMM, local wall-clock time cut down to the minute."""
    t = time.localtime(ns // 1_000_000_000)
    return "%04d%02d%02dT%02d%02d" % (t.tm_year, t.tm_mon, t.tm_mday, t.tm_hour, t.tm_min)


def local_zone_name(ns):
    """The best name this machine has for its local zone; free text in the spec."""
    tz = os.environ.get("TZ", "")
    if tz.startswith(":"):
        tz = tz[1:]
    if tz:
        # time.localtime() minted the snapshot's name under this very setting
        i = tz.find("zoneinfo/")
        return tz[i + len("zoneinfo/"):] if i >= 0 else tz
    if not WINDOWS:
        try:
            p = os.path.realpath("/etc/localtime")
            i = p.find("zoneinfo/")
            if i >= 0:
                return p[i + len("zoneinfo/"):]
        except OSError:
            pass
        if tz:
            return tz
    else:
        try:
            icu = ctypes.windll.icu  # Windows 10 1903 and later
            buf = ctypes.create_unicode_buffer(128)
            status = ctypes.c_int(0)
            n = icu.ucal_getDefaultTimeZone(buf, 128, ctypes.byref(status))
            if n > 0 and status.value <= 0 and buf.value:
                return buf.value
        except (OSError, AttributeError):
            pass
    t = time.localtime(ns // 1_000_000_000)
    off = getattr(t, "tm_gmtoff", None)
    name = getattr(t, "tm_zone", None) or (time.tzname[1] if t.tm_isdst > 0 else time.tzname[0])
    if off is None:
        return name
    sign = "+" if off >= 0 else "-"
    off = abs(off)
    return "%s (UTC%s%02d:%02d)" % (name, sign, off // 3600, off % 3600 // 60)


def duration_text(ms):
    s = (ms + 500) // 1000
    if s < 60:
        return "%ds" % s
    if s < 3600:
        return "%dm %02ds" % (s // 60, s % 60)
    return "%dh %02dm" % (s // 3600, s % 3600 // 60)


# ---------------------------------------------------------------- text

def readable_size(n):
    """The spec's readable form: 0B..999B, then one decimal, half up, in the
    smallest of kB..PB that keeps it under 1000.0."""
    if n < 1000:
        return "%dB" % n
    for unit, div in (("kB", 10 ** 3), ("MB", 10 ** 6), ("GB", 10 ** 9), ("TB", 10 ** 12), ("PB", 10 ** 15)):
        tenths = (n * 10 + div // 2) // div
        if tenths < 10000 or unit == "PB":
            return "%d.%d%s" % (tenths // 10, tenths % 10, unit)


def spell(s):
    """Tab, CR and LF spelled out as the Control Pictures, for every field but a file row's path."""
    return s.replace("\t", "␉").replace("\r", "␍").replace("\n", "␊")


def display(s):
    """A name for a message: undecodable parts as U+FFFD, line breaks spelled out."""
    return spell(os.fsencode(s).decode("utf-8", "replace"))


def row(c1, c2="", c3="", c4="", c5=""):
    """One canonical line: column 1 unpadded, 2 left-justified to 64, 3 right to 12, 4 left to 24, 5 verbatim."""
    return "%s\t%s\t%s\t%s\t%s\n" % (c1, c2.ljust(64), c3.rjust(12), c4.ljust(24), c5)


def heading_row():
    return row(*HEADING_FIELDS)


def trim(s):
    return s.strip(TRIM_CHARS)


def has_utf8_form(name):
    try:
        name.encode("utf-8")
        return True
    except UnicodeEncodeError:
        return False


def os_error_text(e):
    code = ""
    if getattr(e, "winerror", None) is not None:
        code = "winerror %d" % e.winerror
    elif e.errno is not None:
        code = errno.errorcode.get(e.errno, "errno %d" % e.errno)
    text = e.strerror or str(e)
    return "%s: %s" % (code, text) if code else text


def parse_kv(data):
    """The .info / lock reading rule: UTF-8, split on LF, one trailing CR stripped,
    split at the first '=', last repeated key wins, lines without '=' skipped."""
    out = {}
    for line in data.decode("utf-8", "replace").split("\n"):
        if line.endswith("\r"):
            line = line[:-1]
        if "=" not in line:
            continue
        k, v = line.split("=", 1)
        out[k] = v
    return out


# ---------------------------------------------------------------- paths

def fs(path):
    """The spelling handed to the operating system: on Windows through \\\\?\\."""
    if not WINDOWS or path.startswith("\\\\?\\"):
        return path
    if path.startswith("\\\\"):
        return "\\\\?\\UNC\\" + path[2:]
    return "\\\\?\\" + path


def unfs(path):
    """A path as Windows hands it back, without the \\\\?\\ prefix."""
    if not WINDOWS:
        return path
    if path.startswith("\\\\?\\UNC\\"):
        return "\\\\" + path[8:]
    if path.startswith("\\\\?\\"):
        return path[4:]
    return path


def true_spelling(real):
    """POSIX: re-spell each segment as its parent lists it.  realpath keeps the
    case as typed on macOS and in a Linux directory that ignores case."""
    cur = "/"
    out = []
    for seg in real.split("/"):
        if seg == "":
            continue
        try:
            names = os.listdir(cur)
        except OSError:
            names = None
        if names is not None and seg not in names:
            try:
                want = os.lstat(os.path.join(cur, seg))
                for n in names:
                    try:
                        st = os.lstat(os.path.join(cur, n))
                    except OSError:
                        continue
                    if st.st_dev == want.st_dev and st.st_ino == want.st_ino:
                        seg = n
                        break
            except OSError:
                pass
        out.append(seg)
        cur = os.path.join(cur, seg)
    return "/" + "/".join(out)


def real_path(path):
    """The spec's real path: every link, short name and case resolved, drive letter upper case."""
    if WINDOWS:
        absolute = os.path.normpath(os.path.join(os.getcwd(), path))  # normpath keeps a trailing dot or space
        real = unfs(os.path.realpath(fs(absolute), strict=True))
        if re.match(r"^[a-zA-Z]:", real):
            real = real[0].upper() + real[1:]
        return real
    return true_spelling(os.path.realpath(path, strict=True))


def split_segments(path):
    """(root, [segments]) of a path in this OS's style.  Returns (None, None) for
    a Windows path with neither a drive letter nor a share."""
    if WINDOWS:
        m = re.match(r"^([a-zA-Z]):[\\/]", path)
        if m:
            root = m.group(1).upper() + ":\\"
            rest = path[3:]
        elif path.startswith(("\\\\", "//")):
            parts = [p for p in re.split(r"[\\/]", path[2:])]
            if len(parts) < 2 or parts[0] in ("", "?", ".") or parts[1] == "":
                return None, None
            root = "\\\\" + parts[0] + "\\" + parts[1] + "\\"
            rest = "\\".join(parts[2:])
        else:
            return None, None
        return root, [s for s in re.split(r"[\\/]", rest) if s != ""]
    return "/", [s for s in path.split("/") if s != ""]


def join_root(root, segs):
    return root + SEP.join(segs)


def dir_row_value(real):
    """A @SET DIR value: the real path ending in exactly one separator."""
    return real if real.endswith(SEP) else real + SEP


def link_is_broken(e):
    if WINDOWS:
        return getattr(e, "winerror", None) in (2, 3, 1921)
    return e.errno in (errno.ENOENT, errno.ENOTDIR, errno.ELOOP)


def pid_alive(pid):
    if WINDOWS:
        k32 = ctypes.windll.kernel32
        PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
        h = k32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
        if not h:
            return k32.GetLastError() == 5  # access denied: it exists
        code = ctypes.c_ulong()
        ok = k32.GetExitCodeProcess(h, ctypes.byref(code))
        k32.CloseHandle(h)
        return bool(ok) and code.value == 259  # STILL_ACTIVE
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    except OSError:
        return True


# ---------------------------------------------------------------- the store

def http_status(e):
    return e.response.get("ResponseMetadata", {}).get("HTTPStatusCode")


def error_code(e):
    return e.response.get("Error", {}).get("Code")


class Store:
    """The bucket.  Every PUT is conditional (If-None-Match: *): nothing is ever overwritten."""

    def __init__(self, bucket):
        region = os.environ.get("AWS_REGION") or os.environ.get("AWS_DEFAULT_REGION") or "us-east-1"
        cfg = Config(retries={"mode": "standard", "max_attempts": 5},
                     connect_timeout=10, read_timeout=30)
        self.bucket = bucket
        self.s3 = boto3.client("s3", region_name=region, config=cfg)
        # boto3 1.34 has no IfNoneMatch parameter: add the header to every PUT and
        # to CompleteMultipartUpload in a before-call handler, as the spec's hint says.
        self.s3.meta.events.register("before-call.s3.PutObject", self._no_overwrite)
        self.s3.meta.events.register("before-call.s3.CompleteMultipartUpload", self._no_overwrite)

    @staticmethod
    def _no_overwrite(params, **kwargs):
        params["headers"]["If-None-Match"] = "*"

    def put(self, key, data, sha256_digest=None):
        """Conditional PUT of bytes.  'stored', or 'exists' on a 412.  A PUT of an
        object carries x-amz-checksum-sha256 of its key, so S3 itself refuses bytes
        that don't hash to the key and stores nothing."""
        kw = dict(Bucket=self.bucket, Key=key, Body=data, ServerSideEncryption="AES256")
        if sha256_digest is not None:
            kw["ChecksumSHA256"] = base64.b64encode(sha256_digest).decode("ascii")
        try:
            r = self.s3.put_object(**kw)
        except ClientError as e:
            if http_status(e) == 412:
                return "exists"
            raise
        if sha256_digest is not None and r.get("ChecksumSHA256") != kw["ChecksumSHA256"]:
            raise Stop("S3 reported a different SHA-256 for %s than the one sent: %r" % (key, r.get("ChecksumSHA256")))
        return "stored"

    def get(self, key):
        """The bytes at key, or None when it is missing (404 NoSuchKey)."""
        try:
            r = self.s3.get_object(Bucket=self.bucket, Key=key)
        except ClientError as e:
            if http_status(e) == 404 and error_code(e) in ("NoSuchKey", "NotFound", "404"):
                return None
            raise
        return r["Body"].read()

    def head(self, key):
        try:
            return self.s3.head_object(Bucket=self.bucket, Key=key)
        except ClientError as e:
            if http_status(e) == 404:
                return None
            raise

    def delete(self, key):
        self.s3.delete_object(Bucket=self.bucket, Key=key)

    def list_dir(self, prefix):
        """Names of the keys directly under prefix (delimiter '/'), without the prefix."""
        names = []
        paginator = self.s3.get_paginator("list_objects_v2")
        for page in paginator.paginate(Bucket=self.bucket, Prefix=prefix, Delimiter="/"):
            for obj in page.get("Contents", []):
                names.append(obj["Key"][len(prefix):])
        return names

    def upload_multipart(self, key, path_fs, size, sha_hex):
        """Parts with their own x-amz-checksum-sha256, the whole file hashed from the
        same bytes, and CompleteMultipartUpload only when that hash is the key.
        Returns 'stored', 'exists' or 'changed'."""
        part_size = max(MIN_PART_SIZE, -(-size // MAX_PARTS))
        part_size = -(-part_size // MIB) * MIB
        created = self.s3.create_multipart_upload(Bucket=self.bucket, Key=key,
                                                  ChecksumAlgorithm="SHA256",
                                                  ServerSideEncryption="AES256")
        upload_id = created["UploadId"]
        completed = False
        try:
            whole = hashlib.sha256()
            parts = []
            sent = 0
            number = 1
            with open(path_fs, "rb") as f:
                while True:
                    chunk = f.read(part_size)
                    if not chunk:
                        break
                    whole.update(chunk)
                    sent += len(chunk)
                    part_sum = base64.b64encode(hashlib.sha256(chunk).digest()).decode("ascii")
                    r = self.s3.upload_part(Bucket=self.bucket, Key=key, UploadId=upload_id,
                                            PartNumber=number, Body=chunk, ChecksumSHA256=part_sum)
                    parts.append({"ETag": r["ETag"], "PartNumber": number, "ChecksumSHA256": part_sum})
                    number += 1
            if sent != size or whole.hexdigest() != sha_hex:
                return "changed"
            try:
                self.s3.complete_multipart_upload(Bucket=self.bucket, Key=key, UploadId=upload_id,
                                                  MultipartUpload={"Parts": parts})
            except ClientError as e:
                if http_status(e) == 412:
                    return "exists"
                raise
            completed = True
            return "stored"
        finally:
            if not completed:
                try:
                    self.s3.abort_multipart_upload(Bucket=self.bucket, Key=key, UploadId=upload_id)
                except (ClientError, BotoCoreError):
                    pass


# ---------------------------------------------------------------- the snapshot's own reader check

def reader_refuses(text, windows_paths):
    """Why a reader would refuse this snapshot whole, or one of its rows: None when it
    wouldn't.  The checks of 'valid and invalid files', run before an upload."""
    if not text.endswith("\n"):
        return "last line not terminated"
    lines = text[:-1].split("\n")
    if len(lines) < 2 or lines[-1] != ".":
        return "does not end with the '.' line"
    body = lines[:-1]
    if "" in body:
        return "holds a blank line"
    first = body[0].split("\t", 4)
    if len(first) != 5 or tuple(trim(f) for f in first[:4]) != HEADING_FIELDS[:4] or first[4] != FORMAT_URL:
        return "does not start with the heading row"
    counts = {"@S3CAB SPEC": 0, "@CLIENT NAME": 0, "@CLIENT VERSION": 0}
    dirs = []
    rows = []
    for n, line in enumerate(body[1:], 2):
        if "\r" in line:
            return "line %d holds a CR" % n
        fields = line.split("\t", 4)
        while len(fields) < 5:
            fields.append("")
        kind = trim(fields[0])
        if kind not in KNOWN_TYPES:
            if kind.startswith(("@", "#")):
                continue
            return "line %d has unknown type %r" % (n, kind)
        prop = trim(fields[1])
        if kind == "@SET" and prop == "DIR":
            dirs.append(fields[4])
        key = kind + " " + prop
        if key in counts:
            counts[key] += 1
        if kind in ("-", "#excluded", "#error"):
            rows.append((n, kind, fields))
    for key, c in counts.items():
        if c != 1:
            return "%s appears %d times" % (key, c)
    seen = {}
    files = []
    for n, kind, fields in rows:
        path = fields[4]
        if path in seen:
            return "line %d repeats the path of line %d" % (n, seen[path])
        seen[path] = n
        if kind != "-":
            continue
        h, size, t = trim(fields[1]), trim(fields[2]), trim(fields[3])
        if not HEX64_RE.match(h):
            return "line %d: hash %r is not 64 lowercase hex" % (n, h)
        if not re.match(r"^[0-9]+$", size):
            return "line %d: size %r is not decimal" % (n, size)
        if not valid_instant(t):
            return "line %d: time %r is not a real instant" % (n, t)
        if any(c in path for c in "\t\r\n\0"):
            return "line %d: path holds a tab, CR, LF or NUL" % n
        root, segs = split_segments(path)
        if root is None or not segs or any(s in ("", ".", "..") for s in segs):
            return "line %d: path %r is not absolute or has a bad segment" % (n, path)
        under = False
        for d in dirs:
            droot, dsegs = split_segments(d)
            if droot is None or dsegs is None:
                continue
            if windows_paths:
                same = droot.lower() == root.lower() and [s.lower() for s in segs[:len(dsegs)]] == [s.lower() for s in dsegs]
            else:
                same = droot == root and segs[:len(dsegs)] == dsegs
            if same and len(segs) > len(dsegs):
                under = True
                break
        if not under:
            return "line %d: path %r is under no @SET DIR" % (n, path)
        files.append((n, path))
    folders = set()
    for n, path in files:
        root, segs = split_segments(path)
        for i in range(1, len(segs)):
            folders.add(join_root(root, segs[:i]))
    for n, path in files:
        if path in folders:
            return "line %d: path %r is a folder of another file row" % (n, path)
    return None


# ---------------------------------------------------------------- the backup

class Backup:
    def __init__(self, bucket, set_name, dirs):
        self.bucket = bucket
        self.set = set_name
        self.dirs = dirs
        self.members = []          # real paths
        self.member_segs = []      # (root, segments) of each
        self.rows_top = []         # #error rows found while listing: links out, unknown types
        self.rows_files = []       # file rows, with #error rows for files that failed when read
        self.files = []            # (hash, size, mtime_ms, path) per file row
        self.error_count = 0
        self.by = "%s@%s" % (user_name(), machine_name())
        self.pidns = None
        if sys.platform.startswith("linux"):
            try:
                self.pidns = os.readlink("/proc/self/ns/pid")
            except OSError:
                pass
        self.pair = None
        self.store = None
        self.lock_key = None

    # -- state beside the program

    def state_path(self):
        here = os.path.dirname(os.path.abspath(__file__))
        return os.path.join(here, "s3cab-backup.state", self.bucket, self.set + ".info")

    def read_state(self):
        try:
            with open(self.state_path(), "rb") as f:
                return parse_kv(f.read())
        except OSError:
            return None

    def write_state(self, data):
        p = self.state_path()
        os.makedirs(os.path.dirname(p), exist_ok=True)
        with open(p, "wb") as f:
            f.write(data)

    def forget_state(self):
        try:
            os.remove(self.state_path())
        except OSError:
            pass

    # -- rows

    def error_row(self, message, path, at_top):
        self.error_count += 1
        line = row("#error", spell(message), "", "", spell(path))
        (self.rows_top if at_top else self.rows_files).append(line)
        print("#error  %s  %s" % (display(path), display(message)))

    # -- walking

    def resolve_members(self):
        for d in self.dirs:
            try:
                real = real_path(d)
            except FileNotFoundError:
                raise Stop("member directory %s does not exist" % display(d))
            except OSError as e:
                raise Stop("member directory %s can't be resolved: %s" % (display(d), os_error_text(e)))
            try:
                st = os.stat(fs(real))
            except OSError as e:
                raise Stop("member directory %s can't be checked: %s" % (display(d), os_error_text(e)))
            if not stat.S_ISDIR(st.st_mode):
                raise Stop("member directory %s is not a directory" % display(d))
            root, segs = split_segments(real)
            if root is None:
                raise Stop("member directory %s has no drive letter and no share: no path a reader accepts can name it" % display(real))
            self.members.append(real)
            self.member_segs.append((root, segs))
        for i in range(len(self.members)):
            for j in range(len(self.members)):
                if i == j:
                    continue
                ri, si = self.member_segs[i]
                rj, sj = self.member_segs[j]
                if ri == rj and si == sj and i < j:
                    raise Stop("member directories %s and %s are the same directory" % (display(self.dirs[i]), display(self.dirs[j])))
                if ri == rj and sj[:len(si)] == si and len(sj) > len(si):
                    raise Stop("member directory %s lies inside %s" % (display(self.dirs[j]), display(self.dirs[i])))

    def inside_backup(self, real):
        root, segs = split_segments(real)
        for mroot, msegs in self.member_segs:
            if root == mroot and segs[:len(msegs)] == msegs:
                return True
        return False

    def walk(self, dirpath):
        try:
            with os.scandir(fs(dirpath)) as it:
                entries = list(it)
        except OSError as e:
            raise Stop("directory %s can't be listed: %s" % (display(dirpath), os_error_text(e)))
        for entry in entries:
            name = entry.name
            if not has_utf8_form(name):
                raise Stop("the name %s in %s has no UTF-8 form; leave it out or rename it"
                           % (display(name), display(dirpath)))
            path = os.path.join(dirpath, name)
            try:
                st = entry.stat(follow_symlinks=False)
            except FileNotFoundError:
                continue  # vanished between being listed and its type being known
            except OSError as e:
                self.error_row(os_error_text(e), path, at_top=True)
                continue
            mode = st.st_mode
            is_link = stat.S_ISLNK(mode) or (
                WINDOWS and getattr(st, "st_reparse_tag", 0) == getattr(stat, "IO_REPARSE_TAG_MOUNT_POINT", 0xA0000003))
            if is_link:
                self.handle_link(path)
            elif stat.S_ISDIR(mode):
                self.walk(path)
            elif stat.S_ISREG(mode):
                self.handle_file(path)
            # a pipe, socket or device gets no row

    def handle_link(self, path):
        try:
            target = os.readlink(fs(path))
            if WINDOWS:
                target = unfs(target)
        except OSError as e:
            self.error_row("link this computer can't read: %s" % os_error_text(e), path, at_top=True)
            return
        try:
            real = unfs(os.path.realpath(fs(path), strict=True))
            if not WINDOWS:
                real = true_spelling(real)
            tst = os.stat(fs(real))
        except OSError as e:
            if link_is_broken(e):
                return  # broken: no row
            self.error_row("link to somewhere this computer can't resolve (%s): %s" % (os_error_text(e), target),
                           path, at_top=True)
            return
        if stat.S_ISDIR(tst.st_mode):
            kind, recorded = "folder", path + SEP
        elif stat.S_ISREG(tst.st_mode):
            kind, recorded = "file", path
        else:
            return  # a pipe, socket or device: no row
        if self.inside_backup(real):
            return  # recorded where it lies
        self.error_row("link to a %s outside the backup: %s" % (kind, target), recorded, at_top=True)

    def handle_file(self, path):
        if "\t" in path or "\r" in path or "\n" in path:
            raise Stop("the file %s has a tab, CR or LF in its path, which the format can't hold; rename it or leave it out"
                       % display(path))
        flags = os.O_RDONLY
        for name in ("O_BINARY", "O_NOFOLLOW", "O_NONBLOCK", "O_CLOEXEC"):
            flags |= getattr(os, name, 0)
        try:
            fd = os.open(fs(path), flags)
        except OSError as e:
            self.error_row(os_error_text(e), path, at_top=False)
            return
        try:
            st = os.fstat(fd)
            if not stat.S_ISREG(st.st_mode):
                self.error_row("not a regular file when opened", path, at_top=False)
                return
            size, mtime_ns = st.st_size, st.st_mtime_ns
            h = hashlib.sha256()
            n = 0
            with os.fdopen(fd, "rb", buffering=0) as f:
                fd = None
                while True:
                    chunk = f.read(READ_CHUNK)
                    if not chunk:
                        break
                    h.update(chunk)
                    n += len(chunk)
        except OSError as e:
            self.error_row(os_error_text(e), path, at_top=False)
            return
        finally:
            if fd is not None:
                os.close(fd)
        if n != size:
            self.error_row("read %d bytes of a file of %d bytes" % (n, size), path, at_top=False)
            return
        ms = round_ms(mtime_ns)
        t = instant(ms)
        if t is None:
            self.error_row("modification time outside the years 0000 to 9999 (%d ms since 1970)" % ms, path, at_top=False)
            return
        self.rows_files.append(row("-", h.hexdigest(), str(size), t, path))
        self.files.append((h.hexdigest(), size, ms, path))

    # -- the bucket

    def take_lock(self, ms):
        while True:
            lock_id = "upload-" + basic_instant(ms)
            lines = ["COMMAND=backup", "SET=" + self.set, "BY=" + self.by, "OS=" + sys.platform]
            if self.pidns is not None:
                lines.append("PIDNS=" + self.pidns)
            lines += ["PID=%d" % os.getpid(), "STARTED=" + instant(ms)]
            body = ("\n".join(lines) + "\n").encode("utf-8")
            key = "locks/" + lock_id
            if self.store.put(key, body) == "stored" or self.store.get(key) == body:
                self.lock_key = key
                return
            ms = max(floor_ms(time.time_ns()), ms + 1)  # another run took that instant

    def check_other_locks(self):
        blocking = []
        for name in self.store.list_dir("locks/"):
            key = "locks/" + name
            if key == self.lock_key:
                continue
            kind = name.split("-", 1)[0]
            body = self.store.get(key)
            if body is None:
                continue
            info = parse_kv(body)
            mine = (info.get("BY") == self.by and info.get("OS") is not None
                    and info.get("OS") == sys.platform and info.get("PIDNS") == self.pidns)
            if mine and re.match(r"^[0-9]+$", info.get("PID", "")) and not pid_alive(int(info["PID"])):
                print("removing the lock %s of a run of this machine that is gone" % name)
                self.store.delete(key)
                continue
            if kind == "delete":
                blocking.append(name)
        if blocking:
            raise Stop("a delete is running (lock %s): uploads and deletes take turns" % ", ".join(blocking))

    def check_holder(self):
        info_key = "snapshots/%s.info" % self.set
        kept = self.read_state()
        body = self.store.get(info_key)
        if body is not None:
            info = parse_kv(body)
            if kept and info.get("OWNER") == kept.get("OWNER") and info.get("CLAIMED") == kept.get("CLAIMED"):
                self.pair = (kept["OWNER"], kept["CLAIMED"])
                return
            self.forget_state()
            raise Stop("the set %s is held by %r since %r, not by this program; take it over first"
                       % (self.set, info.get("OWNER"), info.get("CLAIMED")))
        existing = [n for n in self.store.list_dir("snapshots/%s/" % self.set) if SNAPSHOT_FILE_RE.match(n)]
        if existing:
            raise Stop("the set %s has %d snapshot(s) but no %s: it has no holder until one takes it over"
                       % (self.set, len(existing), info_key))
        now = instant(floor_ms(time.time_ns()))
        body = ("OWNER=%s\nCLAIMED=%s\nCREATED=%s\n" % (self.by, now, now)).encode("utf-8")
        if self.store.put(info_key, body) == "exists" and self.store.get(info_key) != body:
            raise Stop("another machine claimed the set %s first" % self.set)
        self.write_state(body)
        self.pair = (self.by, now)
        print("claimed the set %s as %s at %s" % (self.set, self.by, now))

    def check_holder_again(self):
        body = self.store.get("snapshots/%s.info" % self.set)
        if body is None:
            raise Stop("snapshots/%s.info is gone: the set has no holder, so the snapshot is not uploaded" % self.set)
        info = parse_kv(body)
        if (info.get("OWNER"), info.get("CLAIMED")) != self.pair:
            self.forget_state()
            raise Stop("the set %s was taken over by %r at %r: the snapshot is not uploaded"
                       % (self.set, info.get("OWNER"), info.get("CLAIMED")))

    def upload_objects(self):
        print("listing objects/ ...")
        stored = set(n for n in self.store.list_dir("objects/") if HEX64_RE.match(n))
        first = {}
        for h, size, ms, path in self.files:
            first.setdefault(h, (size, ms, path))
        todo = [h for h in first if h not in stored]
        print("%d distinct objects, %d already stored, %d to upload" % (len(first), len(first) - len(todo), len(todo)))
        sent_bytes = 0
        for h in todo:
            size, ms, path = first[h]
            key = "objects/" + h
            try:
                st = os.stat(fs(path))
            except OSError as e:
                raise Stop("%s can't be checked before sending: %s" % (display(path), os_error_text(e)))
            if not stat.S_ISREG(st.st_mode) or st.st_size != size or round_ms(st.st_mtime_ns) != ms:
                raise Stop("%s changed since it was read (size %d, time %s now): the snapshot is not uploaded"
                           % (display(path), st.st_size, instant(round_ms(st.st_mtime_ns))))
            if size >= MULTIPART_THRESHOLD:
                result = self.store.upload_multipart(key, fs(path), size, h)
            else:
                with open(fs(path), "rb") as f:
                    data = f.read()
                if len(data) != size or hashlib.sha256(data).hexdigest() != h:
                    result = "changed"
                else:
                    try:
                        result = self.store.put(key, data, hashlib.sha256(data).digest())
                    except ClientError as e:
                        if error_code(e) == "BadDigest":
                            result = "changed"
                        else:
                            raise
            if result == "changed":
                raise Stop("%s no longer hashes to %s: nothing stored, the snapshot is not uploaded" % (display(path), h))
            sent_bytes += size
            print("%s  %s  %d bytes  %s" % (result, h, size, display(path)))
        print("uploaded %d objects, %d bytes" % (len(todo), sent_bytes))

    # -- the run

    def run(self):
        if not SET_NAME_RE.match(self.set):
            raise Stop("the set name %r is not letters a-z and digits with single hyphens between them" % self.set)
        start_ns = time.time_ns()
        start_ms = floor_ms(start_ns)
        name = snapshot_name(start_ns)
        zone = local_zone_name(start_ns)
        snapshot_key = "snapshots/%s/%s.tsv.gz" % (self.set, name)
        print("s3cab-backup %s: set %s -> s3://%s/%s" % (CLIENT_VERSION, self.set, self.bucket, snapshot_key))
        self.resolve_members()
        for m in self.members:
            print("member directory %s" % display(dir_row_value(m)))
        self.store = Store(self.bucket)
        self.take_lock(start_ms)
        try:
            self.check_other_locks()
            self.check_holder()
            if self.store.head(snapshot_key) is not None:
                raise Stop("a snapshot of %s for the minute %s already exists; a second one in the same minute is refused"
                           % (self.set, name))
            for m in self.members:
                self.walk(m)
            finish_ns = time.time_ns()
            finish_ms = ceil_ms(finish_ns)
            total = sum(size for _, size, _, _ in self.files)
            lines = [heading_row(),
                     row("@S3CAB", "SPEC", "", "", SPEC_DATE),
                     row("@CLIENT", "NAME", "", "", CLIENT_NAME),
                     row("@CLIENT", "VERSION", "", "", CLIENT_VERSION),
                     row("@SET", "NAME", "", "", self.set),
                     row("@SET", "BUCKET", "", "", "s3://" + self.bucket)]
            lines += [row("@SET", "DIR", "", "", spell(dir_row_value(m))) for m in self.members]
            lines += [row("@SNAPSHOT", "NAME", "", "", name),
                      row("@SNAPSHOT", "BY", "", "", spell(self.by)),
                      row("@SNAPSHOT", "START", "", instant(start_ms), spell(zone))]
            lines += self.rows_top + self.rows_files
            lines += [row("@SNAPSHOT", "FILES", "", "", str(len(self.files))),
                      row("@SNAPSHOT", "SIZE", "", "", "%d (%s)" % (total, readable_size(total))),
                      row("@SNAPSHOT", "FINISH", "", instant(finish_ms), duration_text(finish_ms - start_ms)),
                      ".\n"]
            text = "".join(lines)
            reason = reader_refuses(text, windows_paths=WINDOWS)
            if reason is not None:
                raise Stop("the snapshot would be refused by a reader (%s): not uploaded" % reason)
            buf = io.BytesIO()
            with gzip.GzipFile(filename="", mode="wb", fileobj=buf, mtime=0, compresslevel=9) as gz:
                gz.write(text.encode("utf-8"))
            compressed = buf.getvalue()
            print("snapshot %s: %d file rows, %d bytes, %d #error rows" % (name, len(self.files), total, self.error_count))
            self.upload_objects()
            self.check_holder_again()
            result = self.store.put(snapshot_key, compressed, hashlib.sha256(compressed).digest())
            if result == "exists":
                if self.store.get(snapshot_key) == compressed:
                    print("the snapshot %s was already uploaded, byte for byte" % snapshot_key)
                else:
                    raise Stop("a different snapshot is already at %s: conflict, not overwritten" % snapshot_key)
            else:
                print("uploaded %s (%d bytes)" % (snapshot_key, len(compressed)))
        finally:
            self.release_lock()
        if self.error_count:
            print("done with %d #error row(s): exit 1" % self.error_count)
            return EXIT_ERRORS
        print("done")
        return EXIT_OK

    def release_lock(self):
        if self.lock_key is None:
            return
        try:
            self.store.delete(self.lock_key)
        except (ClientError, BotoCoreError) as e:
            print("could not remove the lock %s: %s; remove it by hand once this run is over"
                  % (self.lock_key[len("locks/"):], e), file=sys.stderr)
        self.lock_key = None


def user_name():
    try:
        return getpass.getuser()
    except Exception:
        return "unknown"


def machine_name():
    try:
        return socket.gethostname() or "unknown"
    except OSError:
        return "unknown"


def main(argv):
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="backslashreplace", line_buffering=True)
        except (AttributeError, ValueError):
            pass
    if len(argv) < 4:
        print("usage: python s3cab-backup.py <bucket> <set> <dir>...", file=sys.stderr)
        return EXIT_STOPPED
    sys.setrecursionlimit(max(sys.getrecursionlimit(), 20000))
    backup = Backup(argv[1], argv[2], argv[3:])
    try:
        return backup.run()
    except Stop as e:
        print("stopped: %s" % e, file=sys.stderr)
        return EXIT_STOPPED
    except (ClientError, BotoCoreError) as e:
        print("stopped: the bucket request failed: %s" % e, file=sys.stderr)
        return EXIT_STOPPED
    except KeyboardInterrupt:
        print("stopped: interrupted", file=sys.stderr)
        return EXIT_STOPPED


if __name__ == "__main__":
    sys.exit(main(sys.argv))
