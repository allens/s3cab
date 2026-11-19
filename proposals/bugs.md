# Bugs / correctness suspicions

> **Interim home — must reach zero before a release to `latest`.** Bugs belong in **GitHub
> Issues**, but the repo won't use Issues until pre-release. So this file is the stop-gap tracker
> in the meantime. It is the **one file in `proposals/` that should be gone by that release** —
> i.e. *no known bugs* at ship. A `-alpha.N` on `next` may ship with entries open. After that,
> file bugs as GitHub Issues, not here.

<sub>Last cleared 2026-07-19: the HIGH baseline-trust hole (`backup` trusting a local
`--since` baseline whose remote snapshot a `forget` + `cleanup --delete` had since removed —
publishing a snapshot referencing a deleted object) was fixed by trusting the baseline **iff
it still exists remotely**: `uploadSnapshot` HEADs the baseline's remote snapshot before
believing it, and on a miss drops the baseline and LISTs the store as a first backup would.
The same check also covers a baseline snapshotted locally but never uploaded. The deletion
rework's interlock — subtracting deletion-record hashes from any trusted baseline — landed
with the path-scoped `delete`
([ADR-0064](../docs/adr/0064-path-scoped-delete-deletion-record.md)). The name-only HEAD that
fix introduced has since become a byte-identity GET
([ADR-0084](../docs/adr/0084-snapshot-identity-byte-equality.md), 2026-08-14).</sub>

---

<sub>An **adversarial durability audit of the 1.0 format freeze** (2026-08-12, Claude Fable at
xhigh reasoning, reading `88fbc70`) contributed five entries; its brief was the one failure that
matters — *a backup that reports success but cannot be restored*. Each entry was pinned by a
deterministic current-behaviour test in the model-based suite ([test/model/](../test/model/)),
and **all five are fixed, 2026-08-14**, their pinning tests flipped to the correct behaviour: a
file mutated *during* its upload stored as wrong bytes under a right hash, by `putFile`'s
streamed-digest check ([ADR-0083](../docs/adr/0083-streamed-digest-upload-guard.md)); `backup`
exiting 0 with unreadable files, by setting `process.exitCode = 1` whenever the pass recorded
`#ERROR` rows; the pair rooted in snapshot *names* not identifying snapshots — another machine's
same-name snapshot vouching for a never-uploaded baseline, and a retried manifest PUT harvesting
a 412 from its own lost-response success — by keying both checks on byte-identity with the local
file ([ADR-0084](../docs/adr/0084-snapshot-identity-byte-equality.md)); and the mtime-precision
staleness escape (a same-size rewrite that puts the old mtime back, confirmed on real NTFS), by
distrusting any size+mtime match whose ctime postdates the baseline's instant
([ADR-0085](../docs/adr/0085-ctime-cross-check-on-hash-reuse.md)). The audit's full report —
state model, reproduction sequences, and the **ruled-out** list (what was attacked and which
guard held) — is kept **outside the repo** as `s3cab-durability-audit-2026-08-12.pdf`; the state
model is now [docs/design/repository-protocol.md](../docs/design/repository-protocol.md).
Headline result: the objects-first/snapshot-last invariant **holds under process termination at
every step** — what broke was concurrency and time. One of the five fixes was itself wrong and
was corrected 2026-08-21: ADR-0085 compared ctime against the *header's* instant, minted at pass
**start**, so on a volume where reading a file moves its ctime — the Windows Cloud Files filter
driver behind OneDrive Files On-Demand, measured 8/8 — every file a pass hashed was distrusted by
the next one, for ever (97% of a 3,026-row sample, 1.8 TB re-read per run, none of it changed).
The check is now opt-in (`S3CAB_CHECK_CHANGE_TIME`) and weighs against the run's start again;
by default the escape is documented in [guide/backup.md](../guide/backup.md), with `--rehash` as
the recourse ([ADR-0094](../docs/adr/0094-change-time-check-opt-in.md)).</sub>

<sub>The model-based test suite itself (prompt #3, 2026-08-14) found three more, **all fixed
2026-08-14**, each pinned by a test that now asserts the correct behaviour: a truncated stored
manifest parsing as a valid empty snapshot while `verify` called the store healthy, by the
end-of-file trailer ([ADR-0082](../docs/adr/0082-snapshot-end-trailer.md)); case-colliding manifest
paths restoring to one silently-overwritten file with exit 0 — the same hazard APFS's
unicode-normalisation folding poses for NFC/NFD neighbour paths — by keying collision detection
on the filesystem's own equivalence rather than lowercasing
([ADR-0086](../docs/adr/0086-restore-collision-filesystem-equivalence.md)); and the latent
percent-encoding of non-ASCII S3 keys (`parseS3Uri` took `new URL(...).pathname`, so a set
named `café` — reachable only if `validateSetName`'s `[a-z0-9-]+` charset is ever loosened —
stored its manifests under `snapshots/caf%C3%A9/…`, breaking
[guide/format.md](../guide/format.md)'s promise that keys are `snapshots/<set>/…`), by parsing
the URI as a plain string split so keys reach the bucket verbatim; only the Tier 2 inspector
could see that one, since every seam call encoded identically
([test/model/conformance/store-semantics.test.mjs](../test/model/conformance/store-semantics.test.mjs)).</sub>

<sub>The two **minute-resolution name** entries are fixed, 2026-08-18, and they wanted opposite
answers. The *deletion record* stopped refusing: a second `delete` finishing inside the same
minute used to abort with "wait for the next minute" as the entire remedy — two people sharing a
bucket hit it, and CI hit it for real (2026-08-15, run
[31852887331](https://github.com/allens/s3cab/actions/runs/31852887331), two workflow runs from a
stack of back-to-back merges overlapping on the shared bucket, since serialized by the `s3
integration` job's own repo-wide `concurrency` group). A record's name is read by nobody —
`readDeletionRecords` LISTs the prefix and unions every file — so the refusal it inherited from
the snapshot name grammar bought nothing; a taken name now takes the next one (`-2`, `-3`, …),
the PUT stays conditional on every attempt, and the read side accepts `<timestamp>[-<n>].tsv`
([ADR-0087](../docs/adr/0087-deletion-record-suffix-on-collision.md)). The *snapshot* kept
refusing, because there the name is an identity users type and refusing a repeat is what stops an
accidental double-run rewriting history — what changed is the message. Confirmed live,
multi-process (2026-08-14, crash tier — *"same set, same snapshot name"* in
[test/crash/concurrency.test.mjs](../test/crash/concurrency.test.mjs)): the loser of the manifest
no-clobber race failed with *"Snapshot '…' is already backed up"*, true of the **name** and false
of the loser's **data**, which its objects-first upload had already stored. `uploadSnapshotFile`
now branches on
[ADR-0084](../docs/adr/0084-snapshot-identity-byte-equality.md)'s byte comparison: *identical* is
this run's own retried PUT and still succeeds quietly, while the two losing outcomes — *different*
(another machine's snapshot holds the name) and *absent* (that snapshot deleted between the 412
and the read) — share **one** past-tense message, since the user's situation and remedy are the
same in both: the name *was* taken when we wrote it, the files are stored, re-run to record them
under the next minute's name. The past tense is what lets one wording cover a snapshot that is no
longer there. Nothing remains: two live machines on one
set is a **settled** discouraged-but-tolerated state, never locked out
([ADR-0024](../docs/adr/0024-set-name-is-the-whole-identity.md)), which is precisely why the
loser's message — not a lock — was the thing to fix.</sub>

<sub>The **mtime-precision entry** from clean-room run 2 (its finding 2) is resolved 2026-08-20, and
the resolution was to change the *promise*, because the code has no fix. `restore` hands the row's
`mtime` to `fs.utimes`, which takes **seconds as a binary64** in every spelling — a `Date` becomes
`getTime() / 1000` — and near a 2026 epoch one ULP of that double is 2⁻²² s ≈ **238ns**, so a
fraction of a second like `.674` is not representable at all. Measured under node 26: ext4 records
`…674000024`, and NTFS is **exact**, the error falling below its 100ns tick — which is why a defect
present since the first restore was invisible on the platform the work is done on. The 24ns sits
*inside* one ULP, no arithmetic in userland closes it, and `fs` exposes no nanosecond setter, so
there is nothing to fix within builtins
([ADR-0005](../docs/adr/0005-builtins-over-dependencies.md)). What was false was
[guide/format.md](../guide/format.md)'s "a restore reproduces the *stored* value exactly"; it now
promises the *millisecond*, tells a reader to compare at that resolution and no finer, and says the
two can disagree below it without either being wrong. Both consequences the paragraph draws were
always true and are unchanged — `fileProps` rounds the exact nanoseconds to the millisecond, so
674.000024ms renders `.674Z`, a restored tree compares clean against its snapshot and re-backing it up re-uploads
nothing. Two things worth keeping. Run 2's C++ restorer set times through a nanosecond interface and
was **exact**: 1261 of its 1269 files differed from s3cab's own restore, the 8 matches being
precisely the `.000` values, so s3cab was the imprecise side and a spec demanding an exact match
would have asked other implementations to reproduce our defect. And the two runs agreeing to the
nanosecond was never corroboration — run 1's Python restorer went through the same float seconds, so
they shared the flaw. Only a comparison against the *stored* value could show it, which is the
argument for `compare.py` reading `st_mtime_ns`.</sub>

<sub>The **Windows date-range entry** is resolved 2026-10-27 the same way, by changing the
promise, because the fix lies two layers below s3cab. On Windows `statSync` reads a modification
time before 1970, or from 2106-02-07T06:28:16Z on, as another date inside that range —
`1969-12-31T23:59:59.0005Z` as `2106-02-07T06:28:15.001Z` (`mtimeNs` `4294967295000500000n`, so
`{ bigint: true }` doesn't help), 2200-12-31 as 2064-11-22 — while NTFS holds the true time
(measured under node 26.10.0; Linux reads both correctly). libuv's `uv_stat_t` keeps seconds in
`uv_timespec_t`'s `long tv_sec`, 32 bits on Windows, and `uv__filetime_to_timespec` narrows the
FILETIME's 64-bit count into it; Node's `FillStatsArray` then casts it to `unsigned long` on
`_WIN32` ([nodejs/node#43714](https://github.com/nodejs/node/pull/43714)), trading every date
before 1970 for 2038 to 2106. What comes out is the seconds modulo 2³², a valid date in range, so
s3cab can't detect it, and no builtin reads the true time. Widening `tv_sec` breaks libuv's 1.x
ABI: [libuv#3864](https://github.com/libuv/libuv/issues/3864) is fixed on master for an
unreleased v2, after which Node must also drop its cast. Until both ship,
[guide/backup.md](../guide/backup.md) says such a date is backed up wrong, and restore's
read-back skips these times on Windows (`readableOnWindows`, `src/lib/restore.mjs`).</sub>

<sub>An **adversarial audit of the bucket locks and the basic-form names** (2026-10-29, Claude
Fable 5.1, reading `9bb5b53`; brief: the 2026-08-12 one plus *a cleanup or delete that removes
content a snapshot still needs*) **contributed no entry.** Attacked by reading:
[ADR-0112](../docs/adr/0112-bucket-locks.md)'s write-first/look-second with the 412 read-back
(own bytes = own lock, so a lost PUT response is never taken for someone else's lock); the lock
held until every in-flight DELETE has settled (`eachInFlight` rejects only after the batch, so
`finally` never removes the lock under a delete still on the wire); `finally` removal on every
exit the process survives, with the `unlock` command printed when the removal fails; Ctrl+C
parked only inside the snapshot write, and every prompt (`cleanup`, `delete`, `forget`) outside
a lock; clock skew, which only orders the key names — nothing keys on a lock's instant and locks
never expire; a versioned bucket, where a removed lock is a delete marker, LIST hides it and a
no-overwrite PUT over it succeeds; a lock whose `PID` is privileged, which `process.kill(pid, 0)`
answers with EPERM and reads as alive (measured on both systems: EPERM for pid 4 on Windows and
pid 1 on Linux, ESRCH for a pid nobody has); cleanup's top-up read of new snapshot keys under its
lock, and `forget` taking no lock because it deletes manifests, never objects; compaction's merge
PUT before the absorbed records' deletes; and [ADR-0113](../docs/adr/0113-names-in-iso-basic-form.md)'s
one parse point (`snapshotNames`'s fixed-width regex, so lexical order is chronological order
and a forget audit's seconds-wide name can never read as a snapshot). Attacked by **running**,
Windows and WSL2 on one PC against one bucket (a path-style mock S3 both sides' SDKs talked to),
where `BY` is the same `allen@balmain` on both and only `OS`/`PIDNS` tell them apart: a dead lock
from either side is kept by the other and by a fresh pid namespace, and swept only by its own
system; a holder killed with `kill -9` (WSL) or `Stop-Process -Force` (Windows) is refused
everywhere while alive and, once dead, still refused everywhere but its own system, which sweeps
it; a pid live on the other system is never consulted, since `OS` differs first; a pid reused
inside one system reads as alive — a refusal, the ADR's accepted gap — and `unlock --dry-run`
from either side lists both locks with their system. One measurement refines the ADR's
*container or WSL restart* line: `unshare --pid` gives a fresh namespace the **same** inode a
dead one had (`pid:[4026532224]` twice over), so a lock from a dead namespace can be judged in a
new one, where its `PID` 1 is the judge itself and reads alive — again a refusal, never a live
lock removed; a container running s3cab as pid 1 therefore can't clear its own predecessor's lock
without `unlock`. Two bare-metal Linux machines sharing one `user@machine` share the initial
namespace's constant inode too, so they judge each other's locks — the ADR's accepted two-machines
case, unchanged. **From reading only, not a run:** macOS (`darwin`, no `PIDNS`, the same `kill 0`
semantics by Node's docs) and WSL1 (whether `/proc/self/ns/pid` exists there is unverified).
Pinned: `delete <hash>` mid-backup refused by the upload lock
([test/model/model.findings.test.mjs](../test/model/model.findings.test.mjs)), the twin of the
cleanup-mid-backup pin; for that the Tier 1 fake gained a HEAD that answers a stored object's
size, which let the review's second pin land beside it: a deletion record subtracts a hash from a
trusted baseline only while its object is absent (presence wins), a path the stubbed HEAD had
never let the model tier reach.</sub>

<sub>An **adversarial audit of `restore` and `extract`** (2026-11-04, Claude Fable 5.1, reading
`202171e0`; brief: a write outside the place asked for, or exit 0 over a wrong tree) found three
defects, **all fixed 2026-11-05** by [ADR-0116](../docs/adr/0116-restore-rechecks-its-target.md),
each needing something else writing in the output folder. **No attack from a snapshot alone
worked.** Run on Windows 11 (NTFS) and WSL2 (ext4) through the real reader and writes, faked only
at the bucket: `..`, `.`, empty and trailing segments in every path form, NUL, tab and CR (the
reader refuses them); a POSIX name holding `\` under a Windows output (`placeUnder`); dot- and
space-only names, which land verbatim inside `out`; NTFS streams (`putsColonInName`); `\\?\`,
`\\.\` and `//?/GLOBALROOT`; `@SET DIR` games; the 8.3 short name of a junction; a junction or
symlink at a folder or a file before the run, with and without `--overwrite`; case and NFC/NFD
twins; objects that lie about their bytes or size; absences with and without a deletion record;
`--from-file` oddities; `extract --name` values and item spellings; exit codes; and an in-place
cross-OS restore. **From reading only, not a run:** macOS, Windows 10, FAT/exFAT, paths past
`MAX_PATH`, and a symlink owned by another user under `protected_symlinks`. The full list is the
deleted `proposals/audit-restore-2026-11-04.md`, in git history.</sub>

<sub>Two **cold durability audits** (2026-11-05: one on Claude Opus 5.5 reading `4fb7dd7f`, one
begun on Opus 5.5 and measured on Claude Fable 5.1 reading `e55eb35a`; brief: the 2026-08-12 one
plus *a health or status report that says all is well over a store that can't restore*)
contributed eight entries, one found by both, **seven fixed 2026-11-05** and one recorded as an
open limit below. Each was pinned by a failing test, in the model-based suite
([test/model/model.durability.test.mjs](../test/model/model.durability.test.mjs),
[test/model/model.durability-audit.test.mjs](../test/model/model.durability-audit.test.mjs)) or
beside its command ([src/commands/snapshot.clock.test.mjs](../src/commands/snapshot.clock.test.mjs)),
each now asserting the correct behaviour. The one lost backup: a run finishing beside a
`--resume` run renamed the lock *name* into place, so it published the resumed run's
half-written file — exit 0 on a first backup, the long pass most likely to look stuck — and
unlinked its own rows; the comment saying Windows blocks this through the open handle was
measured false (Node opens with delete sharing). `withSnapshotFile` now takes the work file's
identity from its own handle and refuses, publishing nothing, when the name no longer means that
file ([ADR-0092](../docs/adr/0092-recover-the-interrupted-work-file.md), amended). The four
health reports that lied, settled by
[ADR-0117](../docs/adr/0117-health-reports-count-only-what-they-checked.md): `verify` said "all
verified ✓", exit 0, over an empty bucket and over a set whose every snapshot was gone
(`readReferencedObjects` dropped a set with no names before anything reported it) — now exit 1,
`nothing to verify ✗` and a `no snapshots` finding, a set not yet backed up reading the same on
purpose; `verify` passed an object a lifecycle rule had moved to `GLACIER` or `DEEP_ARCHIVE`,
where `restore` fails — the LIST's storage class now reaches a per-path `archived` finding;
`status` said "up to date" whenever nothing was left to upload, the latest snapshot not in the
bucket (a rename or deletion whose objects were all stored) — now only when the latest snapshot
*is* the backed-up one; and `upload --snapshot` exited 0 over `#error` rows, so the retry a failed
backup names hid the file it couldn't read — `upload` now lists them and exits 1, and the
upload-failed error counts them. The one silent loss in `cleanup`: its top-up compared the two
`snapshots/` listings by key, so a key re-published with different rows inside its scan-to-lock
window (`forget` then `backup --debug` in the same minute) kept its stale references and the new
rows' objects were deleted — now by key and ETag ([ADR-0112](../docs/adr/0112-bucket-locks.md)
step 4). And the clock warning compared true instants, which move *forward* at the end of
daylight saving and on a move west, the two cases [guide/format.md](../guide/format.md) names —
it now compares the names, which are what sort
([ADR-0072](../docs/adr/0072-timestamps-utc-in-files-local-in-names.md) check A). **Ruled
out**, by running unless noted: hostile snapshot bodies (zero bytes, a cut gzip, garbage after
the trailer, two members, plain text, an unknown row type), each a `verify` finding, a `restore`
refusal and a succeeding next backup; 300 fuzzed odd names restored byte-identical, with tab, LF,
CR and invalid UTF-8 refused loudly; nested and doubled roots refused; process death at every
request boundary of backup, multipart, cleanup and forget (`test:crash`, 21/21 on the real
bucket), `--resume` then restoring byte-identically; a mid-transfer mutation, an incomplete
multipart, drift mid-backup and a manifest PUT with a lost response (ADR-0083/0084); Ctrl+C at
the last row parks and publishes nothing; parked rows feed only the lookup, never `stored`;
`takeover`'s crash points and a differing same-name local snapshot; `forget` holder-gated and
never touching objects; the deletion record's record-first order, presence winning on HEAD,
compaction merging before it deletes; same size and mtime (ADR-0094); random 40-step sequences,
300 seeds across Windows and WSL. **Not defects, worth knowing**: `verify` is silent on an
invalid deletion record (`cleanup` refuses on it, and a missing object then reads as damage);
`verify` is green on a snapshot with `#error` rows by design; the trailer's `FILES`/`SIZE` aren't
checked (gzip's CRC makes damage unreachable there, and the values are for people); while a
baseline is trusted, `backup` doesn't re-upload an object lost to outside damage (ADR-0084's
trade; `verify` catches it); a first backup over a key already holding wrong-size bytes uploads
nothing, and `verify` flags it; a damaged remote snapshot pulled by `takeover` makes every later
`backup` fail loudly; a file over about 160 GiB exceeds 10,000 parts and fails loudly;
`test:crash` runs only by hand, not in CI. **Read only, not run**: macOS; the eight against a
real bucket (none depends on anything S3 does); a kill between the work file's rename and the
manifest PUT with a second run started in the gap; a bucket name that doesn't exist;
`INTELLIGENT_TIERING`'s archive tiers, which a LIST can't show.</sub>

<sub>An **adversarial read of those fixes** (2026-11-09, reading `9902ff4f` at `83965f37`) found
seven defects, each pinned by a failing test in
[test/model/model.adversarial-506.test.mjs](../test/model/model.adversarial-506.test.mjs) and
**all fixed 2026-11-10**, settled in
[ADR-0117](../docs/adr/0117-health-reports-count-only-what-they-checked.md) (§1, §3, §5) and
[ADR-0112](../docs/adr/0112-bucket-locks.md) step 4. Three deleted content a snapshot needed:
`cleanup`'s top-up treated a key it had listed but never read (gone under the scan, then
uploaded again with the same bytes) as known, so that snapshot's objects were deleted — it now
compares only against what the scan read; `cleanup` read a set whose snapshots were gone as
referencing nothing and deleted its whole store — it now refuses while any set has no
snapshots; and `cleanup` stopped reading snapshot files in a folder whose name isn't a set's
(`snapshots/photos_2025/`) — it reads every folder again, while `verify` and `list --remote`
keep to set names. Four health reports misled: `verify` said all verified when a set's marker
went with its snapshots (now s3cab's config copy names the set too); `verify` stayed at exit 1
forever once a set's snapshots were all forgotten (forgetting the last one now takes the set
out of the bucket); and `status` said `up to date` over another machine's snapshot under the
latest one's name (now byte for byte, ADR-0084) and over a snapshot taken after the clock went
back (now named as not backed up). **Suspicions, not proven:** `ownsWorkFile`'s `dev`/`ino`
check on a filesystem without stable file numbers (FAT, exFAT, SMB without file IDs, CIFS
`noserverino`) or after ext4 reuses a freed inode; a stat fault during a takeover still
unlinking the other run's work file (two faults at once); a store whose listed ETag doesn't
follow content turning the top-up back into a comparison by key; archive tiers listed under
other names by S3-compatible stores; ListObjectsV2's `OptionalObjectAttributes=RestoreStatus`
possibly letting `archived` clear on a restored copy without a HEAD per object; and a move east
with the clock set back, which the clock warning no longer fires on. Measured on Windows 11 and
NTFS only, with no real bucket.</sub>

<sub>Three **adversarial reads** (2026-11-14, Claude Fable 5.2 at xhigh, each reading `36798921`)
contributed the entries below marked with their read, each proved by a failing test or an exact
reproduction; the tests land with the fixes. None used a real bucket.</sub>

<sub>The **security read** (brief: where credentials and the Roles Anywhere keys are read, stored,
printed and sent, the modes of the files holding them, and what the identities `s3cab aws`
provisions may do; Windows 11 and WSL2) found twelve. **Sound**, measured or read: keys never
arrive as flags and the secret prompt echoes nothing; `provider` and `list` show the key ID's last
four characters and `list --json` never the secret; without `S3CAB_DEBUG` a rejected request
prints only the reply's code and message, and the debug argument dump holds no secret;
`pushSetConfig` never sends `env`, and `takeover` and `reattach` never write one; s3cab starts no
child process and never writes `~/.aws`; a set naming a profile signs in as it under exported
shell keys; on Linux the home, `roles-anywhere/`, `sets/` and each set folder are `700` and the
secret files `600` (umask `022`); the user template has no `AWS::IAM::AccessKey`, the Roles
Anywhere one embeds only the public CA certificate, and its role trusts one anchor by
`aws:SourceArn`; `bucketPolicy` grants exactly the calls `s3.mjs` makes, with no wildcard and no
`DeleteObjectVersion`; the client key is never sent; bucket and set names can't escape the home
(`assertPathSegment`); objects carry no host, user or path metadata; snapshot headers, lock files
and `forget`'s audit files hold no credential; a bucket snapshot name can't steer a download out
of the set's folder. **Suspicions, not run:** an in-place `restore` writes wherever a snapshot
written with a leaked key says, inside its own `@SET DIR`s (never over an existing file without
`--overwrite`); the default home on Windows is assumed owner-only by the profile's permissions,
unmeasured; `restore --overwrite` on Windows probably swaps a file's own permissions for its
folder's inherited ones; a `credential_process` can start with a set's secret in its environment
when a shell profile wins; S3's `ExpiredToken` and `InvalidToken` replies may echo the token under
`S3CAB_DEBUG` too. macOS not run.</sub>

<sub>The **read of [#512](https://github.com/allens/s3cab/pull/512) and
[#513](https://github.com/allens/s3cab/pull/513)** (brief: break each fix, and check each statement
#512 added to [guide/format.md](../guide/format.md) against the code; NTFS, and WSL2 on ext4 and
on the `/mnt` drives) found six and updated a seventh. Three are **fixed 2026-11-17**, pinned
in [src/commands/restore.downloads.test.mjs](../src/commands/restore.downloads.test.mjs),
[src/lib/walk.test.mjs](../src/lib/walk.test.mjs) and
[src/lib/snapshot.retargeted-root.test.mjs](../src/lib/snapshot.retargeted-root.test.mjs).
Restored from Linux onto a disk that ignores case, the second of two case twins was skipped or
written over the first, exit 0, since glibc's `realpath` spells a path as typed; and a twin of a
file another program had resized was no longer a collision, since the record was keyed by size.
Restore now tells a written file by its device and inode
([ADR-0086](../docs/adr/0086-restore-collision-filesystem-equivalence.md), amended), and
`realPath` in `src/lib/walk.mjs` spells each name of a member directory as its parent lists it.
And a member directory that is a link, pointed elsewhere during the walk, got a `@SET DIR` naming
the new target over rows under the old one; the walk now hands back the roots it read. **Held:** the hard-link landing refuses a
file, a folder, a file link, a dangling link, a junction and a case twin with `EEXIST` on NTFS,
ext4 and a `/mnt` drive; names Windows reserves or trims (`NUL`, `CON`, a trailing dot or space)
don't read as already there; a temp held open without delete-sharing lands the file, and a second
write over it is reported in the way, not an abort; a skip wins over a hash already missing or
withheld; a dedup copy from a landed file that changed, vanished or became a folder;
`assertWalkableDirs` through an 8.3 short name too; gzip streams joined into one text, and two
joined snapshots, a cut snapshot followed by a zero and other trailing bytes refused; the deletion
record's `.` end line across about thirty shapes; listing pages (2,500 snapshots, 1,200 records);
a file row equal to a `@SET DIR` refused across about twenty shapes; a file gone after its folder
is listed gets an `#error` row. **Suspicions, not run:** the landing's no-hard-link fallback on
FAT or exFAT (no such volume here) and `link`'s `EEXIST` on APFS are unmeasured; a file replaced
in the microseconds after it lands gets the snapshot's time and reads `restored`; NFS answering
`EEXIST` to a retried link that succeeded; `removeMade` removing an empty folder another program
made just before `mkdirSync`; a hand-edited `@SET DIR` with a doubled separator or a `.` segment
isn't matched against rows, which no spec sentence forbids.</sub>

<sub>The **read of the deletion paths** (brief: `cleanup`, `forget`, `delete`, `unlock`, and
backup's and upload's writes, deleting something a user still needs or misreporting what they
kept or removed; read cold from `src/commands.mjs`, no ADR; model tier) found five, all
**fixed 2026-11-16**, pinned in
[test/model/model.adversarial-deletes.test.mjs](../test/model/model.adversarial-deletes.test.mjs).
`upload --snapshot before-migration` published `snapshots/<set>/before-migration.tsv.gz`, which
no `cleanup` counts, so the objects only it named were deleted once the dated snapshots went.
`readSnapshot` now reads only a dated name, as the listing does, so `upload` refuses it (and
`--since` too), and `compare` no longer reads an undated file either. And a compaction that
kept no row wrote no file, freeing index 1 for a `delete`, whose record a second cleanup that
had listed the old index 1 then deleted: backups went on listing that file without storing
it. The merge is now written even empty, so the highest index never goes
([ADR-0090](../docs/adr/0090-deletion-record-format-compaction.md)). And `find --set` left out
the warning that content also backs a file in another set, so a `delete` of a hash it listed
removed that set's copy unwarned; the warning now reads every attached set in the bucket. And
forgetting a set's only snapshot took the set out of the bucket under a running backup of it,
which then published nothing; `forget` now takes the delete lock to take a set out, and keeps
the set while a backup of it runs ([ADR-0112](../docs/adr/0112-bucket-locks.md)). And two
cleanups, or two `delete`s, that crossed each said it deleted the same objects; S3's DELETE
answers alike whether or not the key was there, so the reports now say the objects are no
longer stored, which is true of both. **No
`cleanup` deleted an object a dated snapshot still names**, beside a backup on another machine or
killed partway. **Held:** cleanup's scan order against a snapshot published mid-scan; its top-up
under the lock (a new set, a key republished with the same or other bytes, a snapshot gone and
back, a missing ETag); its refusals (an unreadable, cut or refused snapshot, a damaged record,
missing objects, a set with no snapshots); the upload and delete locks in both orders, with
`--wait` and a dead process's lock; every delete in flight settling before the lock goes; a
backup's trust in its baseline; parked hashes feeding only hashing; a kill partway through
`backup`, `delete`, `cleanup` and `forget`; `forget` deleting only exact names checked against the
bucket, its retire never touching `snapshots/<set>/`; conditional snapshot PUTs; `upload --file
--force` hash-checked; `delete` taking only a full SHA-256 and refusing the empty file's; the
record's slot allocation under racing writers, and two compactions with no `delete` between;
`unlock` removing exactly the ids given. **Suspicions, not run:** `forget` retiring a set just as a
backup publishes would leave a snapshot with no holder or config; a `cleanup` failing while it
compacts says nothing of the orphans it already deleted; `delete --wait` counts from its check
before the wait; `cleanup` on a bucket with objects and no set takes every object for an orphan,
`upload --file --bucket` seeds included; a store answering 404 twice for a snapshot it holds would
have that snapshot's objects deleted (S3 doesn't); `removeRemoteSet` deletes every key under
`.s3cab/sets/<set>/`, whatever else might be there.</sub>

**Open:**

- **s3cab's home reached under a second path is backed up, keys and all,** when it isn't named
  `.s3cab` (review of [#523](https://github.com/allens/s3cab/pull/523)). `walkFiles` and
  `inHome` in `src/lib/walk.mjs` know the home by the one path `realPath` gives it, so a bind
  mount (`/mnt/me` over `/home/me`, home `/home/me/state`), a Windows folder mount of a lettered
  volume, or a share named two ways (`\\localhost\D$\Backups`) walks into it. Device and inode
  would catch it, except on mounts that number every entry 0, and cost a `stat` per folder in the
  walk. Unmeasured; rare.
- **On Windows, a home outside the user profile leaves every secret file open to other local
  users** (security read). The only protection is the POSIX mode (`envFileMode` in
  `src/lib/env-file.mjs`, `ensureMachineIdentity`, the `0700` folders in `src/lib/sets.mjs` and
  `src/lib/aws.mjs`), which Windows ignores, so the files inherit the folder's: on `D:`,
  `Authenticated Users:(I)(M)` on `client.key`, `ca.key` and each set's `env` (`icacls`). Another
  account can read the keys and rewrite a set's endpoint. [guide/aws.md](../guide/aws.md) and
  [guide/auth.md](../guide/auth.md) promise "owner-only" without naming Windows, and the comment
  on `envFileMode` assumes the profile's permissions.
- **"Can never permanently destroy" holds for 90 days** (security read).
  [guide/aws.md](../guide/aws.md) (twice) and [guide/maintenance.md](../guide/maintenance.md) say
  a leaked everyday key can't permanently destroy the backup, but that identity may `PutObject`
  and `DeleteObject` every key, and the bucket's lifecycle rule (`NONCURRENT_DAYS` in
  `src/lib/aws.mjs`) expires a replaced or deleted version after 90 days. Both pages give the 90
  days, but not as the limit of that promise, and a backup trusting its baseline never looks at
  stored objects, so only `verify` would notice. From the templates `s3cab aws` writes and S3's
  documented lifecycle.
- **A Roles Anywhere reply missing a credential field is printed with the secret** (security
  read). `parseSessionResponse` in `src/lib/roles-anywhere.mjs` throws with the whole body when a
  2xx reply lacks any of the four fields or isn't JSON, and `src/lib/auth.mjs` quotes it in the
  error every run prints. AWS sends no such reply today; something in between could.
  [guide/auth.md](../guide/auth.md): s3cab will never "Log a credential".
- **A set's saved keys mix with credentials the shell exports** (security read). `applyEnv` and
  `loadSet` in `src/lib/env.mjs` lay the set's `env` over the shell one variable at a time and
  clear nothing. An exported `AWS_PROFILE` wins over the set's keys, so the set runs as that
  profile against its own bucket: the notice line says so, but a failed sign-in blames "the
  access key from set 'photos' config" (`credentialsUsed`, `src/lib/auth.mjs`). An exported
  `AWS_SESSION_TOKEN` joins the set's keys and goes to the set's endpoint on every request,
  silently. [guide/auth.md](../guide/auth.md)'s "One mode per set, enforced" covers the set's
  file, not the shell. Windows and Linux.
- **`S3CAB_DEBUG` prints the session token** when a request signed with temporary credentials is
  rejected for its signature (security read). The debug print in `src/s3cab.mjs` dumps every
  field of the error, and the SDK copies the server's reply onto it: `CanonicalRequest`, with
  its signed `x-amz-security-token` header. Run against a stand-in server; that S3 echoes the
  canonical request is from knowledge of S3. [guide/auth.md](../guide/auth.md): never logged,
  "not under `S3CAB_DEBUG`".
- **A key to the bucket chooses what a machine taking a set over backs up** (security read).
  `takeover` (`src/commands/takeover.mjs`), on a machine with no `dirs.txt` or `exclude.txt` for
  the set, writes the bucket's copies without asking, and the everyday identity can write those
  keys. It prints the directory list and the holder's name, from a marker the same key can write,
  but not the exclude patterns. The behaviour is designed and pinned in `takeover.test.mjs`; the
  defect is [guide/aws.md](../guide/aws.md)'s security model, which says a leaked key "can add to
  your backup and tweak its own set markers" and doesn't count this.
- **An existing `env` keeps a loose mode when a secret is written into it** (security read).
  `updateEnvFile` and `removeEnvKey` in `src/lib/env-file.mjs` give `0600` only on creation, so an
  `env` an editor made at `0644` stays `0644` after `provider --keys`. Needs a set folder s3cab
  didn't make, since its own are `0700`. Linux.
- **`restore --overwrite` turns an owner-only file into one at the default mode** (security read).
  `writeFileAtomic` in `src/lib/atomic-file.mjs` renames a temp made with the default mode over
  the destination, so a `0600` file comes back `0644` under umask `022`.
  [guide/format.md](../guide/format.md)'s "permissions are what the system gives a new file"
  doesn't say an existing file's are replaced. Linux.
- **A leftover temp, once backed up, is reported restored and then removed** (read of
  #512/#513). `writeFileAtomic` removes whatever holds the temp's name before it writes, and the
  walk backs such a file up like any other. Since #513 a temp can outlive its run as a second hard
  link to the restored file (measured on Windows, with a holder that doesn't share delete), and an
  in-place restore then backs it up. NTFS lists a leading `.` first, so the temp's row lands first
  and is removed when its file lands: both read `restored`, one file is on disk. On a network
  share the real file isn't restored at all. What is lost is s3cab's own leftover; the report is
  wrong.
- **A file that arrives during its download and is gone a moment later is reported `skipped`,
  exit 0, with nothing on disk** (read of #512/#513). The `DestinationExistsError` branch of
  `restoreTargets` maps everything that isn't a folder or a file of this run's to `skipped`,
  nothing included. The window is microseconds.
- **One folder named twice in a set under two spellings isn't caught as an overlap** (read of
  #512/#513), so the snapshot holds every file twice: `walkDirs` in `src/lib/walk.mjs` stops only
  when it builds one path twice. Measured for `\\wsl.localhost\Ubuntu` and
  `\\wsl.localhost\ubuntu`, and `C:\…` with `\\localhost\C$\…`.
  [guide/format.md](../guide/format.md) says "a link, a junction or a difference in case can't
  make one directory two"; the second case is two server names, which it doesn't cover. An
  in-place restore reports the second row `skipped`, exit 0, where the spec says it "collides or
  restores twice"; nothing is lost. Unmeasured, a third: a Linux mount that ignores case and
  gives its folders one inode number (0 on some SMB and FUSE mounts). There `realPath` in
  `src/lib/walk.mjs` can't tell which folder `PHOTOS` is, so it keeps the name as typed:
  `Photos` and `PHOTOS` stay two, and in a set naming `PHOTOS` a link to `Photos/x` gets an
  `#error` row as outside the backup.
- **A link to a `.s3cab` folder, or into s3cab's home, typed in another case counts as backed
  up** on a Linux disk that ignores case (review of
  [#520](https://github.com/allens/s3cab/pull/520)). glibc's `realpath` keeps `.S3CAB` as
  typed, `backupMatcher` in `src/lib/walk.mjs` compares `.s3cab` and the home's path exactly,
  and `checkLink` rechecks with the disk's spelling only a target that seems outside.
  `walkFiles` skips the real folder, so the file the link points to is in no snapshot and no
  `#error` row says so. Unmeasured; rare.
- **A resumed restore on a mount that numbers every file 0 calls each existing file a
  collision** (review of [#521](https://github.com/allens/s3cab/pull/521)). `occupant` in
  `src/lib/restore.mjs` knows a file this run wrote by device and inode, and some SMB and FUSE
  mounts give every entry inode 0. Once the first file lands, every destination already there
  matches it: `collided`, exit 1, instead of `skipped`, and `--overwrite` replaces none. Loud,
  and nothing is lost. Unmeasured.
- **Zero bytes after a snapshot's gzip stream are mostly refused, where
  [guide/format.md](../guide/format.md) says they're ignored** (read of #512/#513).
  `readSnapshotFile` and `parseCompressedSnapshotStream` in `src/lib/snapshot-file.mjs` accept the
  padding only when it ends inside the chunk the stream ended in; otherwise a raw `ABORT_ERR`,
  `ERR_STREAM_PREMATURE_CLOSE` or `ECONNRESET`. Loud, and padded snapshots come only from a block
  or tape copy of a bucket.
- **A plain `http://` endpoint is accepted silently** (security read). `validateEndpoint` in
  `src/lib/provider.mjs` and `clientConfig` in `src/lib/s3.mjs` allow it "for a local provider",
  but nothing tells a local address from a remote one and no guide mentions `http`: file
  contents, snapshots and any session token travel in clear. The secret key never does.
- **`updateEnvFile` writes values unquoted** (security read), so a secret holding `#` or `$&`, or
  with a leading space, reads back different: `ab#cd` as `ab`, and `ab$&cd` as
  `abAWS_SECRET_ACCESS_KEY=firstcd`, the replacement pattern expanding. A sign-in that fails, not
  a leak.
- **`ca.key` is kept and nothing reads it** (security read). `ensureMachineIdentity` in
  `src/lib/roles-anywhere.mjs` writes it and `IDENTITY_FILES` checks it exists, and the module's
  comment says it "only re-issues client certs", which no code does. Whoever can read it can read
  `client.key` beside it; it adds the power to issue certificates the trust anchor accepts. Low.

- **[guide/format.md](../guide/format.md) lags three behaviours from the 2026-11-10 fixes**,
  frozen until real set 5's last restore: a set leaves the bucket with its last snapshot (the
  marker and `.s3cab/sets/<set>/` go too, and a clean-up must not read that as a lost set); a
  snapshot file in a folder beside a set's, whatever its name, still protects its objects from a
  clean-up (the spec says so only of a folder *below* a set's); and a clean-up's re-check under
  its lock reads every key it didn't read, by key and ETag.

- **A landed file removed before restore reads it back aborts the run with a raw `ENOENT`,**
  from the `lstat` in `restoreTargets` (`src/lib/restore.mjs`) that records the file's device and
  inode, rather than a per-file report. Needs something else writing in the output folder, and it
  is loud, so low.
- **In-place restore on Linux takes a `//server/share/x` row as absolute** (`isAbsolute` is true),
  where the refusal message promises it wouldn't be. `mkdir //server/share` fails `EACCES` for a
  non-root user and aborts the run; as root it would write under `/server/share/`. Exit nonzero.
- **A deleting machine's fast clock, or an `upload --snapshot` of an old snapshot, makes a later
  real loss read as deliberate.** A `#deleted` row explains an absence when its instant is later
  than every referencing snapshot's `START`, so a row dated after a backup that stored the
  content again — `delete` from a clock 10 minutes fast, then the holder's `backup` of the same
  file at true time +5; or an old snapshot uploaded after the delete — covers that object for
  good: lost afterwards, `verify` says "deleted … expected, not damage", exit 0, and `restore`
  exits 0 without it (the control at +15 reads `missing`). A `delete` whose DELETE pass fails
  after its record is written leaves the same shape, a row for a present object.
  [guide/format.md](../guide/format.md) and
  [ADR-0064](../docs/adr/0064-path-scoped-delete-deletion-record.md) say so; the fix is the
  record saying when content was stored again — a format change, open pre-1.0. Pinned as a
  `todo` in
  [test/model/model.durability-audit.test.mjs](../test/model/model.durability-audit.test.mjs).
  Run in the model tier, Windows and WSL.
- **A UTF-16 `exclude.txt` with LF endings silently matches nothing.** It is read as UTF-8, so
  every pattern is NUL-laden garbage: no `#excluded` row, exit 0, `tree --excluded` says "Nothing
  was excluded", and the `@CLIENT EXCLUDE` rows record the garbage. Nothing on the read path
  recognizes UTF-16 or a NUL. With CRLF endings the same file is refused, but only because the CR
  trips `unusableExcludeError`, whose message shows the patterns as spaced characters and advises
  writing `?`. Run on Windows and Linux.
- **A trailing `# comment` on a pattern line is part of the pattern.** `top.log # keep this out`
  matches nothing, silently. [guide/exclude.md](../guide/exclude.md) says only that lines starting
  with `#` are comments, so this is documented by implication. It is listed because a pattern a
  user reads as right does nothing, and no `#excluded` row is there to miss. Run on Linux.
- **`setup` accepts a member directory whose path holds a tab or a CR**, and every `backup`
  then refuses it. An LF splits the entry in `dirs.txt`, and a leading or trailing tab or CR
  is trimmed off, naming a different folder. Loud, so low.
- **`upload --dir` on a folder a snapshot can't name gives the wrong advice.** It doesn't meet
  `backup`'s member-directory check. A folder whose name holds a tab gets the per-file error,
  listing every file under it and suggesting a rename of those files or an exclude pattern,
  neither of which helps. A folder reached through a link whose real path has no UTF-8 form
  fails on a raw `ENOENT` from `scandir`. Loud, and only a seed, so low. Run in WSL.

The list must reach zero before a release to `latest`, at which point this file is deleted
rather than kept empty. Anything found before Issues open goes back in the list here.
