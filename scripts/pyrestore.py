#!/usr/bin/env python3
"""pyrestore — an independent s3cab restorer, written solely from guide/format.md.

Clean-room rules: the only s3cab source consulted was guide/format.md (the
format spec) — no src/, no other guides, no ADRs. Everywhere the spec forced a
guess, the code carries a `GUESS(n)` comment; the findings those guesses became
are recorded in docs/format-spec-audit.md (this script is its deliverable, kept
as the experiment behind it). Deliberately not maintained in step with s3cab:
its value is being an independent reading of the spec as written on 2026-08-12.

Given a bucket and a snapshot, reconstructs every file in the snapshot
byte-for-byte under an output root, restoring each file's recorded mtime.

Requires: Python >= 3.14 (stdlib `compression.zstd`), boto3.

Usage:
  pyrestore.py --bucket B [--profile P] [--region R] [--endpoint-url U] list-sets
  pyrestore.py --bucket B ... list-snapshots SET
  pyrestore.py --bucket B ... restore SET SNAPSHOT --output DIR [--manifest FILE]

The restore writes each snapshot row's file under DIR, mapping the original
absolute path like so (the spec is silent on restore-to-a-new-root mapping —
that is tool UX, not format — so this mapping is pyrestore's own):
  C:\\Users\\me\\f.txt          ->  DIR/C/Users/me/f.txt
  \\\\server\\share\\f.txt        ->  DIR/UNC/server/share/f.txt
  /home/me/f.txt              ->  DIR/home/me/f.txt

Exit codes: 0 = full restore (deliberately-deleted skips included, per the
spec: restore "skips them gracefully with their date"); 1 = integrity fault
(unexplained missing object, hash/size mismatch) or usage error.
"""

import argparse
import hashlib
import os
import re
import sys
import tempfile
from datetime import datetime, timedelta

try:
    from compression import zstd
except ImportError:  # the stdlib zstd module arrived in Python 3.14
    raise SystemExit("pyrestore.py needs Python >= 3.14 (stdlib compression.zstd)")


def winlong(path):
    """Extended-length form for Windows OS calls, so restored paths deeper
    than MAX_PATH (260) work. The spec records absolute paths; re-rooting
    them under an output directory routinely blows past 260 on Windows.
    A UNC path (--output on a network share) takes the \\\\?\\UNC\\ form."""
    if os.name == "nt" and not path.startswith("\\\\?\\"):
        path = os.path.abspath(path)
        if path.startswith("\\\\"):
            return "\\\\?\\UNC" + path[1:]
        return "\\\\?\\" + path
    return path


HASH_RE = re.compile(r"^[0-9a-f]{64}$")  # spec: lowercase-hex SHA-256
# spec: "ISO-8601 with milliseconds, UTC" and every example is .mmmZ.
# GUESS(4): exactly three fractional digits and a literal trailing Z.
MTIME_RE = re.compile(r"^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{3})Z$")

EPOCH = datetime(1970, 1, 1)


def mtime_ns(field):
    """Parse the snapshot mtime field to integer nanoseconds since the epoch."""
    m = MTIME_RE.match(field)
    if not m:
        raise ValueError(f"mtime not ISO-8601-with-milliseconds UTC: {field!r}")
    y, mo, d, h, mi, s, ms = map(int, m.groups())
    td = datetime(y, mo, d, h, mi, s) - EPOCH  # integer arithmetic, no float rounding
    return (td.days * 86400 + td.seconds) * 10**9 + ms * 10**6


def parse_snapshot(data):
    """Parse decompressed snapshot bytes into a list of file rows.

    Returns [(hash, size, mtime_ns, mtime_field, path), ...] in file order.
    """
    # GUESS(1): the TSV is UTF-8. The spec never names a text encoding, and
    # paths are "in the OS's native style" — which on Windows is natively
    # UTF-16. Decoded strictly so a wrong guess fails loudly instead of
    # silently mangling paths.
    text = data.decode("utf-8")

    # GUESS(2): rows are terminated by LF. The spec never states the newline
    # convention; if it were CRLF, the '\r' would land in the path field
    # (path is last on the line and taken verbatim). Detect and fail loudly.
    if "\r" in text:
        raise ValueError(
            "snapshot contains CR characters; the spec does not state the "
            "newline convention and pyrestore assumed LF"
        )

    rows = []
    seen_paths = {}
    for lineno, line in enumerate(text.split("\n"), 1):
        if line == "":  # the empty tail after a final newline (or blank line)
            continue
        fields = line.split("\t")
        # spec: "Lines whose first field starts with `#` are metadata"
        if fields[0].strip().startswith("#"):
            continue
        # spec: four tab-separated fields; padding is spaces, never tabs, and
        # a path can contain no tab — so exactly-four is well-defined.
        if len(fields) != 4:
            raise ValueError(f"line {lineno}: {len(fields)} fields, expected 4")
        # spec: "trim whitespace when parsing" — applied to the width-padded
        # leading fields only.
        # GUESS(3): the path (last field, not padded) is taken VERBATIM —
        # trimming it would corrupt a filename that legitimately begins or
        # ends with a space (legal on Linux/macOS).
        hash_, size, mtime_field, path = (
            fields[0].strip(),
            fields[1].strip(),
            fields[2].strip(),
            fields[3],
        )
        if not HASH_RE.match(hash_):
            raise ValueError(f"line {lineno}: bad hash field {hash_!r}")
        if not size.isdigit():
            raise ValueError(f"line {lineno}: bad size field {size!r}")
        if path in seen_paths:
            # GUESS(5): the spec never says a path appears at most once per
            # snapshot. Assumed it does; a duplicate is treated as an error.
            raise ValueError(
                f"line {lineno}: duplicate path {path!r} "
                f"(first seen line {seen_paths[path]})"
            )
        seen_paths[path] = lineno
        rows.append((hash_, int(size), mtime_ns(mtime_field), mtime_field, path))
    return rows


def map_path(original, out_root):
    """Map an original absolute path to a location under out_root (pyrestore's
    own scheme; the spec doesn't govern restore-to-a-new-root layout)."""
    if re.match(r"^[A-Za-z]:[\\/]", original):  # Windows drive path
        parts = [original[0]] + re.split(r"[\\/]+", original[3:])
    elif original.startswith("\\\\"):  # Windows UNC path
        parts = ["UNC"] + re.split(r"[\\/]+", original[2:])
    elif original.startswith("/"):  # POSIX path
        parts = re.split(r"/+", original[1:])
    else:
        raise ValueError(f"path is not absolute in a style I recognize: {original!r}")
    parts = [p for p in parts if p not in ("", ".")]
    if any(p == ".." for p in parts):
        raise ValueError(f"refusing path with '..' component: {original!r}")
    return os.path.join(out_root, *parts)


class Repository:
    """One S3 bucket, laid out per the spec's fixed convention."""

    def __init__(self, s3, bucket):
        self.s3 = s3
        self.bucket = bucket
        self._deletions = None  # hash -> (record timestamp-name, path), lazy

    def list_keys(self, prefix):
        paginator = self.s3.get_paginator("list_objects_v2")
        for page in paginator.paginate(Bucket=self.bucket, Prefix=prefix):
            for obj in page.get("Contents", []):
                yield obj["Key"]

    def list_sets(self):
        # spec: sets/<set>/ marks the set's existence
        paginator = self.s3.get_paginator("list_objects_v2")
        names = []
        for page in paginator.paginate(
            Bucket=self.bucket, Prefix="sets/", Delimiter="/"
        ):
            for cp in page.get("CommonPrefixes", []):
                names.append(cp["Prefix"][len("sets/") : -1])
        return names

    def list_snapshots(self, set_name):
        suffix = ".tsv.zst"
        prefix = f"snapshots/{set_name}/"
        return [
            key[len(prefix) : -len(suffix)]
            for key in self.list_keys(prefix)
            if key.endswith(suffix)
        ]

    def get_bytes(self, key):
        resp = self.s3.get_object(Bucket=self.bucket, Key=key)
        return resp["Body"].read()

    def read_snapshot(self, set_name, snapshot_name):
        key = f"snapshots/{set_name}/{snapshot_name}.tsv.zst"
        return parse_snapshot(zstd.decompress(self.get_bytes(key)))

    def deletions(self):
        """hash -> (record name, one referencing path), from deletions/*.tsv."""
        if self._deletions is None:
            self._deletions = {}
            for key in self.list_keys("deletions/"):
                if not key.endswith(".tsv"):
                    continue
                name = key[len("deletions/") : -len(".tsv")]
                # spec: plain uncompressed TSV; skip '#' lines; first field is
                # the hash, the rest of the line the path.
                # GUESS(1) again: UTF-8. GUESS(6): the hash field is trimmed
                # (the spec doesn't say whether deletion records are
                # width-padded like snapshots).
                for line in self.get_bytes(key).decode("utf-8").split("\n"):
                    if line == "" or line.lstrip().startswith("#"):
                        continue
                    hash_, _, path = line.partition("\t")
                    self._deletions[hash_.strip()] = (name, path)
        return self._deletions

    def download_object(self, hash_, dest, expected_size):
        """GET objects/<hash> to dest, verifying content hash and size.

        Returns a status string: 'restored', 'deleted:<record-name>',
        'missing', 'hash-mismatch:<actual>', or 'size-mismatch:<actual>'.
        """
        try:
            resp = self.s3.get_object(Bucket=self.bucket, Key=f"objects/{hash_}")
        except self.s3.exceptions.NoSuchKey:
            # spec: a missing referenced object is EXPECTED if a deletion
            # record lists its hash, an integrity fault if none does.
            record = self.deletions().get(hash_)
            return f"deleted:{record[0]}" if record else "missing"

        hasher = hashlib.sha256()
        size = 0
        os.makedirs(winlong(os.path.dirname(dest)), exist_ok=True)
        fd, tmp = tempfile.mkstemp(
            dir=winlong(os.path.dirname(dest)), prefix=".pyrestore-", suffix=".part"
        )
        try:
            with os.fdopen(fd, "wb") as out:
                for chunk in resp["Body"].iter_chunks(chunk_size=1 << 20):
                    hasher.update(chunk)
                    size += len(chunk)
                    out.write(chunk)
            actual = hasher.hexdigest()
            if actual != hash_:
                return f"hash-mismatch:{actual}"
            if size != expected_size:
                # content matched its hash, so the OBJECT is self-consistent;
                # the snapshot row's size field contradicts it.
                return f"size-mismatch:{size}"
            os.replace(tmp, winlong(dest))
            tmp = None
            return "restored"
        finally:
            if tmp is not None:
                os.unlink(tmp)


def cmd_restore(repo, args):
    rows = repo.read_snapshot(args.set, args.snapshot)
    out_root = os.path.abspath(args.output)
    os.makedirs(out_root, exist_ok=True)

    manifest = open(args.manifest, "w", encoding="utf-8", newline="\n") if args.manifest else None
    counts = {"restored": 0, "deleted": 0, "faults": 0}
    for hash_, size, ns, mtime_field, path in rows:
        dest = map_path(path, out_root)
        status = repo.download_object(hash_, dest, size)
        if status == "restored":
            os.utime(winlong(dest), ns=(ns, ns))
            counts["restored"] += 1
        elif status.startswith("deleted:"):
            # spec: restore "skips them gracefully with their date"
            print(
                f"skipped (content deliberately deleted, record "
                f"{status.split(':', 1)[1]}): {path}"
            )
            counts["deleted"] += 1
        else:
            print(f"INTEGRITY FAULT ({status}): {path} [{hash_}]", file=sys.stderr)
            counts["faults"] += 1
        if manifest:
            rel = os.path.relpath(dest, out_root) if status == "restored" else ""
            manifest.write(f"{hash_}\t{size}\t{mtime_field}\t{status}\t{path}\t{rel}\n")
    if manifest:
        manifest.close()

    print(
        f"{counts['restored']} restored, {counts['deleted']} skipped as "
        f"deliberately deleted, {counts['faults']} integrity faults"
    )
    return 1 if counts["faults"] else 0


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--bucket", required=True)
    ap.add_argument("--profile")
    ap.add_argument("--region")
    ap.add_argument("--endpoint-url")
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("list-sets")
    p = sub.add_parser("list-snapshots")
    p.add_argument("set")
    p = sub.add_parser("restore")
    p.add_argument("set")
    p.add_argument("snapshot")
    p.add_argument("--output", required=True)
    p.add_argument("--manifest")
    args = ap.parse_args()

    import boto3

    session = boto3.Session(profile_name=args.profile, region_name=args.region)
    s3 = session.client("s3", endpoint_url=args.endpoint_url)
    repo = Repository(s3, args.bucket)

    if args.cmd == "list-sets":
        print("\n".join(repo.list_sets()))
        return 0
    if args.cmd == "list-snapshots":
        print("\n".join(sorted(repo.list_snapshots(args.set))))
        return 0
    return cmd_restore(repo, args)


if __name__ == "__main__":
    sys.exit(main())
