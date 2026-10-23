# The format-spec clean-room audit, run 4: backup on Linux, Opus 5.5 at xhigh (2026-10-22)

One of the six runs of a real set: each role on each platform, run in CI on Claude Opus 5.5
at `xhigh`, all reading the spec as of [PR #439](https://github.com/allens/s3cab/pull/439)
(2026-10-20). The set is runs 4–9: backups on Linux (this run), [macOS](format-spec-audit-5.md) and
[Windows](format-spec-audit-6.md); restores on [Linux](format-spec-audit-7.md),
[macOS](format-spec-audit-8.md) and [Windows](format-spec-audit-9.md).

- **Program:**
  [`s3cab-backup.py`](https://github.com/allens/s3cab/blob/a2cb93351d5e293123a9fac096d42409ef3749ce/scripts/cleanroom/backup/linux/s3cab-backup.py),
  Python with boto3. Its notes, logs and test tools stay with the run, outside the repo.
- **Checker:** matches.
- **Audit:** nothing outside the sandbox was flagged.
- **Tokens:** input 158, cache write 253,787, cache read 13,242,330, output 168,841.

Everything below the rule is the session's own report, verbatim.

---

# Clean-room backup for the s3cab format: report

Everything here comes from `format.md` (the spec of 2026-10-20) and from requests to the real bucket
`s3://test-s3cab-ci-cleanroom-backup`. I read no other material about the format or the tool.
`WORKLOG.md` holds the guesses in the order I made them, each written down before I tested it.

## What was built

- **`s3cab-backup.py`**: the backup, `python s3cab-backup.py [--take-over] <bucket> <set> <dir>...`.
  It needs Python ≥ 3.10 and boto3, and nothing else. It resolves the member directories to real
  paths and claims the set (or checks that it still holds it). Then it walks the directories,
  hashes each file and uploads every object the bucket lacks. Last, it builds the snapshot,
  checks it the way a strict reader would, re-checks the holder, and uploads the snapshot. The only
  state it keeps between runs is the `OWNER`/`CLAIMED` pair it wrote, in
  `s3cab-backup.state/claims.json` beside the program. It caches nothing about file contents or
  hashes, and every object's presence is checked with a fresh `HEAD` on every run.
- **`s3cab-verify.py`**: a separate reader, written from the *Reading* checklist and sharing no
  code with the backup. It checks every key in the bucket and can restore every set.
- **`final-runs.log`**: output of the final runs, one per set, using exactly the command line
  the task gives.

### How each object is made sure to be the bytes its key names

Each file is read once to hash it, with `fstat` before and after the read. A file that changes
during the read is retried and in the end gets an `#error` row; this path was never exercised.
The key is then `HEAD`ed. If the
object is missing, the file is read again for the upload:

- **Up to 8 MiB:** the bytes are held in memory and hashed. They must equal the key, or the run
  stops. Those same bytes are sent with `x-amz-checksum-sha256` set to **the key's** digest and
  `If-None-Match: *`. S3 therefore refuses any byte that differs from the key, and stores nothing.
- **Larger files:** multipart, 8 MiB parts, each part sent with its own SHA-256. The whole file
  is hashed from the same bytes, and `CompleteMultipartUpload` (also `If-None-Match: *`) is sent
  only if that hash equals the key. Otherwise the upload is aborted.

The snapshot is uploaded only after every object it names is confirmed. It is read back after
the upload and compared byte for byte.

## Results, all from real requests

These runs and checks were done before the final pass; the final pass is reported further down.

- **Cross-check against independent tools:** every file row matched GNU `find` + `stat` +
  `sha256sum` exactly on hash, size and rounded mtime. Before the final pass this covered every
  set except `bulk`, which was checked by restore + `cmp` instead; the final pass covers `bulk`
  too. The one file without a row is `edge/unreadable/locked.txt` (mode 000), which `sha256sum`
  can't read either and which has an `#error` row.
- **`s3cab-verify.py` over the network:**
  - every object was downloaded and hashed to its key;
  - every snapshot was valid and canonical;
  - every `.info` matched the kept claim;
  - no object or snapshot had `Content-Encoding` or `x-amz-meta-*`;
  - no orphans: **0 problems**.
- **Restore:** every set was restored from the bucket. `cmp` and `stat` against the sources show
  identical bytes and mtimes within 0.5 ms for every readable file. `hollow` leaves no folder.
- **Determinism:** a second snapshot of an unchanged `edge` differed from the first only in
  `@SNAPSHOT NAME`, `START` and `FINISH`, as the spec says it should.
- **Time zone:** under `TZ=Europe/London` the name was `2026-10-22T0917` (BST),
  `START 2026-10-22T08:17:10.961Z`, and the zone was written as `Europe/London`.
- **Negative tests on the bucket** (throwaway `zz-*` sets):
  - A file changed between hashing and upload (single PUT and 9 MiB multipart): the run stops,
    nothing is stored under the old key, no snapshot is written, and no multipart upload is left
    open.
  - A second snapshot in the same minute is refused, both by the early check and by
    `If-None-Match` alone.
  - A holder change between claim and publish is refused.
  - `--take-over` keeps `CREATED`. On a set with snapshots but no `.info`, it creates one with
    `CREATED` = `CLAIMED`.
  - S3 enforced the hand-added `If-None-Match` and `If-Match` headers, returning 412.
- **Offline:** an edge-case tree gave the right result for:
  - links that get no row: loops, `ENOTDIR` links, links to a FIFO, links to a member itself,
    chains of links, and links to a second member;
  - a link that leads out through a chain: `#error`;
  - runs that stop: nested, duplicate, missing or non-directory member directories, an
    unlistable subdirectory, and a CR in a name.

  The calendar and rounding code agrees with `datetime` on 200,000 random instants. `SIZE`
  matches the spec's examples (999,949 B is `999.9kB`; 999,950 B is `1.0MB`).

Not tested: Windows and macOS (no machine), sockets (the sandbox forbids creating them),
mtimes past 9999 (ext4 can't hold them; only the formatter was tested), and case-insensitive
directories.

### The bucket as left by the final runs

I emptied the bucket (1,325 keys; versioning is off; no multipart uploads open) and reset the
local claim state. I then ran `python s3cab-backup.py test-s3cab-ci-cleanroom-backup <set>
<dir>...` once per set, in `ENVIRONMENT.md` order (`final-runs.log`):

| Set | Result | Exit |
| --- | --- | --- |
| `edge` | `snapshots/edge/2026-10-22T0820.tsv.gz`: 61 files, 1.1MB, 3 `#error` rows (two links leading out, one mode-000 file) | 1 |
| `docs` | `…/docs/2026-10-22T0821.tsv.gz`: 120 files, 37.9kB | 0 |
| `bulk` | `…/bulk/2026-10-22T0821.tsv.gz`: 1,100 files, 20.9kB | 0 |
| `media` | `…/media/2026-10-22T0825.tsv.gz`: 2 files, 42.5MB (the 40 MiB file went up as 5 parts) | 0 |
| `hollow` | `…/hollow/2026-10-22T0825.tsv.gz`: 0 files (legal: an empty set) | 0 |
| `spread` | `…/spread/2026-10-22T0825.tsv.gz`: 13 files, 2 `@SET DIR` rows | 0 |
| `faults` | `…/faults/2026-10-22T0825.tsv.gz`: 3 files | 0 |
| `corrupt` | `…/corrupt/2026-10-22T0825.tsv.gz`: 3 files | 0 |
| `scans` | **stopped, no snapshot**: `scan-\xff.txt` has no UTF-8 form (l. 264-266, 896) | 2 |
| `ledger` | **stopped, no snapshot**: `q1<TAB>2026.txt` holds a tab (l. 255-262, 895) | 2 |

The bucket holds 1,314 keys:

- 1,296 objects;
- 8 snapshots;
- 10 `snapshots/<set>.info`, one per set.

`scans` and `ledger` have a `.info` and no snapshot because the claim comes first and the run
then stopped. The spec names this state: "a `.info` with no snapshots is a set … whose first
backup stopped" (l. 155-156). These two sets can't be backed up with this command line: the spec
says such a name stops the run unless the tool can leave it out, and leaving entries out would
need an option the fixed command line doesn't pass.

Verification of the final state, using only real requests:

- `s3cab-verify.py --claims --restore`: **0 problems** (every object downloaded and hashed to
  its key; every snapshot valid and canonical; every `.info` matches the kept claim; every object
  older than its snapshot; no orphans).
- The `find`/`stat`/`sha256sum` cross-check: 1,302 of 1,302 file rows identical in all eight
  snapshots.
- The restore compared with `cmp` and `stat`: every readable file identical in bytes and in mtime
  to the millisecond. The only file not restored is `edge/unreadable/locked.txt`, whose source
  can't be read and which has its `#error` row.

The lifecycle rule (see Environment notes) will expire all of this about a day after
2026-10-22T08:25Z.

An excerpt of the final `edge` snapshot. For display only, ⇥ stands for a tab, runs of padding
are shortened to `·`, and one hash is shortened with `…`:

```
@S3CAB ⇥ FORMAT·⇥·size ⇥ time·⇥ https://s3cab.plantegral.com/guide/format
@SNAPSHOT ⇥ START·⇥·⇥ 2026-10-22T08:20:48.784Z ⇥ Etc/UTC
#error ⇥ link to a file outside the backup: /srv/s3cab.sandbox/fixtures/outside/beyond.txt ⇥·⇥·⇥ /srv/s3cab.sandbox/fixtures/edge/link-out-file
#error ⇥ link to a folder outside the backup: /srv/s3cab.sandbox/fixtures/outside ⇥·⇥·⇥ /srv/s3cab.sandbox/fixtures/edge/link-out-dir/
- ⇥ e4db69f3…a48d08d ⇥·23 ⇥ 2026-10-22T07:47:04.356Z ⇥ /srv/s3cab.sandbox/fixtures/edge/trailing.txt 
@SNAPSHOT ⇥ SIZE·⇥·⇥·⇥ 1051001 (1.1MB)
@SNAPSHOT ⇥ FINISH·⇥·⇥ 2026-10-22T08:21:01.683Z ⇥ 13s
.
```

---

## Would leave a backup that can't be restored correctly

Ranked, worst first. Each is a rule that is missing or unclear. A plausible reading of it gives a
snapshot that restores wrong bytes, or nothing, while reporting success.

1. **Which SHA-256 to send as `x-amz-checksum-sha256`.** Rule: an object holds "exactly the bytes
   that hash to its key… If they don't match, leave nothing stored under that key" (l. 962-965).
   The spec admits a plain PUT can't meet that (l. 996-997). Its only working mechanism is a
   hint: "S3 checks them itself when you send `x-amz-checksum-sha256`" (l. 998). The hint never
   says that the digest has to be **the key's**. The natural boto3 call,
   `ChecksumAlgorithm="SHA256"`, computes the digest from the bytes being sent, so S3 checks only
   the transport. Tested on the bucket, in my own client folder:
   - wrong body + the key's digest → `BadDigest`, nothing stored;
   - wrong body + `ChecksumAlgorithm="SHA256"` → **stored**.

   So a file edited between hashing and upload lands under the old key. A reader that checks
   hashes withholds that file forever; one that doesn't restores the wrong content. *I guessed:*
   send the key's digest, and also compare the hash of the in-memory body with the key before
   sending.

2. **"Don't trust an older snapshot's word that content is stored" is not in any checklist.**
   Line 28 says every rule is in one of the checklists. This one appears only in passing, in the
   deletion-record section (l. 246-247). The Uploading checklist says only "Count an object
   already at its key as stored" (l. 966). Picture a writer that skips the `HEAD` for hashes its
   previous snapshot named, as any incremental tool would. After a `delete`, that writer
   publishes a snapshot naming an object that is gone. The deletion record then makes a reader
   treat the absence as deliberate, and the restore skips a file that was on disk at backup time,
   **with exit 0**. *I avoided it* by checking every object with a fresh `HEAD` on every run.
   This comes from reading the spec; I wrote no caching writer to show it.

3. **A member directory that doesn't exist or isn't a directory.** The spec only says "a
   directory that can't be listed stops the backup" (l. 522, 897) and never says a member
   directory must exist. In Python, `os.walk` of a missing top, or of a file, yields nothing and
   raises no error (verified). A writer built on it writes a valid, empty snapshot for a typo'd
   path, and exits 0. *I guessed:* stop.

4. **Member directories that are the same directory.** The stop rule says "the same file turns
   up under two member directories, *because one is inside the other*" (l. 898). Two equal
   directories aren't inside one another. That covers two spellings, one through a symlink,
   both resolving to the same real path, and a bind mount of one inside another. A writer that
   checks only strict nesting walks the tree twice and writes every path in two file rows. By
   the spec's own reader rule, both rows are then refused (l. 702-705), so *nothing* restores.
   *I guessed:* equal real paths count as overlap and stop the run, and so does a member
   directory met by identity (`st_dev`, `st_ino`) inside another's walk. Offline test D stops.

5. **How to decide that a link leads "into the backup".** The rule is that the resolved target
   "is a member directory or lies inside one" (l. 437-438), but no comparison is defined. The
   trap the spec gives for member directories also hits link targets: on macOS and in
   case-insensitive Linux directories, `realpath` keeps the case as the link typed it
   (l. 564-566). The only case rule given is the reader's case-insensitive match for Windows
   paths (l. 569-575), and a writer that borrows it misjudges a case-sensitive directory holding
   both `Photos` and `photos`. If a link that leads *out* is judged *in*, it gets no row and its
   target is recorded nowhere: content silently missing, exit 0. The opposite mistake only gives
   a spurious `#error`. *I chose:* the target or one of its ancestors has the same
   (`st_dev`, `st_ino`) as a member directory, or exactly the same path. Untested: there is no
   case-insensitive filesystem here.

## Would inconvenience the implementer

Ranked, worst first. Each needed a guess, but none of the readings I considered breaks a
restore.

1. **Which names with a tab, CR or LF stop the run.** The checklist stops the run when "a name
   holds a tab, CR or LF" (l. 895). "No row holds a tab…" refuses only "a file row's path" and
   spells out everything else, explicitly including "the path in … an `#error` row" (l. 529-535).
   The two disagree on an unreadable file, a link leading out, and entries that get no row (a
   FIFO, a broken link, a link in, an empty directory). The same question arises for names with
   no UTF-8 form (l. 264-269 vs 896). *I guessed:* any such name the walk meets stops the run,
   and tab/CR/LF are spelled out in every other field, such as a link target in a message. Both
   readings give the same outcome for `ledger` and `scans` (each name is a regular file).
2. **A trailing separator contradicts the validity rules.** The writer must end a directory's
   path with a separator (l. 407-413, 891). The validity list says every segment past the root
   is a name, "so no trailing … separator" (l. 682-683). Only `@SET DIR` is told to ignore its
   trailing separator (l. 579). A validator that applies the list literally calls `edge`'s
   `#error … /srv/…/edge/link-out-dir/` invalid. *I guessed:* drop one trailing separator from a
   `#` row's path before checking its segments.
3. **There is no literal canonical line.** Both examples say they are not literal (l. 217-218,
   320-321). The canonical heading (`size` right-aligned in 12), and the fact that padding sits
   inside the field before its tab, had to be derived from l. 364-371. One `cat -A`-style
   example would settle it. *I guessed* as above; my self-check re-renders each parsed row and
   compares the bytes.
4. **A file that changes *during* the hashing read.** The spec covers a change after the row was
   recorded (l. 963), not one during the read. It also doesn't say whether the size column is
   `st_size` or the number of bytes hashed. *I guessed:* the bytes hashed. I retry when
   `fstat` before and after differ, and after three tries write an `#error`.
5. **Times outside 0000-9999.** Only "a year past 9999" is named as unholdable (l. 886-887). A
   year before 0000 (possible on btrfs and ZFS) isn't mentioned, and nothing says whether year
   0000 is acceptable. *I guessed:* the form holds 0000-9999, judged after rounding to the
   millisecond, and anything outside it is an `#error`.
6. **`.info` corner cases.**
   - a repeated `OWNER` or `CLAIMED` (*guess:* refuse to publish);
   - a BOM (the snapshot rule forgives one, the `.info` rule is silent; *guess:* forgive it);
   - a takeover of a `.info` with no `CREATED` line, when the rule is "keeps `CREATED`"
     (*guess:* write the takeover instant);
   - whether `CLAIMED` is rounded or cut to the millisecond (*guess:* cut, like `START`);
   - what "user" and "machine" mean in `user@machine` (*guess:* `getpass.getuser()` and
     `socket.gethostname()`).

   None of these matters to a restore, and the pair is compared as text.
7. **The root of a share path.** The validity rule calls the root "a share's `\\`" (l. 682), so
   `server` and `share` would be segments. The restore rules treat the share as having a name of
   its own (l. 606). *I guessed:* `\\server\share\` is the root.
8. **Does a deliberate `delete` count as "clean up" for "don't clean up while a backup is
   running" (l. 122, 1028)?** If it doesn't, a `delete` that runs between a backup's `HEAD` and
   its publish produces a snapshot naming content already gone. Readers then skip that content
   as deliberately deleted.
9. **When "the run started".** I take it to be the first clock reading, before the directories
   are resolved and the set is claimed. A new claim's `CLAIMED` reuses that reading.

What I wanted beyond `format.md`: nothing in order to write. Whether a set holding a tab-named
or non-UTF-8 file can be backed up at all depends on the tool offering a way to leave entries
out (l. 260-262, 900-901). s3cab's own answer is in `exclude.md`, which I didn't have and didn't
need. With the fixed command line, my program offers no way to leave entries out, so `ledger`
and `scans` stop, as the spec says they should.

## Hints that would have helped

Each one was verified here unless marked otherwise.

- **Send the key's digest, not boto3's.** `ChecksumAlgorithm="SHA256"` hashes the body being
  sent and so can't catch a file that changed since it was hashed. Pass
  `ChecksumSHA256=base64(bytes.fromhex(key))` instead. This is the trap behind gap 1.
- **`os.walk` hides errors.** With the default `onerror=None` it silently skips a subdirectory it
  can't list (verified: a mode-000 directory and its file simply vanish from the walk). It also
  yields nothing for a missing or non-directory top. The spec warns about `os.walk` only for
  junctions (l. 926-928), yet its own rule is to stop when a directory can't be listed.
- **Opening a FIFO blocks.** `open(fifo, "rb")` hung until it was killed (`timeout` exit 124). A
  writer that opens whatever it listed hangs on `edge/pipe`, or on a file swapped for a FIFO
  after listing. Check the type before opening, and open with `O_NONBLOCK` (and `O_NOFOLLOW`).
- **Time arithmetic.** Python's `datetime` overflows outside years 1-9999 (verified), so a
  writer using it crashes rather than writing the `#error` row the spec asks for. Integer
  day-count arithmetic covers the whole form.
- **GNU `find -printf %T@` misprints times before 1970.** For `edge/mtime-1969.txt` (−86400.25 s)
  it prints `-86401.7500000000`, while `stat --printf %.9Y` and Python's `st_mtime_ns` are right.
  A check of the rows done with `find` flags a correct `1969-12-30T23:59:59.750Z`.
- **Looking a name up in its parent's listing on macOS** (untested). `casefold()` alone can't
  match a typed NFC name to an NFD name on disk. Matching listing entries by
  (`st_dev`, `st_ino`) handles case and normalization at once, and it is how I decide "into the
  backup" too.
- **Version floors** (documentation, not run). `realpath(strict=True)` needs Python 3.10, and
  `DirEntry.is_junction()` 3.12; before that, check `st_reparse_tag == 0xA0000003` from `lstat`.

## Portability: what the spec asks that stdlib + boto3 can't do everywhere

- **`START`'s zone as an IANA name.** The standard library can't name the local zone. On Linux
  and macOS I read the `/etc/localtime` symlink. On Windows I call `icu.dll`'s
  `ucal_getDefaultTimeZone` through `ctypes` (Windows 10 1903 and later), as the spec's hint
  suggests; otherwise Windows falls back to `time.tzname`, which gives Windows' own names. The
  field is free text, so nothing breaks.
- **Opening a file without following a link, on Windows.** `os.open` has no `O_NOFOLLOW` there.
  A file replaced by a symlink between listing and opening would be read through the link. It
  is a race, not a spec rule; fixing it needs `CreateFileW` with `FILE_FLAG_OPEN_REPARSE_POINT`
  through `ctypes`, which I didn't do.
- **The Windows and macOS code paths are untested**, for lack of a machine. That covers `\\?\`,
  junctions, drive letters, `icu.dll` and the macOS case lookup. Their pure parts (`\\?\`
  prefixing and stripping, segment splitting, case-insensitive DIR matching, three U+FFFD for a
  lone surrogate) were unit-tested on Linux. The code parses as Python 3.10 syntax.

## Environment notes, not the format

- boto3/botocore 1.34.46 have no `IfNoneMatch`/`IfMatch` parameters. I add the headers in a
  `before-call` handler for `PutObject` and `CompleteMultipartUpload`, as the spec's hint says,
  and S3 enforced both with 412.
- botocore 1.34 ignores `AWS_REGION` (it reads only `AWS_DEFAULT_REGION`), so the program passes
  the region explicitly. botocore picked up `HTTPS_PROXY` without any configuration.
- **The bucket has a lifecycle rule that expires every object after 1 day**, and aborts
  incomplete multipart uploads after 1 day. The final repository will therefore disappear about
  24 hours after the final runs. Versioning is off, so emptying the bucket really emptied it.
- The role can't call `GetBucketEncryption` or `GetObjectAttributes`. `HEAD` still reports
  SSE-S3 (`AES256`) on every object, from the bucket default.
- The sandbox forbids creating Unix sockets (`EPERM`), so the socket case is untested. The
  mode-000 file is really unreadable, since the runs aren't root.
- The machine's zone is `Etc/UTC`, so the final snapshot names coincide with UTC. Local naming
  was tested separately with `TZ=Europe/London`.
- Speed: everything is sequential with a fresh `HEAD` per object. `bulk` (1,100 files) took about
  4 minutes; a full verification with restore took about 5.5 minutes.
