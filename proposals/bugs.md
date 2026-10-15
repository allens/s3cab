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
always true and are unchanged — `fileProps` formats from `stat.mtime.toISOString()`, so 674.000024ms
renders `.674Z`, a restored tree compares clean against its snapshot and re-backing it up re-uploads
nothing. Two things worth keeping. Run 2's C++ restorer set times through a nanosecond interface and
was **exact**: 1261 of its 1269 files differed from s3cab's own restore, the 8 matches being
precisely the `.000` values, so s3cab was the imprecise side and a spec demanding an exact match
would have asked other implementations to reproduce our defect. And the two runs agreeing to the
nanosecond was never corroboration — run 1's Python restorer went through the same float seconds, so
they shared the flaw. Only a comparison against the *stored* value could show it, which is the
argument for `compare.py` reading `st_mtime_ns`.</sub>

**Open:**

- **[guide/format.md](../guide/format.md) misstates how a deletion record is numbered.** It says
  each run "takes the lowest index not already in use"; `writeDeletionRecord`
  (`src/lib/deletion-record.mjs`) takes one past the highest, so after `cleanup` leaves only
  `-3`, the next record is `-4`, not `-1`. Readers are unaffected, since they union every record.
- **On Windows, an mtime outside 1970–2106 is recorded as the wrong date.** `statSync` wraps the
  seconds as an unsigned 32-bit value: set through .NET's `SetLastWriteTimeUtc`,
  `1969-12-31T23:59:59.0005Z` reads back as `2106-02-07T06:28:15.001Z` (`mtimeNs`
  `4294967295000500000n`, so `{ bigint: true }` doesn't help), 2200-12-31 as 2064-11-22, and
  9999-12-31 as 2106-01-28. Measured on NTFS under node 26.10.0. Linux reads 1969 and 2200
  correctly, and ext4 stops at 2446. A filesystem with 64-bit seconds (btrfs, untested) could
  still hold a year past 9999, which `toISOString` writes as `+010000-…`, 27 characters, a row
  s3cab's own reader refuses. The wrapped Windows value can't be told from a real date in range,
  so the fix may not be possible within builtins.
- **An mtime just under a half-millisecond tie rounds the wrong way.** `fileProps` formats
  `stat.mtime`, a `Date` built from the float `mtimeMs`, and near today's dates that float can't
  hold .4999ms, so it becomes .5 and rounds up: an NTFS mtime of 4999 ticks past the second is
  stored as `.001`, where [guide/format.md](../guide/format.md)'s nearest millisecond is `.000`.
  Only values within about one 100ns tick of a tie are affected, but a clean-room writer that
  rounds exactly disagrees with s3cab on them. Reading `{ bigint: true }` and rounding `mtimeNs`
  would be exact; its cost on the walk's hot path is unmeasured.
- **Column 2 is padded by UTF-16 units, not code points.** [guide/format.md](../guide/format.md)'s
  canonical form counts a character as a code point, as exclude.md's `?` does; `formatLine`
  (`src/lib/snapshot-file.mjs`) pads with `padEnd(64)`, which counts UTF-16 units, so an
  `#excluded` pattern or `#error` message holding an emoji is padded one space short per emoji.
  The file stays valid; only its canonical form is off.
- **A link into a `.s3cab` folder loses its target without a row.** `checkLink`
  (`src/lib/walk.mjs`) asks only whether the resolved target is in a member directory, so such a
  link gets no row, while the walk never enters `.s3cab`, so the target gets none either. Decided:
  treat it as a link out of the backup, an `#error`. The same PR changes
  [guide/format.md](../guide/format.md)'s Links table, whose "recorded where it lies" doesn't hold
  for it.
- **A crash can leave wrong bytes under an object's key.** `putFile` (`src/lib/s3.mjs`) hashes
  the bytes as they stream and, on a mismatch, deletes the object its no-clobber PUT just
  created. The object is visible in between, so a run killed there leaves bytes that don't hash
  to their key, which every later backup dedups against and every restore of that content
  fails on. [guide/format.md](../guide/format.md)'s Uploading rule says to leave nothing
  stored. The expected digest is known before the PUT, so sending it as
  `x-amz-checksum-sha256` would have S3 refuse the mismatch for a single-part upload; a
  multipart one could check its running hash before completing, and abort instead.
- **A killed run whose work file is cut inside a multi-byte character blocks every later
  backup of the set.** The tolerant read that recovers the work file
  (`readParkedLookup` → `parseSnapshotStream({ tolerant: true })`, `src/lib/snapshot-file.mjs`)
  decompresses with `Z_SYNC_FLUSH`, so it gets the bytes up to the cut, mid-row by design.
  `utf8Lines` ends with a strict `decoder.decode()` that tolerance never reaches: if the cut
  lands inside a character such as `é`, that last decode throws (`TypeError: The encoded data
  was not valid for encoding utf-8`, checked under node 26.10.0), surfacing as "Not an s3cab
  snapshot", and `readBaseline` (`src/lib/snapshot.mjs`) calls the read without a catch. The
  user has to delete the parked file by hand. Accented file names are common in photo
  libraries. A tolerant read should drop an undecodable tail, as it already drops the torn line.
  Not yet reproduced end to end.
- **"fits every frame to the terminal's width" fails in a checkout with a short path.** The test
  (`src/lib/snapshot.progress.test.mjs`) sets a 60-column terminal and asserts that some frame
  was cut short with `…`, on the premise that the temp directory's paths are longer than that.
  Under `D:\src\s3cab` the longest frame is about 55 columns, so nothing is cut and the test
  fails; CI's longer checkout paths hide it. A file name in the fixture long enough to overflow
  60 columns from any root would make the premise hold everywhere.

The list must reach zero before a release to `latest`, at which point this file is deleted
rather than kept empty. Anything found before Issues open goes back in the list here.
