# The format-spec clean-room audit, run 22: backup on Linux, Fable 5.1 at xhigh (2026-11-09)

One of the six runs of a real set: each role on each platform, run in CI on Claude Fable 5.1 at
`xhigh`, all reading the spec of 2026-10-30. The backups and the Linux restore read it as of
[PR #506](https://github.com/allens/s3cab/pull/506); the macOS and Windows restores read it as of
[PR #508](https://github.com/allens/s3cab/pull/508), which added one note for a writer, on aborting
a multipart upload refused at completion. The set is runs 22–27: backups on Linux (this run),
[macOS](format-spec-audit-23.md) and [Windows](format-spec-audit-24.md); restores on
[Linux](format-spec-audit-25.md), [macOS](format-spec-audit-26.md) and
[Windows](format-spec-audit-27.md).

- **Program:** [`s3cab-backup.py`](../scripts/cleanroom/backup/linux/s3cab-backup.py), Python with
  boto3. Its notes, logs and test tools stay with the run, outside the repo.
- **Checker:** matches.
- **Audit:** 4 moves flagged, each writing or editing the session's own program or report, caught
  only by the word "s3cab" in them; the judge found all four harmless.
- **Tokens:** input 1,026, cache write 230,907, cache read 3,612,594, output 127,899.

Everything below the rule is the session's own report, verbatim.

---

# s3cab format spec (2026-10-30): clean-room backup writer — report

Deliverables in this directory:

- `s3cab-backup.py` — the backup writer, Python 3.10+ standard library plus boto3, written from `format.md` alone.
- `s3cab-backup.state.json` — what the spec says a backup keeps between runs: the `OWNER`/`CLAIMED` pair per bucket and set, written by the program beside itself.
- this report.

## Outcome

All ten sets in `ENVIRONMENT.md` were run with exactly `python s3cab-backup.py <bucket> <set> <dir>...` after the bucket was emptied, and the bucket is left as those runs left it. Eight sets have a snapshot; two (`scans`, `ledger`) stop by the spec's own rule and have a `.info` but no snapshot.

| set | snapshot | file rows | `#error` rows | objects | exit |
| --- | --- | --- | --- | --- | --- |
| edge | `20261109T1428` | 61 | 3 | 55 | 1 |
| docs | `20261109T1428` | 120 | 0 | 120 | 0 |
| bulk | `20261109T1429` | 1100 | 0 | 1100 | 0 |
| media | `20261109T1431` | 2 | 0 | 2 | 0 |
| hollow | `20261109T1431` | 0 | 0 | 0 | 0 |
| spread | `20261109T1431` | 13 | 0 | 13 | 0 |
| faults | `20261109T1431` | 3 | 0 | 3 | 0 |
| corrupt | `20261109T1431` | 3 | 0 | 3 | 0 |
| scans | none — stopped: an entry's name has no UTF-8 form (`scan-\xff.txt`) | — | — | 0 | 1 |
| ledger | none — stopped: a regular file has a tab in its path (`q1\t2026.txt`) | — | — | 0 | 1 |

Bucket after the final runs (from `aws s3 ls --recursive`): 1296 objects, 8 snapshots, 10 `.info` files, 0 locks, 1314 keys in all.

`edge` exits 1 because it has `#error` rows (two links leading out of the backup, one unreadable file); the snapshot is still uploaded, as the spec requires. `scans` and `ledger` cannot be backed up by a tool that follows the spec and has no exclude facility (see the first finding under *Would inconvenience the implementer*).

### What was verified, and how

Every statement below comes from a real request to `s3://test-s3cab-ci-cleanroom-backup` through the proxy, with boto3 or the `aws` CLI. No local S3, no fake endpoint, no replay.

- An independent reader (scratch script, written from the spec's reading rules, separate from the writer) fetched each set's latest snapshot and checked: gzip magic, single stream, nothing after the stream, header flags 0 and mtime 0; strict UTF-8, no BOM, no CR; the heading row byte for byte; `.` last; no blank lines; five fields per line; canonical padding of every row (64/12/24 code points); exactly one `@S3CAB SPEC`, `@CLIENT NAME`, `@CLIENT VERSION`, `@SET NAME`, `@SNAPSHOT NAME/BY/START/FILES/SIZE/FINISH`; `FILES` and `SIZE` against the rows; every file row's hash, size and 24-character time; every path absolute, no `./..`/empty segment, strictly under a `@SET DIR` by whole segments; no path in two rows; no path running through another. Result for all eight snapshots: `PROBLEMS: none`.
- For every file row it fetched `objects/<hash>`, hashed the body, and compared with the key; it also checked the stored `ChecksumSHA256` equals the base64 of the key's digest, that no `Content-Encoding` or `x-amz-meta-*` is stored, and that `ContentLength` equals the row's size. Result: `missing objects: []`, `objects whose bytes don't hash to the key: []` for all 1296 objects.
- For every file row it `lstat`ed and re-hashed the file on disk and compared size, millisecond-rounded mtime and hash. Result: `filesystem mismatches: []`. It also walked every `@SET DIR` and confirmed every regular file on disk has a row (`-`, `#excluded` or `#error`): `regular files on disk with no row: []`.
- `.info` files: three `KEY=value` lines, LF-terminated, UTF-8, instants in the 24-character form; `CLAIMED` equals `CREATED`.
- `locks/` is empty after every run.
- Behaviour tests on throwaway sets (all outputs were inspected; summary): second run of a set reused all objects ("3 already present") and published a new snapshot; a run in the same minute was refused; `.info` rewritten to another holder → refused and the kept pair forgotten; `.info` deleted while snapshots exist → refused ("no holder"); `.info` and snapshots deleted with a stale pair kept → fresh claim; a file whose size and mtime changed between hash and upload → not sent, snapshot not uploaded, exit 1, nothing stored under its key; a file whose content changed but whose size and mtime were put back → caught by re-hashing, not sent, nothing stored; a 20 MiB file above a lowered multipart threshold → multipart with per-part `ChecksumSHA256`, completed only after the whole hash matched; stored checksum `…-2`, download hashes to the key, no multipart upload left open; a member directory given as a relative symlink with a trailing slash → `@SET DIR` is the real path `/srv/s3cab.sandbox/fixtures/edge/sub/`.
- Lock tests (eight cases): a foreign `upload-` lock is ignored and left; a foreign `delete-` lock refuses the run and my own lock is removed; my own dead `upload-` or `delete-` lock (pid gone) is removed and the run proceeds; my own `delete-` lock with a live pid refuses; a lock with my identity but a different `PIDNS`, or a `PID` with a leading zero, is never judged, so a `delete-` one refuses; a key not starting `upload-`/`delete-` is ignored.
- Local stop conditions (no bucket): nested or repeated member directories (also via a symlink), a missing member directory, a file as member directory, a dangling symlink as member directory, bad set names (`Edge`, `my--set`, `-photos`), an unlistable directory, a tab, CR or LF in a regular file's path, a name with no UTF-8 form. Each stopped with no snapshot and exit 1.
- Dry-walk cases: tab-named empty directory → walked, no row; file beneath it → stop; member directory with a tab in its name → `@SET DIR …/m␉ember/`, valid snapshot; links to a FIFO, a loop, into the backup (absolute and relative), and the member directory itself → no row; links out of the backup, absolute or relative → `#error` with the target as the link holds it and a trailing separator when it is a directory; link into an unreadable directory → `#error` "can't resolve"; a file vanishing between listing and open → `#error ENOENT`; hardlinks → two rows, one object; FIFO → no row.
- Pure functions: the canonical heading, file row and `@SET DIR` row match the spec's JSON strings byte for byte; `instant_from_ms` matches Python's `datetime` for 11 instants from 1969 to 9999 and gives `0000-01-01T00:00:00.000Z` and `0000-02-29` for the year 0000 (a leap year); readable sizes for 0, 999, 1000, 999,949 (`999.9kB`), 999,950 (`1.0MB`), 4,915,200 (`4.9MB`), and PB; `@SET DIR` matching for 17 cases including `//`, `C:\foo\\`, `\\server\`, `\\`, a relative DIR and a drive root.

What was **not** tested is listed at the end.

## How the program meets the rules

Flow: validate the set name; resolve each member directory to its real path (`realpath(strict=True)`, then each name looked up in its parent's listing; on Windows through `\\?\`, drive letter uppercased) and refuse nested or repeated ones; take one clock reading for the snapshot name (local) and `START` (UTC, cut down to the millisecond); write the upload lock (no-overwrite PUT, read back on 412), then list `locks/`; claim or check `.info`; refuse early if this minute's snapshot already exists; walk every member directory without following links, hashing each regular file from an `fstat`ed handle (size and time from the same check, byte count compared with the size); build the snapshot in canonical form, gzip it as a single stream with an empty name and mtime 0; re-read the text as the spec's reader would and refuse to upload it if any row would be refused; then objects first: for each unique hash, HEAD the key, and if absent re-open the file, compare size and millisecond mtime with the row, read it whole while hashing, compare the hash with the key, and send it with `If-None-Match: *` and `ChecksumSHA256` set to the key's digest, so AWS refuses any bytes that don't hash to the key before anything becomes visible (verified: a wrong digest returns `BadDigest` and a HEAD afterwards is 404). If any object could not be stored as its row says, the snapshot is not uploaded and the run exits 1. Otherwise read `.info` again, compare `OWNER` and `CLAIMED` with the kept pair, PUT the snapshot with `If-None-Match: *` (a 412 is accepted only if the stored bytes are identical), and remove the lock. Exit 1 if any `#error` row was written.

Files larger than 5 GiB go by multipart upload, each part with its own `ChecksumSHA256`, the whole hashed from the same bytes and completed only if it equals the key, aborted otherwise (tested with the threshold lowered by an environment variable meant for testing only).

What it doesn't do: no exclude patterns (so no `#excluded` rows are ever written), no takeover of a set, no deletion, no reading of deletion records (it never takes the "named by an earlier snapshot" shortcut; it HEADs each object instead). Objects are stored in the default `STANDARD` class, which a plain GET reads at once.

## Would leave a backup that can't be restored correctly

Ranked by how wrong the restored tree would be if the other reading were taken.

1. **How a file row's path is built when the member directory's own real path holds a tab, CR, LF, or has no UTF-8 form.** The writing checklist says a file row's path is "its member directory's `@SET DIR` string with each name below it joined on", and the `@SET DIR` *string* has those characters spelled out as `␉ ␍ ␊`. Joined onto the written string, a tab-named member directory yields file paths containing `␉`, which pass the "tab in its path" check and get rows for paths that don't exist; a restore to recorded paths lands them in a `␉`-named folder, and a re-backup never matches. The resolution is in another section ("a regular file beneath it … stops the run") but the checklist doesn't say "build from the raw path, spell out only when writing". For a member directory whose own name has no UTF-8 form the spec is silent: the stop rule speaks of "an entry's name", and `U+FFFD` substitution is described only for the `#excluded` row. **Guess:** every path is built from the raw real path; the raw path is tested for tab/CR/LF (stop); spelling out happens only when writing a `#` row path, a `@SET DIR` or a message; a member directory whose path has no UTF-8 form is refused like an entry. **Checked:** dry walks of a tab-named member directory (DIR `…/m␉ember/`, snapshot valid, no rows) and of a tab-named subdirectory with a file beneath (stopped). The no-UTF-8 member directory case was not exercised (none in the fixtures).
2. **Which listing entry "is" the typed name when the filesystem ignores case (or normalization).** The spec says `realpath` keeps the case as typed on macOS and in a case-insensitive Linux directory, "so look each name up in its parent's listing instead", but not how to match: byte equality finds nothing; Unicode case folding is not the filesystem's folding (APFS/NTFS tables, `İ`, `ß`), and an HFS+/APFS volume that ignores normalization can hold `café` as NFD while the set says NFC. A wrong pick, or falling back to the typed spelling, puts the wrong casing in `@SET DIR` and in every file row under it. The file is internally consistent, so a restore to a chosen directory works, but a restore to recorded paths on a case-sensitive destination makes wrongly named folders, silently, and two tools backing up one set disagree on every path. **Guess:** exact name if present; otherwise the one entry whose `lstat` is `samestat` with the typed path's (inode identity), else the typed spelling. **Checked:** only on Linux ext4, where the exact name always exists, so the fallback never fired; macOS and Windows not run.
3. **An object already at `objects/<hash>` counts as stored on a HEAD alone, whatever its length.** The spec is explicit ("Wrong bytes at a key are damage, for a check of the whole repository to find"), so no guess was needed, but the consequence is a backup that reports success for a row no reader can restore (the reader's hash check withholds it), when the HEAD's `ContentLength` against the row's size would have caught a truncated object at no cost. Not implemented, to stay within the rules as written; flagged because it is the one place the writer could know and is told not to look.

## Would inconvenience the implementer

1. **A set that can't be backed up without an exclude facility.** `scans` (a name with no UTF-8 form) and `ledger` (a tab in a name) must stop with no snapshot; the only way past is a tool-specific exclude mechanism outside the format, and "leaving out a name that would stop the run is the user's choice". A tool with the fixed command line in this exercise can't offer one, so two of ten sets are unbackupable by design. The spec is consistent about this, but a reader of the checklist alone might expect `#excluded` rows with `U+FFFD` to be the writer's way out; they are not. **Guess:** stop, exit 1, leave the claimed `.info` in place ("a set … whose first backup stopped"). **Checked:** both final runs.
2. **The holder pair's life cycle.** The spec says to keep `OWNER`/`CLAIMED` "wherever your tool keeps its own state", keyed by bucket and set, and to forget it "once it stops matching". It doesn't say what to do with a kept pair when the set has vanished from the bucket (no `.info`, no snapshots) — claim afresh, or refuse? **Guess:** claim afresh and overwrite the pair; this is also what makes "empty the bucket and run again" work. It also doesn't warn that two runs for different sets on one machine race on that state (I hit this in design: load, modify, save loses the other's pair; fixed by re-reading just before writing). And a tool with nobody to ask can never publish again to a set whose `.info` was lost, since takeover "is a person's decision" — true to the spec, and worth a sentence in the checklist. **Checked:** stale pair → fresh claim; takeover → refused and forgotten; `.info` gone with snapshots → refused.
3. **A touched file fails the whole run.** "Just before sending a file, check its size and modification time against its row … If either changed, don't send it", then "don't upload the snapshot". A file whose content is unchanged but whose mtime moved (a `touch`, an editor save of identical bytes) therefore blocks the snapshot even though the row's hash is right and the writer re-hashes the bytes anyway. **Guess:** follow the rule literally. **Checked:** the size/mtime change test.
4. **"Already stored" has four acceptable tests with very different costs and prerequisites.** LIST (cheap per thousand, but a shared bucket's `objects/` may be huge), HEAD per object, the PUT's own 412 (sends the body), or an earlier snapshot's word — the last only while every deletion record is valid, which drags the whole deletion-record parser into a writer. The checklist could rank them. **Guess:** HEAD per object. 
5. **Refusing a same-minute snapshot "with no local copy".** The checklist's only mechanism is the 412 at the end, after the walk and every object upload. A HEAD of the snapshot key right after minting the name saves the run; the spec doesn't mention it. **Guess:** HEAD early, and still accept a 412 at the end when the stored bytes are identical. **Checked:** same-minute re-run refused before the walk.
6. **`@SET ENDPOINT` "when it isn't AWS's default".** No way is given to tell an endpoint that *is* AWS's default from one that isn't. **Guess:** write the row whenever `AWS_ENDPOINT_URL_S3` or `AWS_ENDPOINT_URL` is set, and request SSE only when neither is. Not exercised (no endpoint set here).
7. **The trailing separator on a link's `#error` row.** "A link whose target is a directory" — the immediate target or the final resolution through further links? **Guess:** the final resolution's type. **Checked:** both link rows in `edge`.
8. **A writer isn't asked to check its own rows.** "Never upload a snapshot a reader would refuse whole" lists only the whole-file conditions, and "Upload a snapshot whose rows a reader refuses one path at a time like any other" allows a writer bug (DIR from the typed path, rows from the real path) to upload a snapshot every row of which is refused. A recommendation to run the reader's row checks before upload would help; the program does.
9. **Server-side encryption scope.** "asks AWS … for server-side encryption" appears in the sentence about objects and snapshots; it doesn't say whether locks and `.info` get it. **Guess:** every PUT on AWS.
10. **What `COMMAND` and `SET` hold in a lock, and whether `SET` is required** — free text, guessed as `backup` and the set name. Harmless.
11. **The zone name when `TZ` is unset and `/etc/localtime` isn't a symlink into `zoneinfo/`** — the spec says "write the best name you have"; the fallback chain is left to the implementer. **Guess:** `TZ`, then the `zoneinfo/` suffix of the real path, then ICU on Windows, then `time.tzname`.

## Hints that would have helped

- **Test vectors for `@SET DIR` matching.** The rules are spread over several paragraphs (`//` matches nothing, `C:\foo\\` is `C:\foo\`, `\\server\` is no share, decide the kind from the row as written first). A ten-line table would have caught the bug my own unit test caught: deciding "POSIX root" for `//` before applying the Windows-share rule.
- **Rounding a negative nanosecond count.** "Tie to the later one" is clear in meaning, but Python's `round()` is banker's, C's `lround` rounds away from zero (earlier, before 1970), and only floor arithmetic `(ns + 500_000) // 1_000_000` gives "later" on both sides of the epoch. The spec warns off `round()` but not off truncation toward zero.
- **A date algorithm for years 0000–9999.** `datetime` can't hold year 0 and `fromtimestamp` fails before 1970 on Windows, as the spec says; it could add that a days-to-civil algorithm (Hinnant's) is a dozen lines and that glibc's `strftime("%Y")` prints year 1 as `1`, confirmed here.
- **You can't produce the "time the form can't hold" `#error` on ext4.** `os.utime` to the year 10000 read back as `2446-05-10T22:38:55.000Z`, exactly the clamp the spec mentions for restores. A writer's hint would say to unit-test the conversion instead.
- **The two "vanished" cases map onto two calls.** `DirEntry.stat(follow_symlinks=False)` raising `FileNotFoundError` is "vanished between being listed and its type being known" (no row); `os.open` raising it is "vanished before it is read" (`#error`).
- **Multipart in boto3 needs `ChecksumAlgorithm="SHA256"` on `create_multipart_upload`** for `upload_part` to accept `ChecksumSHA256`, and the `If-None-Match` hook must also be registered for `CompleteMultipartUpload` (the spec says so for 1.34; the first point it doesn't).
- **Observed S3 answers worth stating as facts:** a wrong `ChecksumSHA256` is HTTP 400 `BadDigest` and stores nothing; a no-overwrite PUT on an existing key is 412 `PreconditionFailed`; `head_object(ChecksumMode="ENABLED")` returns the base64 digest for a single PUT and `…-<parts>` for multipart; without `ContentType` S3 stores `binary/octet-stream`.
- **State kept between runs is shared by concurrent runs.** Two sets backed up at once on one machine race on the pair file; re-read before writing or lock it.
- **`realpath(strict=True)` on a loop** raises `OSError(ELOOP)` on Linux, which the broken-link test covers; the spec names `ELOOP` but not that Python surfaces it that way for `strict=True`.
- **`getpass.getuser()` can raise** in a container without a passwd entry; fall back to `USER`/`USERNAME`.
- **botocore with no credentials probes the instance-metadata address** (169.254.169.254) before failing, which in a sandbox looks like a network denial rather than "no credentials".
- **Heredocs and CR.** A test that types a carriage return into a bash heredoc gets a line feed; my first CR-in-a-name test tested LF. Use `$'\r'`.

## Environment notes, not the format

- Linux (Ubuntu 24.04 kernel 7.0, ext4 for `$TMPDIR`), Python 3.12.3, boto3 1.34.46 / botocore 1.34.46 (no `IfNoneMatch` parameter on `PutObject`, as the spec says for 1.34; a `before-call` hook adds the header), aws-cli 2.39.3.
- Credentials from `credentials.env` (key, secret, session token), valid to 19:59Z; no 403 was seen. `AWS_REGION=us-east-1` is passed explicitly as `region_name`.
- All traffic through the `HTTPS_PROXY` named in the environment; botocore and the aws CLI honour it with no configuration. The sandbox denies the instance-metadata address, visible only when boto3 was run without credentials.
- The bucket was empty at the start and was emptied with `aws s3 rm --recursive` (and a check for open multipart uploads) before the final runs. Throwaway sets used for behaviour tests (`ul`, `tkinfo`, `tkfresh`, `chg`, `mptest`, `linktest`, `lk1`–`lk8`) were removed by that emptying; the state file was reset at the same time so it holds exactly the ten sets' pairs.
- Identity: `BY=runner@runnervm7aw5e`, `OS=linux`, `PIDNS=pid:[…]` from `/proc/self/ns/pid`; the sandbox shell is PID 2, which served as the "alive" PID in the lock test.
- `/etc/localtime` → `Etc/UTC`, `TZ` unset, so names and `START` agree to the minute.
- The tool harness moved the working directory when a compound command used `cd`; absolute paths were used throughout.
- Writes stayed in this directory (program, state file, report) and `$TMPDIR` (scratch scripts, test trees, the 20 MiB multipart test file, and the program's own temp spool for bodies over 64 MiB, which no fixture reached).

## Not tested, and known limits

- Windows and macOS code paths were written from the spec's hints and never executed: `\\?\` prefixing, junction detection by `st_reparse_tag`, drive-letter uppercasing, UNC roots, `OpenProcess` liveness, `icu.dll` zone name, Windows `readlink` prefix stripping, the case-fix fallback (never triggered on ext4).
- Files over 5 GiB (multipart was exercised only by lowering the threshold to 16 MiB on a 20 MiB file).
- An mtime outside years 0000–9999 (the filesystem clamps); the conversion was unit-tested to return "can't hold" for those.
- `@SET ENDPOINT` and non-AWS stores, including whether they enforce `ChecksumSHA256`.
- A lost-response retry of the lock or `.info` PUT (412 followed by reading back one's own bytes) — the code path exists, the situation didn't arise.
- A lock held by another user's live process (`EPERM` path) and two genuinely simultaneous runs.
- Deletion records are neither written nor read.

## Appendix A — the `edge` snapshot as fetched from the bucket (tabs shown as →)

```
@S3CAB→FORMAT                                                          →        size→time                    →https://s3cab.plantegral.com/guide/format
@S3CAB→SPEC                                                            →            →                        →2026-10-30
@CLIENT→NAME                                                            →            →                        →s3cab-backup
@CLIENT→VERSION                                                         →            →                        →0.1.0
@SET→NAME                                                            →            →                        →edge
@SET→BUCKET                                                          →            →                        →s3://test-s3cab-ci-cleanroom-backup
@SET→DIR                                                             →            →                        →/srv/s3cab.sandbox/fixtures/edge/
@SNAPSHOT→NAME                                                            →            →                        →20261109T1428
@SNAPSHOT→BY                                                              →            →                        →runner@runnervm7aw5e
@SNAPSHOT→START                                                           →            →2026-11-09T14:28:49.636Z→Etc/UTC
#error→link to a folder outside the backup: /srv/s3cab.sandbox/fixtures/outside→            →                        →/srv/s3cab.sandbox/fixtures/edge/link-out-dir/
#error→link to a file outside the backup: /srv/s3cab.sandbox/fixtures/outside/beyond.txt→            →                        →/srv/s3cab.sandbox/fixtures/edge/link-out-file
-→b2bee966b659f138491ad58cd230a6a8b050ff8aa36d7f4d7f67c20858246d7b→          18→2026-11-09T13:59:19.078Z→/srv/s3cab.sandbox/fixtures/edge/ both ends.txt 
-→7ad27b4d6bf146de669ca6021cdc3cfd969139414d4ddb58a559de3f4c31991a→          22→2026-11-09T13:59:19.078Z→/srv/s3cab.sandbox/fixtures/edge/ leading.txt
[... 60 more rows ...]
@SNAPSHOT→FILES                                                           →            →                        →61
@SNAPSHOT→SIZE                                                            →            →                        →1051001 (1.1MB)
@SNAPSHOT→FINISH                                                          →            →2026-11-09T14:28:50.435Z→0s
.
```

The last field is verbatim: the U+0085 name is stored as bytes `C2 85`, and `trailing.txt ` keeps its trailing space (checked with `od -c` on the decompressed file).

## Appendix B — the running log of guesses, as recorded during the work

G01. Claiming `.info` before the walk (spec allows either side; I chose before, as it recommends), so a set whose run stops (tab in a name, non-UTF-8 name) is left with a `.info` and no snapshot.
G02. No exclude facility: the command line is fixed, and the spec says leaving a blocking name out is the user's choice, not the tool's. So `ledger` (tab in a name) and `scans` (non-UTF-8 name) must stop with no snapshot, exit 1.
G03. Kept OWNER/CLAIMED pair when the bucket has been emptied (no `.info`, no snapshots): claim afresh and overwrite the kept pair. Spec only says to forget a pair "once it stops matching".
G04. A member directory whose own name has no UTF-8 form: refuse (the spec's rule is phrased for "an entry").
G05. Mtime rounding for negative nanoseconds: "tie to the later one" read as toward +infinity, i.e. floor((ns + 500000) / 1000000).
G06. `#error` message wording, lock `COMMAND` text, `FINISH` duration format, zone name: all free text, chosen freely.
G07. Objects stored in STANDARD class (spec: "a class a plain GET reads at once"; GLACIER_IR is what s3cab does, with billing minimums).
G08. SSE AES256 requested on AWS (no custom endpoint) as s3cab does; the spec's checklist lists this among what s3cab does, not clearly as a rule.
G09. Already-stored test: HEAD per object (spec allows LIST, HEAD, or 412).
G10. Snapshot entries sorted by name bytes within a directory (spec: order is filesystem's; any order OK).
G11. Single PUT up to 5 GiB; multipart above (threshold overridable by env var for testing only).
G12. Link row messages name the target as `readlink` gives it (spec says so); kind word "folder"/"file" chosen freely.
G13. Server-side encryption (AES256) requested on every PUT on AWS — locks and `.info` included — since the spec says s3cab "asks AWS for server-side encryption" without saying for which keys.
G14. `#error` rows for links found by the walk are written before the file rows; `#error` rows from hashing sit among the file rows in walk order (the spec describes this as s3cab's order, a recommendation).
G15. A HEAD per object before a conditional PUT (the spec allows HEAD, LIST or the PUT's 412 alone).
