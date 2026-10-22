#!/usr/bin/env python3
"""Back up a set of directories into an s3cab repository, written from the format spec alone.

    python s3cab-backup.py [--take-over] <bucket> <set> <dir>...

Walks the member directories, uploads every file's content to objects/<sha256> that the bucket
doesn't hold yet, then uploads the snapshot snapshots/<set>/<YYYY-MM-DDTHHMM>.tsv.gz that names
them, after checking snapshots/<set>.info still names this machine's claim.

The claim (the OWNER and CLAIMED this program wrote) is the only thing kept between runs, in
s3cab-backup.state/ beside this file. Nothing about file contents or hashes is kept.

Exit status: 0 snapshot written; 1 snapshot written with #error rows; 2 stopped without one.
Python 3.10 or later and boto3; nothing else.
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
import unicodedata
import zlib

import boto3
from botocore.config import Config
from botocore.exceptions import BotoCoreError, ClientError

SPEC_DATE = "2026-10-20"
CLIENT_NAME = "s3cab-backup-py"
CLIENT_VERSION = "1.0"
HEADING = ("@S3CAB", "FORMAT", "size", "time", "https://s3cab.plantegral.com/guide/format")

WINDOWS = os.name == "nt"
SEP = "\\" if WINDOWS else "/"
HERE = os.path.dirname(os.path.abspath(__file__))
STATE_DIR = os.path.join(HERE, "s3cab-backup.state")
STATE_FILE = os.path.join(STATE_DIR, "claims.json")

# Files up to PART_SIZE go up in one PUT, held in memory; larger ones as multipart, one part
# in memory at a time.
PART_SIZE = 8 * 1024 * 1024
READ_ATTEMPTS = 3

SET_NAME = re.compile(r"[a-z0-9-]+\Z")
OPEN_FLAGS = (os.O_RDONLY | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOFOLLOW", 0)
              | getattr(os, "O_NONBLOCK", 0))


class Stop(Exception):
    """The run stops without writing a snapshot."""


# ---------------------------------------------------------------------------------------------
# Small helpers: messages, names, times

def say(msg):
    print(msg, file=sys.stderr, flush=True)


def spell_out(text):
    """Tab, CR and LF as Unicode Control Pictures, for every field but a file row's path."""
    return text.replace("\t", "␉").replace("\r", "␍").replace("\n", "␊")


def with_fffd(name):
    """A name with U+FFFD for each part that doesn't decode, as the spec prescribes."""
    if WINDOWS:
        return name.encode("utf-8", "surrogatepass").decode("utf-8", "replace")
    return os.fsencode(name).decode("utf-8", "replace")


def show(path):
    """A path for a message to a person."""
    return spell_out(with_fffd(path))


def name_problem(name):
    if "\t" in name or "\r" in name or "\n" in name:
        return "holds a tab, CR or LF"
    try:
        name.encode("utf-8")
    except UnicodeEncodeError:
        return "has no UTF-8 form"
    return None


def describe(e):
    """An OSError as short text for an #error row or a message."""
    winerror = getattr(e, "winerror", None)
    code = errno.errorcode.get(e.errno, "") if e.errno else ""
    if winerror is not None:
        code = "winerror %d" % winerror
    text = e.strerror or str(e)
    return "%s: %s" % (code, text) if code else text


def not_found(e):
    """Nothing exists there: the test for a broken link and for an entry that vanished."""
    winerror = getattr(e, "winerror", None)
    if winerror is not None:
        return winerror in (2, 3)
    return e.errno in (errno.ENOENT, errno.ENOTDIR)


def broken_link(e):
    winerror = getattr(e, "winerror", None)
    if winerror is not None:
        return winerror in (2, 3, 1921)
    return e.errno in (errno.ENOENT, errno.ENOTDIR, errno.ELOOP)


def civil_from_days(days):
    """Proleptic Gregorian (year, month, day) for days since 1970-01-01, any sign."""
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


def instant(ms):
    """Milliseconds since the epoch as YYYY-MM-DDTHH:MM:SS.sssZ, or None if it can't be held."""
    days, in_day = divmod(ms, 86400000)
    year, month, day = civil_from_days(days)
    if not 0 <= year <= 9999:
        return None
    hours, rest = divmod(in_day, 3600000)
    minutes, rest = divmod(rest, 60000)
    seconds, millis = divmod(rest, 1000)
    return "%04d-%02d-%02dT%02d:%02d:%02d.%03dZ" % (year, month, day, hours, minutes, seconds,
                                                    millis)


def round_ns_to_ms(ns):
    """To the nearest millisecond, a tie to the later one."""
    return (ns + 500000) // 1000000


def readable_size(n):
    if n < 1000:
        return "%dB" % n
    for power, unit in enumerate(("kB", "MB", "GB", "TB", "PB"), 1):
        divisor = 1000 ** power
        tenths = (20 * n + divisor) // (2 * divisor)  # n / divisor to one place, half up
        if tenths < 10000 or unit == "PB":
            return "%d.%d%s" % (tenths // 10, tenths % 10, unit)


def duration(ms):
    s = (ms + 500) // 1000
    if s < 60:
        return "%ds" % s
    if s < 3600:
        return "%dm %02ds" % (s // 60, s % 60)
    return "%dh %02dm" % (s // 3600, (s % 3600) // 60)


def zone_name():
    """The best name for the local time zone; it is written for people."""
    tz = os.environ.get("TZ", "").lstrip(":")
    if tz:
        return tz
    if WINDOWS:
        try:
            import ctypes
            icu = ctypes.CDLL("icu.dll")
            buf = ctypes.create_unicode_buffer(128)
            status = ctypes.c_int(0)
            n = icu.ucal_getDefaultTimeZone(buf, 128, ctypes.byref(status))
            if status.value <= 0 and n > 0:
                return buf.value[:n]
        except Exception:
            pass
    else:
        try:
            real = os.path.realpath("/etc/localtime")
            if "/zoneinfo/" in real:
                return real.split("/zoneinfo/", 1)[1]
        except OSError:
            pass
        try:
            with open("/etc/timezone", encoding="utf-8") as f:
                name = f.read().strip()
                if name:
                    return name
        except OSError:
            pass
    return time.tzname[time.localtime().tm_isdst > 0]


def user_at_machine():
    try:
        user = getpass.getuser()
    except Exception:
        user = os.environ.get("USER") or os.environ.get("USERNAME") or "unknown"
    machine = socket.gethostname() or "unknown"
    return "%s@%s" % (user, machine)


def b64(digest):
    return base64.b64encode(digest).decode("ascii")


# ---------------------------------------------------------------------------------------------
# Paths

def to_fs(path):
    """The path to hand the OS. On Windows, through \\\\?\\ so a name is taken as written."""
    if not WINDOWS:
        return path
    if path.startswith("\\\\?\\"):
        return path
    if path.startswith("\\\\"):
        return "\\\\?\\UNC\\" + path[2:]
    return "\\\\?\\" + path


def from_fs(path):
    if WINDOWS:
        if path.startswith("\\\\?\\UNC\\"):
            return "\\\\" + path[8:]
        if path.startswith("\\\\?\\"):
            return path[4:]
    return path


def identity(fs_path):
    st = os.stat(fs_path)
    if st.st_ino == 0:
        return None
    return (st.st_dev, st.st_ino)


def on_disk_case(real):
    """Each name spelled as its parent's listing spells it (realpath keeps the case as typed
    on macOS and in a Linux directory that ignores case). Windows' realpath already does this."""
    if WINDOWS or real == "/":
        return real
    out = ""
    for part in real.split("/")[1:]:
        parent = out or "/"
        here = out + "/" + part
        try:
            names = os.listdir(parent)
        except OSError:
            out = here
            continue
        if part in names:
            out = here
            continue
        try:
            want = os.lstat(here)
        except OSError:
            out = here
            continue

        def same(n):
            try:
                st = os.lstat(out + "/" + n)
            except OSError:
                return False
            return (st.st_dev, st.st_ino) == (want.st_dev, want.st_ino)

        fold = unicodedata.normalize("NFC", part).casefold()
        likely = [n for n in names if unicodedata.normalize("NFC", n).casefold() == fold]
        found = [n for n in likely if same(n)] or [n for n in names if same(n)]
        out = out + "/" + (found[0] if len(found) == 1 else part)
    return out


def member_dir(arg):
    """A member directory's real path, as recorded in @SET DIR (ending in a separator)."""
    path = arg
    if WINDOWS:
        if not os.path.isabs(path):
            path = os.path.join(os.getcwd(), path)
        path = os.path.normpath(path)  # not abspath, which drops a trailing dot or space
        if not os.path.isabs(path):  # drive-relative, such as C:foo: only the drive via abspath
            drive, rest = os.path.splitdrive(path)
            path = os.path.normpath(os.path.join(os.path.abspath(drive), rest))
    elif not os.path.isabs(path):
        path = os.path.join(os.getcwd(), path)
    try:
        real = from_fs(os.path.realpath(to_fs(path), strict=True))
    except OSError as e:
        raise Stop("member directory %s can't be resolved: %s" % (show(arg), describe(e)))
    real = on_disk_case(real)
    if WINDOWS and len(real) >= 2 and real[1] == ":":
        real = real[0].upper() + real[1:]
    try:
        st = os.stat(to_fs(real))
    except OSError as e:
        raise Stop("member directory %s can't be checked: %s" % (show(real), describe(e)))
    if not stat.S_ISDIR(st.st_mode):
        raise Stop("member directory %s is not a directory" % show(real))
    problem = name_problem(real)
    if problem:
        raise Stop("member directory %s %s" % (show(real), problem))
    if not real.endswith(SEP):
        real += SEP
    return real


def segments(path):
    """(root, [names]) of an absolute path, splitting as the path's own style dictates."""
    m = re.match(r"([A-Za-z]:[\\/])|([\\/]{2}[^\\/]+[\\/][^\\/]+[\\/]?)", path)
    if m:
        root = m.group(0)
        rest = path[len(root):]
        return root, (re.split(r"[\\/]", rest) if rest else [])
    if path.startswith("/"):
        rest = path[1:]
        return "/", (rest.split("/") if rest else [])
    return None, None


def is_windows_path(path):
    return re.match(r"[A-Za-z]:[\\/]|[\\/]{2}", path) is not None


def dir_key(path):
    """A @SET DIR as (root, names) with its trailing separators ignored."""
    root, names = segments(path.rstrip("\\/") if len(path.rstrip("\\/")) > 2 else path)
    if is_windows_path(path):
        root = root.lower()
        names = [n.lower() for n in names]
    return root, names


def inside(dirs, path):
    """The longest @SET DIR the path lies strictly inside, by whole segments, or None."""
    root, names = segments(path)
    if root is None:
        return None
    win = is_windows_path(path)
    cmp_root = root.lower() if win else root
    cmp_names = [n.lower() for n in names] if win else names
    best = None
    for d in dirs:
        droot, dnames = dir_key(d)
        if droot.replace("/", "\\").rstrip("\\") != cmp_root.replace("/", "\\").rstrip("\\"):
            continue
        if len(cmp_names) > len(dnames) and cmp_names[:len(dnames)] == dnames:
            if best is None or len(dnames) > len(dir_key(best)[1]):
                best = d
    return best


# ---------------------------------------------------------------------------------------------
# Walking the member directories

class Walk:
    def __init__(self, dirs):
        self.dirs = dirs
        self.early = []  # (type, column 2, path): #error rows found while walking
        self.files = []  # paths of regular files, in walk order
        self.member_ids = {}
        for d in dirs:
            ident = identity(to_fs(d))
            if ident is not None:
                self.member_ids[ident] = d
        self.own_ids = set()
        if os.path.isdir(STATE_DIR):
            ident = identity(STATE_DIR)
            if ident is not None:
                self.own_ids.add(ident)

    def run(self):
        for d in self.dirs:
            self.walk(d)

    def listing(self, path, is_member):
        try:
            with os.scandir(to_fs(path)) as it:
                return list(it)
        except OSError as e:
            if not is_member and not_found(e):
                return None  # vanished between being listed and being checked
            raise Stop("directory %s can't be listed: %s" % (show(path), describe(e)))

    def walk(self, top):
        stack = [(top, self.listing(top, True) or [], 0)]
        while stack:
            path, entries, i = stack.pop()
            if i >= len(entries):
                continue
            stack.append((path, entries, i + 1))
            entry = entries[i]
            name = entry.name
            child = path + name
            problem = name_problem(name)
            if problem:
                raise Stop("%s %s; it can't be recorded, so nothing was backed up"
                           % (show(child), problem))
            try:
                link = entry.is_symlink() or self.is_junction(entry)
                is_dir = not link and entry.is_dir(follow_symlinks=False)
                is_file = not link and not is_dir and entry.is_file(follow_symlinks=False)
            except OSError as e:
                if not_found(e):
                    continue
                self.early.append(("#error", "type can't be determined: " + describe(e), child))
                continue
            if link:
                self.link(child)
            elif is_dir:
                try:
                    ident = identity(to_fs(child))
                except OSError as e:
                    if not_found(e):
                        continue
                    ident = None  # the listing below stops the run if it can't be read either
                if ident in self.own_ids:
                    continue  # this tool's own working folder: no row
                if ident in self.member_ids:
                    raise Stop("member directory %s turns up inside %s, so its files would be "
                               "recorded twice" % (show(self.member_ids[ident]), show(top)))
                sub = self.listing(child + SEP, False)
                if sub is not None:
                    stack.append((child + SEP, sub, 0))
            elif is_file:
                self.files.append(child)
            # a pipe, socket or device gets no row

    @staticmethod
    def is_junction(entry):
        f = getattr(entry, "is_junction", None)
        if f is not None:
            return f()
        if not WINDOWS:
            return False
        return getattr(os.lstat(entry.path), "st_reparse_tag", 0) == 0xA0000003

    def link(self, path):
        """A symbolic link or junction: never followed, never recorded; #error if it leads out."""
        fs = to_fs(path)
        try:
            st = os.stat(fs)
            target = from_fs(os.path.realpath(fs, strict=True))
        except OSError as e:
            if broken_link(e):
                return
            self.early.append(("#error", "link that can't be resolved: " + describe(e), path))
            return
        if stat.S_ISDIR(st.st_mode):
            kind, shown = "folder", path + SEP
        elif stat.S_ISREG(st.st_mode):
            kind, shown = "file", path
        else:
            return  # to a pipe, socket or device
        if self.leads_in(target):
            return
        self.early.append(("#error", "link to a %s outside the backup: %s"
                           % (kind, spell_out(with_fffd(target))), shown))

    def leads_in(self, target):
        """Is the resolved target a member directory or inside one? A target in this tool's
        own working folder counts as out. Decided by identity as well as by path, since a
        resolved path keeps a link's spelling of the case on a case-insensitive disk."""
        p = to_fs(target)
        while True:
            try:
                ident = identity(p)
            except OSError:
                ident = None
            if ident is not None and ident in self.own_ids:
                return False
            if ident is not None and ident in self.member_ids:
                return True
            if from_fs(p).rstrip("\\/") + SEP in self.dirs or from_fs(p) in self.dirs:
                return True
            parent = os.path.dirname(p)
            if parent == p:
                return False
            p = parent


# ---------------------------------------------------------------------------------------------
# Reading files

class Unreadable(Exception):
    pass


class Vanished(Exception):
    pass


def open_regular(path):
    try:
        fd = os.open(to_fs(path), OPEN_FLAGS)
    except OSError as e:
        if not_found(e):
            raise Vanished()
        if e.errno == errno.ELOOP:
            raise Unreadable("became a link after it was listed")
        raise Unreadable(describe(e))
    f = os.fdopen(fd, "rb")  # buffered: read(n) returns n bytes unless the file ends first
    st = os.fstat(f.fileno())
    if not stat.S_ISREG(st.st_mode):
        f.close()
        raise Unreadable("no longer a regular file")
    return f, st


def hash_file(path):
    """(sha256 hex, size, mtime ns) of a file, from one read during which it didn't change."""
    for _ in range(READ_ATTEMPTS):
        f, before = open_regular(path)
        try:
            h = hashlib.sha256()
            n = 0
            while True:
                chunk = f.read(1 << 20)
                if not chunk:
                    break
                h.update(chunk)
                n += len(chunk)
            after = os.fstat(f.fileno())
        except OSError as e:
            raise Unreadable(describe(e))
        finally:
            f.close()
        unchanged = (before.st_size, before.st_mtime_ns) == (after.st_size, after.st_mtime_ns)
        if unchanged and n == after.st_size:
            return h.hexdigest(), n, before.st_mtime_ns
    raise Unreadable("kept changing while being read")


# ---------------------------------------------------------------------------------------------
# The bucket

class Bucket:
    def __init__(self, name):
        self.name = name
        self.endpoint = os.environ.get("AWS_ENDPOINT_URL_S3") or os.environ.get("AWS_ENDPOINT_URL")
        region = os.environ.get("AWS_REGION") or os.environ.get("AWS_DEFAULT_REGION")
        config = Config(retries={"mode": "standard", "max_attempts": 5},
                        connect_timeout=30, read_timeout=300)
        self.s3 = boto3.session.Session().client("s3", region_name=region,
                                                 endpoint_url=self.endpoint, config=config)
        # boto3 before 1.35 has no IfNoneMatch / IfMatch parameters: add the headers by hand.
        self.conditions = {}
        for op in ("PutObject", "CompleteMultipartUpload"):
            self.s3.meta.events.register("before-call.s3." + op, self._add_conditions)
        self.stored = set()  # hashes this run has seen stored (not kept between runs)

    def _add_conditions(self, params, **kwargs):
        params["headers"].update(self.conditions)

    def _put(self, key, body, condition):
        """PUT exactly these bytes, refused by S3 unless they hash to the SHA-256 we send."""
        self.conditions = condition
        try:
            return self.s3.put_object(Bucket=self.name, Key=key, Body=body,
                                      ChecksumSHA256=b64(hashlib.sha256(body).digest()))
        finally:
            self.conditions = {}

    def create(self, key, body):
        """Create a key that must not exist. True if made, False if something is there."""
        try:
            self._put(key, body, {"If-None-Match": "*"})
            return True
        except ClientError as e:
            if status(e) == 412:
                return False
            raise

    def get(self, key):
        """(bytes, etag), or None for a 404."""
        try:
            r = self.s3.get_object(Bucket=self.name, Key=key)
        except ClientError as e:
            if status(e) == 404:
                return None
            raise
        return r["Body"].read(), r["ETag"]

    def exists(self, key):
        try:
            self.s3.head_object(Bucket=self.name, Key=key)
            return True
        except ClientError as e:
            if status(e) == 404:
                return False
            raise

    def any_under(self, prefix):
        r = self.s3.list_objects_v2(Bucket=self.name, Prefix=prefix, MaxKeys=1)
        return r.get("KeyCount", 0) > 0

    # objects ------------------------------------------------------------------------------

    def store(self, digest, size, path):
        """Make sure objects/<digest> holds the file's bytes. "new", "stored", or Stop."""
        if digest in self.stored:
            return "stored"
        key = "objects/" + digest
        if self.exists(key):
            self.stored.add(digest)
            return "stored"
        if size <= PART_SIZE:
            made = self._store_single(key, digest, path)
        else:
            made = self._store_multipart(key, digest, path)
        self.stored.add(digest)
        return "new" if made else "stored"

    def _changed(self, path):
        return Stop("%s changed after it was hashed; nothing was stored for it and no snapshot "
                    "was written — run the backup again" % show(path))

    def _store_single(self, key, digest, path):
        try:
            f, _ = open_regular(path)
        except (Vanished, Unreadable):
            raise self._changed(path)
        with f:
            body = f.read(PART_SIZE + 1)
        if hashlib.sha256(body).hexdigest() != digest:
            raise self._changed(path)
        self.conditions = {"If-None-Match": "*"}
        try:
            r = self.s3.put_object(Bucket=self.name, Key=key, Body=body,
                                   ChecksumSHA256=b64(bytes.fromhex(digest)))
        except ClientError as e:
            if status(e) == 412:
                return False  # already at its key: counts as stored
            if status(e) == 400:
                raise self._changed(path)
            raise
        finally:
            self.conditions = {}
        if r.get("ChecksumSHA256") not in (None, b64(bytes.fromhex(digest))):
            raise Stop("S3 reports a different checksum for %s" % key)
        return True

    def _store_multipart(self, key, digest, path):
        try:
            f, _ = open_regular(path)
        except (Vanished, Unreadable):
            raise self._changed(path)
        upload = self.s3.create_multipart_upload(Bucket=self.name, Key=key,
                                                 ChecksumAlgorithm="SHA256")["UploadId"]
        done = False
        try:
            whole = hashlib.sha256()
            parts = []
            with f:
                number = 1
                while True:
                    data = f.read(PART_SIZE)
                    if not data:
                        break
                    whole.update(data)
                    check = b64(hashlib.sha256(data).digest())
                    r = self.s3.upload_part(Bucket=self.name, Key=key, UploadId=upload,
                                            PartNumber=number, Body=data, ChecksumSHA256=check)
                    if r.get("ChecksumSHA256") not in (None, check):
                        raise Stop("S3 reports a different checksum for part %d of %s"
                                   % (number, key))
                    parts.append({"PartNumber": number, "ETag": r["ETag"],
                                  "ChecksumSHA256": check})
                    number += 1
            if whole.hexdigest() != digest:
                raise self._changed(path)
            self.conditions = {"If-None-Match": "*"}
            try:
                self.s3.complete_multipart_upload(Bucket=self.name, Key=key, UploadId=upload,
                                                  MultipartUpload={"Parts": parts})
                done = True
                return True
            except ClientError as e:
                if status(e) == 412:
                    return False
                raise
            finally:
                self.conditions = {}
        finally:
            if not done:
                try:
                    self.s3.abort_multipart_upload(Bucket=self.name, Key=key, UploadId=upload)
                except Exception:
                    pass


def status(e):
    return e.response.get("ResponseMetadata", {}).get("HTTPStatusCode")


# ---------------------------------------------------------------------------------------------
# Who holds the set

def load_claims():
    try:
        with open(STATE_FILE, encoding="utf-8") as f:
            return json.load(f)
    except FileNotFoundError:
        return {}


def save_claim(bucket, set_name, owner, claimed):
    claims = load_claims()
    claims.setdefault(bucket, {})[set_name] = {"OWNER": owner, "CLAIMED": claimed}
    os.makedirs(STATE_DIR, exist_ok=True)
    tmp = STATE_FILE + ".tmp"
    with open(tmp, "w", encoding="utf-8", newline="\n") as f:
        json.dump(claims, f, indent=1, sort_keys=True)
        f.write("\n")
    os.replace(tmp, STATE_FILE)


def parse_info(body):
    try:
        text = body.decode("utf-8")
    except UnicodeDecodeError as e:
        raise Stop("the set's .info isn't UTF-8 (%s), so its holder can't be checked" % e)
    if text.startswith("﻿"):
        text = text[1:]
    values = {}
    for line in text.split("\n"):
        if line.endswith("\r"):
            line = line[:-1]
        if "=" in line:
            key, value = line.split("=", 1)
            values.setdefault(key, []).append(value)
    return values


def info_body(owner, claimed, created):
    for v in (owner, claimed, created):
        if "\n" in v or "\r" in v:
            raise Stop("can't write %r into .info" % v)
    return ("OWNER=%s\nCLAIMED=%s\nCREATED=%s\n" % (owner, claimed, created)).encode("utf-8")


def holder_matches(values, kept):
    owner, claimed = values.get("OWNER", []), values.get("CLAIMED", [])
    return (kept is not None and len(owner) == 1 and len(claimed) == 1
            and owner[0] == kept["OWNER"] and claimed[0] == kept["CLAIMED"])


def describe_holder(values):
    return "%s (claimed %s)" % (",".join(values.get("OWNER", ["?"])),
                                ",".join(values.get("CLAIMED", ["?"])))


def hold(bucket, set_name, me, now, take_over):
    """Make sure this machine holds the set, claiming or taking it over as needed."""
    key = "snapshots/%s.info" % set_name
    kept = load_claims().get(bucket.name, {}).get(set_name)
    got = bucket.get(key)
    if got is not None:
        values = parse_info(got[0])
        if holder_matches(values, kept):
            return kept
        if not take_over:
            raise Stop("set %s is held by %s, not by this machine's claim; pass --take-over to "
                       "take it over" % (set_name, describe_holder(values)))
        created = values.get("CREATED", [now])
        if len(created) != 1:
            raise Stop("%s has %d CREATED lines" % (key, len(created)))
        body = info_body(me, now, created[0])
        save_claim(bucket.name, set_name, me, now)
        try:
            bucket._put(key, body, {"If-Match": got[1]})
        except ClientError as e:
            if status(e) == 412:
                raise Stop("%s changed while being taken over; nothing was taken" % key)
            raise
        say("took over set %s from %s" % (set_name, describe_holder(values)))
        return {"OWNER": me, "CLAIMED": now}
    existing = bucket.any_under("snapshots/%s/" % set_name)
    if existing and not take_over:
        raise Stop("set %s already has snapshots but no .info, so it can't be claimed as new; "
                   "pass --take-over to take it over" % set_name)
    body = info_body(me, now, now)
    save_claim(bucket.name, set_name, me, now)  # kept before the PUT, so never a claim we forgot
    if not bucket.create(key, body):
        again = bucket.get(key)
        if again is None or again[0] != body:
            raise Stop("set %s was claimed by someone else just now" % set_name)
    say("%s set %s as %s" % ("took over (it had no .info)" if existing else "claimed",
                             set_name, me))
    return {"OWNER": me, "CLAIMED": now}


# ---------------------------------------------------------------------------------------------
# The snapshot

def line(c1, c2="", c3="", c4="", c5=""):
    return "%s\t%s\t%s\t%s\t%s\n" % (c1, c2.ljust(64), c3.rjust(12), c4.ljust(24), c5)


# What a reader trims from a leading field: tab, VT, FF, CR, LF, Unicode spaces (Zs), U+2028,
# U+2029 and a BOM, but not U+0085.
TRIM = "".join(chr(c) for c in range(0x110000) if unicodedata.category(chr(c)) == "Zs") + \
    "\t\x0b\x0c\r\n  ﻿"


def leading(text):
    return spell_out(text).strip(TRIM)


def render(rows):
    """rows: (type, c2, c3, c4, c5). A file row's path is written as is; every other field has
    tab, CR and LF spelled out and the leading fields cleared of what a reader would trim."""
    out = []
    for c1, c2, c3, c4, c5 in rows:
        if c1 == "-":
            out.append(line(c1, c2, c3, c4, c5))
        else:
            out.append(line(c1, leading(c2), leading(c3), leading(c4), spell_out(c5)))
    out.append(".\n")
    return "".join(out).encode("utf-8")


def compress(raw):
    buf = io.BytesIO()
    with gzip.GzipFile(filename="", mode="wb", fileobj=buf, mtime=0) as gz:
        gz.write(raw)
    return buf.getvalue()


KNOWN_TYPES = {"@S3CAB", "@CLIENT", "@SET", "@SNAPSHOT", "-", "#excluded", "#error"}
HASH = re.compile(r"[0-9a-f]{64}\Z")
SIZE = re.compile(r"[0-9]+\Z")
TIME = re.compile(r"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z\Z")


def check_snapshot(gz, raw):
    """Read the snapshot back as a strict reader would, and refuse to upload anything a reader
    would refuse, whole or one path at a time."""
    d = zlib.decompressobj(wbits=31)
    text = d.decompress(gz) + d.flush()
    if not d.eof or d.unused_data or text != raw:
        raise Stop("internal error: the gzip stream doesn't hold the snapshot")
    if text.startswith(b"\xef\xbb\xbf") or not text.endswith(b"\n.\n"):
        raise Stop("internal error: snapshot framing")
    text.decode("utf-8")  # strict
    lines = text.split(b"\n")[:-1]
    if lines[-1] != b"." or b"." in lines[:-1]:
        raise Stop("internal error: the . must be the last line, once")
    problems = []
    rows = []
    for raw_line in lines[:-1]:
        fields = raw_line.decode("utf-8").split("\t")
        if len(fields) != 5:
            problems.append("a line without five fields: %r" % raw_line[:80])
            continue
        trimmed = [f.strip(TRIM) for f in fields[:4]] + [fields[4]]
        if line(*trimmed).encode("utf-8") != raw_line + b"\n":
            problems.append("a line not in canonical form: %r" % raw_line[:80])
        rows.append(trimmed)
    if tuple(rows[0]) != HEADING:
        problems.append("first line isn't the heading row")
    dirs = [r[4] for r in rows if r[0] == "@SET" and r[1] == "DIR"]
    for prop in (("@S3CAB", "SPEC"), ("@CLIENT", "NAME"), ("@CLIENT", "VERSION")):
        if sum(1 for r in rows if (r[0], r[1]) == prop) != 1:
            problems.append("not exactly one %s %s" % prop)
    seen = set()
    file_paths = []
    count = total = 0
    for r in rows[1:]:
        kind = r[0]
        if kind not in KNOWN_TYPES:
            problems.append("unknown type %r" % kind)
        if kind in ("-", "#excluded", "#error"):
            path = r[4]
            if kind == "-":
                if not (HASH.match(r[1]) and SIZE.match(r[2]) and TIME.match(r[3])):
                    problems.append("malformed file row for %s" % show(path))
                count += 1
                total += int(r[2])
                file_paths.append(path)
                bare = path
            else:
                bare = path[:-1] if path.endswith(("/", "\\")) and len(path) > 1 else path
            if any(c in path for c in "\t\r\n"):
                problems.append("tab, CR or LF in %s" % show(path))
            root, names = segments(bare)
            if root is None or any(n in ("", ".", "..") for n in names):
                problems.append("not a valid absolute path: %s" % show(path))
            if inside(dirs, bare) is None:
                problems.append("not strictly inside a @SET DIR: %s" % show(path))
            if path in seen or bare in seen:
                problems.append("path in two rows: %s" % show(path))
            seen.add(path)
            seen.add(bare)
    as_folders = set()
    for p in file_paths:
        root, names = segments(p)
        if names:
            for i in range(1, len(names)):
                as_folders.add((root, tuple(names[:i])))
    for p in file_paths:
        root, names = segments(p)
        if (root, tuple(names)) in as_folders:
            problems.append("file path runs through another as a folder: %s" % show(p))
    props = {(r[0], r[1]): r for r in rows}
    if props[("@SNAPSHOT", "FILES")][4] != str(count):
        problems.append("FILES disagrees with the file rows")
    if props[("@SNAPSHOT", "SIZE")][4] != "%d (%s)" % (total, readable_size(total)):
        problems.append("SIZE disagrees with the size column")
    if rows[-1][:2] != ["@SNAPSHOT", "FINISH"]:
        problems.append("@SNAPSHOT FINISH isn't the line before the .")
    if problems:
        raise Stop("the snapshot failed its own check, so it wasn't uploaded:\n  "
                   + "\n  ".join(problems[:20]))


# ---------------------------------------------------------------------------------------------

def backup(bucket_name, set_name, args, take_over):
    started_ns = time.time_ns()  # one clock reading: START, and the snapshot's name
    start_ms = started_ns // 1000000
    name = time.strftime("%Y-%m-%dT%H%M", time.localtime(started_ns // 1000000000))
    zone = zone_name()
    me = user_at_machine()

    if not SET_NAME.match(set_name):
        raise Stop("a set's name is lowercase letters, digits and hyphens: %r" % set_name)
    dirs = []
    for arg in args:
        d = member_dir(arg)
        for other in dirs:
            if d == other or inside([other], d.rstrip(SEP)) or inside([d], other.rstrip(SEP)):
                raise Stop("member directories %s and %s overlap, so a file would turn up under "
                           "both" % (show(other), show(d)))
        dirs.append(d)

    bucket = Bucket(bucket_name)
    held = hold(bucket, set_name, me, instant(start_ms), take_over)
    snapshot_key = "snapshots/%s/%s.tsv.gz" % (set_name, name)
    if bucket.exists(snapshot_key):
        raise Stop("set %s already has a snapshot for %s; a second one in the same minute is "
                   "refused" % (set_name, name))
    later = bucket.s3.list_objects_v2(Bucket=bucket_name, Prefix="snapshots/%s/" % set_name,
                                      StartAfter=snapshot_key, MaxKeys=1).get("Contents")
    if later:
        say("warning: %s sorts after this snapshot's name %s (the clock went back?), so a reader "
            "taking the last name as the latest won't pick this one" % (later[0]["Key"], name))

    walk = Walk(dirs)
    walk.run()
    say("walked %d member director%s: %d files, %d early #error rows"
        % (len(dirs), "y" if len(dirs) == 1 else "ies", len(walk.files), len(walk.early)))

    file_rows = []
    count = total = new = 0
    errors = len(walk.early)
    for path in walk.files:
        try:
            digest, size, mtime_ns = hash_file(path)
        except Vanished:
            continue
        except Unreadable as e:
            file_rows.append(("#error", str(e), "", "", path))
            errors += 1
            continue
        when = instant(round_ns_to_ms(mtime_ns))
        if when is None:
            file_rows.append(("#error", "modification time can't be written (%d ns since 1970)"
                              % mtime_ns, "", "", path))
            errors += 1
            continue
        if bucket.store(digest, size, path) == "new":
            new += 1
        file_rows.append(("-", digest, str(size), when, path))
        count += 1
        total += size
    say("objects: %d uploaded, %d already stored" % (new, count - new))

    rows = [HEADING,
            ("@S3CAB", "SPEC", "", "", SPEC_DATE),
            ("@CLIENT", "NAME", "", "", CLIENT_NAME),
            ("@CLIENT", "VERSION", "", "", CLIENT_VERSION),
            ("@SET", "NAME", "", "", set_name),
            ("@SET", "BUCKET", "", "", "s3://" + bucket_name)]
    if bucket.endpoint:
        rows.append(("@SET", "ENDPOINT", "", "", bucket.endpoint))
    rows += [("@SET", "DIR", "", "", d) for d in dirs]
    rows += [("@SNAPSHOT", "NAME", "", "", name),
             ("@SNAPSHOT", "BY", "", "", me),
             ("@SNAPSHOT", "START", "", instant(start_ms), zone)]
    rows += [(t, c2, "", "", p) for t, c2, p in walk.early]
    rows += file_rows
    rows += [("@SNAPSHOT", "FILES", "", "", str(count)),
             ("@SNAPSHOT", "SIZE", "", "", "%d (%s)" % (total, readable_size(total)))]
    finish_ms = -(-time.time_ns() // 1000000)  # rounded up
    rows.append(("@SNAPSHOT", "FINISH", "", instant(finish_ms), duration(finish_ms - start_ms)))
    raw = render(rows)
    gz = compress(raw)
    check_snapshot(gz, raw)

    # Immediately before the upload: does the .info still name our claim?
    got = bucket.get("snapshots/%s.info" % set_name)
    if got is None or not holder_matches(parse_info(got[0]), held):
        raise Stop("set %s is no longer held by this machine (%s); the snapshot wasn't uploaded"
                   % (set_name, describe_holder(parse_info(got[0])) if got else "no .info"))
    if not bucket.create(snapshot_key, gz):
        there = bucket.get(snapshot_key)
        if there is None or there[0] != gz:
            raise Stop("%s already exists with other bytes; a second snapshot in the same "
                       "minute is refused" % snapshot_key)
    there = bucket.get(snapshot_key)
    if there is None or there[0] != gz:
        say("WARNING: %s doesn't read back as the bytes uploaded" % snapshot_key)
        return 2
    say("uploaded %s: %d files, %s, %d #error row%s"
        % (snapshot_key, count, readable_size(total), errors, "" if errors == 1 else "s"))
    return 1 if errors else 0


def main(argv):
    if sys.version_info < (3, 10):
        say("needs Python 3.10 or later, for os.path.realpath(strict=True)")
        return 2
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="backslashreplace")
        except (AttributeError, ValueError):
            pass
    args = list(argv)
    take_over = False
    while args and args[0].startswith("--"):
        flag = args.pop(0)
        if flag == "--":
            break
        if flag == "--take-over":
            take_over = True
        else:
            say("unknown option %s" % flag)
            return 2
    if len(args) < 3:
        say(__doc__.strip().split("\n\n")[1])
        return 2
    bucket_name = args[0][5:] if args[0].startswith("s3://") else args[0]
    bucket_name = bucket_name.rstrip("/")
    try:
        return backup(bucket_name, args[1], args[2:], take_over)
    except Stop as e:
        say("stopped, no snapshot written: %s" % e)
        return 2
    except (ClientError, BotoCoreError) as e:
        say("stopped, no snapshot written: %s" % e)
        return 2
    except KeyboardInterrupt:
        say("interrupted, no snapshot written")
        return 130


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
