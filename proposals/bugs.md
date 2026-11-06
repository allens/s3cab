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

**Open:**

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
- **NTFS alternate data streams aren't backed up, and the guide doesn't say so.** Only a file's
  main stream is read: exit 0, and no row for the stream. [guide/backup.md](../guide/backup.md)
  says everything under each directory is backed up, and no page in `guide/` mentions streams.
  Low harm, since `Zone.Identifier` is the common one, but that sentence needs a carve-out. Run on
  Windows.

The list must reach zero before a release to `latest`, at which point this file is deleted
rather than kept empty. Anything found before Issues open goes back in the list here.
