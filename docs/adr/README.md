# Architecture Decision Records

Each file records one decision: *that* it was made and *why* (format: the `ADR-FORMAT.md` of the
`domain-modeling` skill from [mattpocock/skills](https://github.com/mattpocock/skills)).
Domain vocabulary lives in [CONTEXT.md](../../CONTEXT.md); fuller designs in
[docs/design/](../design/); AI-assistant working rules in [CLAUDE.md](../../CLAUDE.md).

New ADR: take the next number, `NNNN-slug.md`. Offer one only when a decision is **hard to
reverse**, **surprising without context**, and **the result of a real trade-off**.

Two concurrent branches will both take the same next number and both be right until the second
merges, so **uniqueness is checked in CI** ([test/adr-numbering.test.mjs](../../test/adr-numbering.test.mjs)) rather than
left to whoever notices. If it fails on your branch, the one that merged second yields: renumber
and move its citations.

Every ADR carries a `**Status:**` line directly under its title, starting with one of
`accepted`, `proposed`, or `partly superseded by NNNN` (trailing detail — a date,
`implemented`, what a supersession left standing — may follow). This adapts the status
vocabulary in
`ADR-FORMAT.md` (`proposed | accepted | deprecated | superseded by NNNN`); `partly superseded
by` is our own extension, since every supersession here has been partial. A superseded
decision is **never deleted**: its record is what stops the reversed choice being re-proposed,
so it stays in place with the status line (and, where the nuance matters, a top-of-file
banner) pointing forward to the ADR that replaced it. Read the status line before treating any
ADR as a live constraint.

## Index

> **Find the governing decision _before_ you change the code, not after.** For any structural
> change — module placement, a command's shape or name, auth/credentials, output/errors,
> snapshot/backup behaviour, the storage format — scan the matching group below and **read the
> ADR that owns it**. Two traps this index exists to prevent: (1) reasoning from memory and
> missing the ADR entirely (e.g. AWS module placement is governed by
> [0059](0059-aws-provisioning-boundary-static-imports.md)); (2) treating an ADR as more fixed
> than it is — read the ADR itself, since some leave explicit future doors open (e.g.
> [0032](0032-generative-onboarding-not-active-provisioning.md) records generative onboarding as
> the v1 choice with an optional active `--run` left open). A decision is a live constraint
> **unless its status line or body says otherwise**.

### Design philosophy (foundational)

- [0001](0001-file-level-content-addressable-dedup.md) — File-level content-addressable dedup with SHA-256
- [0002](0002-no-lock-in-hard-constraint.md) — No lock-in is a hard constraint
- [0003](0003-modern-open-tech-only.md) — Target modern tech, but only open standards
- [0004](0004-tsv-snapshot-manifests.md) — TSV snapshot files
- [0005](0005-builtins-over-dependencies.md) — Built-ins over dependencies
- [0006](0006-minimal-code.md) — Minimal, simple code — minimize total complexity
- [0007](0007-plain-js-via-jsdoc.md) — Plain JavaScript, typed via JSDoc *(accepted; the TS question closed 2026-07-18)*

### Licensing

- [0008](0008-gpl-3-license.md) — GPL-3.0-or-later license
- [0009](0009-cla-not-dco.md) — Contributions take a CLA, not a DCO

### Code & command structure

- [0011](0011-validation-in-command-functions.md) — Argument validation lives in the command functions
- [0012](0012-consumer-vocabulary-naming.md) — Consumer-vocabulary command and flag naming
- [0023](0023-porcelain-plumbing-lib-layers.md) — Commands are porcelain or plumbing, over a shared lib
- [0074](0074-referenced-enumeration-vocabulary-module.md) — The referenced-enumeration vocabulary (its typedefs, `isCorruptSnapshotError`, the bucket-wide helpers) lives in a zero-import `lib/referenced.mjs`, not with its producer `remote.mjs` — which reaches the AWS SDK, and the three planners consuming it import nothing *(accepted & implemented; applies 0023/0006)*

### CLI command surface & lifecycle

- [0034](0034-bucket-command-shape.md) — The `bucket` command shape: a separate, generative cloud-onboarding command *(command name superseded by 0035 — now `aws`)*
- [0035](0035-aws-profile-sets-command-rationalization.md) — Rationalize `bucket`/`aws`/`setup`: `bucket`→`aws`, `aws`→`profile`, `setup` folds into `sets` *(point 3 superseded by 0036; `profile` renamed again by 0041 and 0047 — now `provider`; point 1 amended by 0047 — `aws` is AWS-only; `--sso` fork dropped by 0056)*
- [0036](0036-setup-mutates-list-shows-drop-sets.md) — `setup` mutates a set, `list` shows sets; drop the `sets` command *(point 4 — no provider knobs on `setup` — reversed by 0055's implementation)*
- [0040](0040-restore-requires-set-name.md) — `restore` requires the set name; no sole-set default
- [0042](0042-verify-bucket-operand.md) — `verify` takes a bucket operand (symmetric with `cleanup`); reports per set *(objects-cache rewrite dropped by 0045; the finding-model correction landed 2026-07-05 and is folded into the ADR)*
- [0044](0044-upload-unified-command-surface.md) — Unify `upload` (`--file`/`--snapshot`/`--bucket`); `backup` = snapshot + upload; retire `backup --snapshot` *(implemented; companion to 0045; composition refined by 0069 — `backup` fuses the two into one pass rather than calling the commands in sequence)*
- [0052](0052-retire-setup-update-mode.md) — Retire `setup`'s update mode; a set's directories are edited in the public `dirs.txt` *(partly supersedes 0036 §2 — the upsert's update half)*
- [0053](0053-reattach-command.md) — Split `setup --inherit` into its own `reattach` command; `setup` is create-only *(resolves 0036's deferred "`--inherit` stays a flag" item)*
- [0054](0054-missing-member-dir-aborts.md) — A missing member directory aborts the run (fail, not skip); `dirs.txt` validated at walk time
- [0063](0063-forget-snapshots-delete-paths.md) — `forget` removes snapshots (renaming the old `delete`); `delete` moves to content removal *(implemented; the verb table stands, but the path-operand rationale for `delete` is superseded by 0089)*
- [0064](0064-path-scoped-delete-deletion-record.md) — Path-scoped `delete`: participating-set scope, the `deletions/` record, `--everywhere`, and the tool-wide destructive-command pattern (act by default, `-n` previews, non-TTY needs `--force`) *(mostly superseded by 0089/0090 — the confirmation tier, record-first ordering, destructive-command pattern and consumer semantics stand)*
- [0088](0088-find-matches-like-posix-find.md) — `find` searches local snapshots for a path: POSIX `find`'s anchoring (no separator → basename, a separator → floating whole path, trailing → subtree) over `compileExclude`'s token grammar, both compilers sharing `lib/path-match.mjs`; case keys on the path's shape, two passes bound the dedup scan, output is one hash per line with the context in `#` comments *(accepted & implemented; joins 0027's local-only browse commands, follows 0062. `*` stays one-or-more, diverging from POSIX. The hash-operand `delete` it feeds is 0089)*
- [0089](0089-hash-operand-delete.md) — `delete` takes content hashes, fed by `find` (positional or `--from-file`; no piping): an irreversible bucket-wide delete must not take a fuzzy operand, so the fuzzy step moved into the read-only `find` and no scope narrower than everywhere remains. Preflight HEAD per hash (missing → reported and skipped, `ContentLength` fills the record's size column), hard refusal on the empty-file hash, confirmation unchanged from 0064, `delete` keeps the verb (`purge` the runner-up) *(accepted & implemented; supersedes 0063's `delete` rationale and most of 0064; the record is 0090)*

### Output, errors & rendering

- [0010](0010-cli-output-conventions.md) — CLI output: JSON.stringify, stream discipline, env-gated debug *(stdout default inverted by 0043 — JSON now behind `--json`)*
- [0030](0030-error-message-guidelines.md) — Error messages follow a fixed in-house standard
- [0037](0037-aws-auth-error-categorization.md) — Request-time AWS auth errors are categorized by error code, not HTTP status
- [0038](0038-usage-error-synopsis-not-full-help.md) — Usage errors show the synopsis + the missing arg's description, not the full help block
- [0043](0043-human-first-output.md) — Human-first output; `--json` for machines; a central render layer *(implemented; inverts 0010's stdout default)*
- [0075](0075-resolve-time-credential-expiry.md) — An expired sign-in is diagnosed at *resolve* time too, matched on the chain's message (the SDK's error name can't tell expiry from a missing profile); expiry only, and one message shared with the request-time path *(accepted & implemented; completes 0037's remedy table, which caught expiry only at request time)*
- [0076](0076-one-progress-line-driven-by-a-clock.md) — One progress line per pass, paced by `lib/progress.mjs` rather than by per-caller count gates, and redrawn from a clock where the data is bursty or blocking (a LIST page, a pull pipeline). The porcelain announces the pass once so the line carries no constant text; a row earns its name by taking a second, and a figure is shown only once measured *(accepted; extends 0010/0043, settles the display 0069 left behind)*
- [0078](0078-backup-run-report.md) — What a finished backup reports: in **files**, not objects; `backup` prints in full only what it alone knows (transfer, times, drift) while everything the snapshot holds is a count plus a copy-pasteable `compare` command; a `Changes since <baseline>` block beside a `Couldn't be backed up` one; the detail offered by prompt and computed once, so counts and listing cannot diverge *(extends 0043/0076 to the finished run)*
- [0079](0079-previously-unreadable-file-is-an-annotated-addition.md) — A file the older snapshot couldn't hash reports as **added, annotated** `(was unreadable in <since>)` rather than as a new file: the content really did reach the store on this run, so the category stays and the note corrects the reading, as `(duplicate of …)` already does. It can never be a move destination; unreadable-then-gone is reported nowhere *(applies 0043; settled ahead of 0069's `#ERROR`-on-drift follow-up, which would make it routine)*
- [0080](0080-exclusion-review-from-the-walk.md) — `tree --excluded` answers "what are my patterns dropping?" from a **live walk**, not from a snapshot's `#EXCLUDED` rows (which are written but never read back) — so an `exclude.txt` edit can be checked by re-running. One flag, not two: the pattern rides on every row, making "why is *this* excluded?" a `grep`. stdout is `<path>` TAB `<pattern>`, stderr a count per pattern *(accepted & implemented; applies 0010/0043, uses the records 0028 already hands back)*

### Storage model, identity & home

- [0013](0013-one-repository-one-bucket.md) — One s3cab repository == one bucket, fixed layout *(namespace shape partly superseded by 0024)*
- [0014](0014-backup-sets.md) — Backup sets are the unit of snapshot/backup/restore *(identity model partly superseded by 0024)*
- [0024](0024-set-name-is-the-whole-identity.md) — A backup set's name is its whole identity
- [0026](0026-bucket-required-at-setup.md) — A bucket is required at setup; no local-only sets
- [0039](0039-home-is-dot-s3cab-not-xdg.md) — The s3cab home is `~/.s3cab` on every OS, not XDG or AppData

### Snapshot / backup / restore engine

- [0027](0027-compare-local-only-adoption-syncs-manifests.md) — `compare` is local-only; adoption syncs the manifests
- [0028](0028-snapshot-writer-owns-the-grammar.md) — The snapshot writer owns the grammar; the walk yields exclusions as data
- [0029](0029-eager-walk-not-streamed.md) — The walk materializes the full file set up front; it is not streamed into hashing
- [0077](0077-walk-does-not-stat.md) — The walk yields paths and does not `stat` them (~7s → ~1 min on Windows). Sizes for progress come free from the previous snapshot; rename detection, the one benefit that needed the stat, doesn't pay for the format change since a rename already costs one local re-hash and no network; and statting early would record a walk-time mtime against hash-time content, silently poisoning the reuse check *(accepted; sits beside 0029, whose `resolveFileType` fallback is the one exception)*
- [0045](0045-change-detection-local-baseline-list-fallback.md) — Change detection: drop the objects cache; baseline = local snapshot + on-demand LIST + conditional-PUT backstop *(engine implemented; companion to 0044)*
- [0069](0069-fused-snapshot-upload-pipeline.md) — `backup` fuses snapshot generation and upload into one streaming pass: each object is PUT milliseconds after its bytes are hashed, via one pass-through stage in the writer's pipeline (a pipe, not a callback). Collapses the drift window, deletes the write-then-re-read round trip, and makes a failed transfer a cheap retry *(accepted & implemented; refines 0044's composition, keeps 0045 intact, rides inside 0048/0067)*
- [0048](0048-snapshot-lock-atomic-temp-file.md) — Snapshot concurrency lock: the temp file created atomically (`wx`); stale locks removed manually
- [0067](0067-park-hashes-on-interrupt.md) — A graceful interrupt parks the snapshot's work file as `.snapshot.lookup.tsv.zst` for the next run to reuse; reading needs no liveness check (size+mtime re-validation), so 0048's lock is untouched *(accepted & implemented; SIGKILL/power-loss out of scope by design)*
- [0050](0050-default-exclude-git-with-disclosure.md) — A new set defaults `.git` (and `._*`/`desktop.ini`) out; `setup` lists every skipped pattern so the default isn't silent
- [0051](0051-native-separator-in-user-path-files.md) — User-facing path files (the starter `exclude.txt`) use the native separator; `/` stays an internal matching form
- [0061](0061-debug-only-uncompressed-snapshot-sidecar.md) — The uncompressed `.snapshot.tsv` sidecar stays `S3CAB_DEBUG`-only; no-lock-in is already met by the standard `.tsv.zst` *(accepted; applies 0002/0006)*
- [0062](0062-bulk-operands-positional-addressing-by-flag.md) — Bulk operands are positional, addressing moves to `--set`/`-S` (`delete`/`restore`/`setup`); `-s` stays `--snapshot` *(accepted & implemented — PR #215; answers 0040's deferred question; design in docs/design/snapshot-deletion.md)*
- [0060](0060-multipart-tuning-in-flight-bytes.md) — Multipart tuning: 16 MiB parts × 32 concurrent (512 MiB in flight); bytes in flight are the lever, more streams beat bigger parts, and the unset `queueSize` (lib-storage's 4) was the real culprit *(accepted & implemented; measured from three network distances — benchmark kept as an ad-hoc script)*
- [0065](0065-s3-client-request-timeouts.md) — S3 client request + connection timeouts so a dropped connection fails (a retryable `TimeoutError`) instead of hanging forever; the default handler set none. Reasoned, not measured — the value only sets how long a dead link waits *(accepted & implemented; hardens 0059/0060)*
- [0068](0068-network-retries-above-the-sdk.md) — Transport failures are retried *above* the SDK on a 120 s time window, because the SDK's retry budget is a client-wide token bucket that gives a ≥512 MB file only ~0.2 s of tolerance and makes `maxAttempts` inert; throttling/5xx keep stock SDK behaviour *(accepted & implemented; completes 0065's open items, extends 0037's relay)*
- [0066](0066-glacier-ir-storage-tier.md) — Upload straight to Glacier Instant Retrieval, the cheapest instant-access tier, set in the data plane (not a CF lifecycle transition); replaces Intelligent-Tiering, whose 128 KB floor stranded small objects at Standard price *(accepted & implemented; reverses the proposals/storage-tiers.md steer; archive tiers still deferred)*
- [0070](0070-snapshot-restore-fidelity.md) — Snapshots record content, size and mtime, regular files only: no symlinks, hardlink identity, empty directories, permissions or ACLs — s3cab backs up data, not systems, and a content-addressed store has nothing to hang path metadata on *(accepted; makes format.md's description deliberate)*
- [0071](0071-snapshot-paths-absolute-native.md) — Snapshot paths stay absolute and OS-native (the snapshot is a statement of record; the row must stand alone for hand recovery); portability is `restore --output`, whose re-rooting is already separator-agnostic *(accepted; extends 0004, settles the relative-paths and cross-platform-restore questions)*
- [0072](0072-timestamps-utc-in-files-local-in-names.md) — Timestamps split by kind: full UTC instants inside files (mtime, `#SNAPSHOT`, record headers, `CREATED`), local wall clock in names. The `#SNAPSHOT` line widens to carry set, instant, and its own name + IANA zone; the lexical-sort fault in the DST fold and across timezone moves is accepted, with warn-only checks where it is created *(accepted; extends 0004, applies 0012; its pre-0072 compatibility reader withdrawn 2026-08-08)*
- [0073](0073-refuse-tab-newline-paths.md) — Paths containing a tab or newline are refused and abort the walk, listing every offender; `exclude.txt` is the escape hatch. Aborting is the only option that never writes the path into the TSV, so no escaping scheme is needed *(accepted; closes 0004's open edge case, applies 0054/0010)*
- [0081](0081-online-only-files-skipped.md) — A dehydrated cloud placeholder (Windows Files On-Demand: OneDrive, Dropbox, Google Drive) is left online and reported as an `Online-Only File` skip, so a first backup stops silently hydrating a whole cloud account onto the local disk. Detected by `size >= 4096 && blocks === 0` on the `lstat` `fileProps` already takes — the 4KB floor clears NTFS's MFT-resident small files — checked *after* the baseline reuse, and confined to Windows because a fully sparse ext4 file is the identical shape; `--include-online-only` opts in *(accepted & implemented; routes through 0078's skip channel, applies 0030/0012; macOS ruled out on measurement — APFS collides the same way, and its real signal `SF_DATALESS` isn't in Node's `Stats`)*
- [0082](0082-snapshot-end-trailer.md) — Every snapshot closes with a bare `#END` trailer line, and a parse that ends without one throws: zstd decompresses a cut-short stream to a clean byte prefix, so a truncated manifest read as a valid smaller-or-empty snapshot and `verify` vouched for a destroyed one. The failure is an `AssertionError` so `isCorruptSnapshotError` routes it into the existing unreadable-snapshot finding; content after `#END` stays legal (truncation can't produce it) *(accepted & implemented; extends 0004, rides 0074's channel; no pre-0082 compatibility reader — pre-1.0 policy)*
- [0083](0083-streamed-digest-upload-guard.md) — Object uploads are held to their digest: `putFile` hashes the bytes it actually streams (a tap on the one body being sent, never a re-read) and, given the caller's expected `sha256` — under `objects/` the key *is* the digest — a mismatch deletes the just-stored object and throws `ContentMismatchError`, which `uploadObjects` records as an ordinary `"changed"` drift. Closes the PUT-start→PUT-end window where a file rewritten mid-transfer was stored as wrong bytes under a right hash, silently and permanently *(accepted & implemented; completes 0069's drift guard, reports through its channel)*
- [0084](0084-snapshot-identity-byte-equality.md) — A remote snapshot is "ours" only if byte-identical to the local file (`matchRemoteSnapshot`: identical / different / absent) — snapshot *names* are minute-resolution wall clock, so a name's mere presence proves nothing about authorship, and ETags can't arbitrate on S3-compatible stores. `storedHashes` trusts the baseline only on identical (else warns and LISTs the store); `uploadSnapshotFile` treats a 412 over identical bytes as quiet success (the lost-response retry meeting its own first attempt), keeping the immutability error for genuinely different content *(accepted & implemented; refines 0045's trust check, closes the cross-machine same-name vouching and manifest self-412 audit findings)*
- [0085](0085-ctime-cross-check-on-hash-reuse.md) — A size+mtime baseline match is reused only if the file's ctime predates the baseline's `#SNAPSHOT` instant: `size` and `mtime` are settable from userland, so a `touch -r`-shaped same-size rewrite (or FAT32's 2-second timestamps) carried the old hash forward against new bytes, while ctime can't be set back — the rewrite, and the `utimes` call itself, bump it. No format change and no extra syscall (the one `lstat` already carries `ctimeMs`); a dehydrated placeholder is exempt (dehydration moves *only* ctime, and 0081 depends on its reuse); no baseline instant → old semantics; self-healing after one re-hash *(accepted & implemented; tightens 0045's reuse rule, preserves 0081; FAT32's missing change time stays with `--rehash`)*
- [0086](0086-restore-collision-filesystem-equivalence.md) — `restore` detects two manifest paths this volume folds into one file (letter case, APFS Unicode normalization) by the **filesystem's own equivalence** — each written file's `realpathSync.native` is recorded, and a later target that already exists and canonicalizes into that record is reported `collided`, never written, with exit 1 — never by string lowercasing, which hard-codes one folding where the volume's is the ground truth. A dedupe copy whose source row collided re-fetches from the store (copying from the name would duplicate the survivor's wrong bytes) *(accepted & implemented; extends 0064's report-then-exit split; closes the silent last-wins finding from the model-based hostile suite)*
- [0087](0087-deletion-record-suffix-on-collision.md) — A deletion record whose minute-precision name is taken retries under `<name>-2`, `-3`, … instead of failing; the PUT stays conditional and the `S3CAB_DEBUG` overwrite escape is removed *(superseded by 0090 — record names make no time claim any more; the conditional-PUT walk-up survives as 0090's slot allocator, and its "refusal buys a record nothing" finding stands)*
- [0090](0090-deletion-record-format-compaction.md) — The deletion record is a tombstone, not a ledger: root-level indexed `objects.deleted-<n>.tsv` files, never overwritten (LIST → next free index → conditional PUT, walking upward on a race), rows `hash / size / instant / user@machine` with **no paths** (the reader holds the snapshot; compaction destroys filenames, so when/who live in rows), `#DELETED` header and a bare `#END` (one atomic uncompressed PUT — `PARTIAL` cannot occur). `cleanup` compacts and trims in one operation behind its interlocks: union the rows, drop those no snapshot references, write the merge to a fresh index *before* deleting the absorbed files. Trimming is safe because every consumer reaches the record through a snapshot referencing the hash — backup included, whose baseline is trusted only while byte-identical remotely (0084), making it a live reference. A single rolled-up file was rejected: read-modify-write can lose rows, and a lost row is silent corruption (backup keeps trusting a baseline vouching for deleted content); the fix needs `If-Match`, not universal on S3-compatible stores *(accepted & implemented; supersedes 0064's record shape and all of 0087; the command is 0089)*

### Auth, credentials & connection config

- [0015](0015-standard-aws-credential-chain.md) — Standard AWS credential chain; bespoke SSO login removed
- [0022](0022-prepare-remote-set-front-door.md) — The set layer goes through the `loadSet` door *(amended twice: 0055 dropped the user layer, then the entry-point `loadEnv` + its `client()` tripwire were retired with it)*
- [0025](0025-drop-per-bucket-env-layer.md) — Drop the per-bucket env layer (set > user > shell)
- [0031](0031-aws-profile-config-door.md) — `s3cab aws`: a profile-config door, with read-only `~/.aws` validation *(command name superseded by 0035, 0041, then 0047 — now `provider`)*
- [0041](0041-auth-command-hosts-credential-guide.md) — Rename `profile` → `auth`; the command hosts the credential guide *(name superseded by 0047 — now `provider`)*
- [0047](0047-provider-command-neutral-config-door.md) — `provider`: the neutral connection-config door (profile/endpoint/region/keys); `aws` narrows to AWS-only
- [0055](0055-per-set-credentials-one-mode.md) — Per-set credentials: drop the user env layer (set > shell); each set is one credential mode (profile XOR keys XOR ambient) *(implemented; partly supersedes 0025, amends 0022)*

### AWS onboarding & the provisioning boundary

- [0032](0032-generative-onboarding-not-active-provisioning.md) — Cloud onboarding is generative, not active *(delivery form amended by 0056 — a CloudFormation template, still generative; an active `--run` is left open, not built)*
- [0033](0033-bucket-onboarding-security-model.md) — Bucket onboarding security model: a soft-delete everyday identity, versioning as backstop *(refined by 0056 — managed policy, SSE-S3, DeletionPolicy Retain)*
- [0056](0056-onboarding-via-cloudformation.md) — Cloud onboarding emits CloudFormation templates (still generative); `--sso` retired *(accepted & built; amends 0032/0033/0035)*
- [0057](0057-roles-anywhere-credential-mode.md) — Roles Anywhere: a fourth credential mode, set up generatively (CloudFormation) and signed natively (SigV4-X509) *(accepted & implemented — both setup and the runtime signer ship; beside 0055/0015; design in docs/design/roles-anywhere.md)*
- [0058](0058-roles-anywhere-cert-generation.md) — Roles Anywhere certs: hand-rolled ASN.1 DER (zero-dep), client key stored as a 0600 PEM (pins the Phase B signer's key interface) *(accepted — cert generator validated by live spike; resolves 0057's open cert-gen/storage sub-decision)*
- [0059](0059-aws-provisioning-boundary-static-imports.md) — AWS provisioning (CloudFormation/IAM) is quarantined to the `aws` command; data plane is S3-only, auth is the pluggable seam; placement (an aws-only module), not a lazy `import()`, keeps its heavy dep off the hot path — no blanket ban on dynamic imports *(accepted & implemented; extends 0015/0056/0057, applies 0006)*

### Build, release & tooling

- [0016](0016-native-executable-build.md) — Native executable via esbuild bundle + Node SEA
- [0017](0017-npm-ships-source.md) — The npm package ships source, not the bundle
- [0018](0018-dependabot-not-renovate.md) — Dependency updates via Dependabot, not Renovate
- [0019](0019-s3-test-strategy.md) — S3 test strategy: mock at s3.mjs, real-AWS gated, no emulator
- [0020](0020-coverage-review-not-gate.md) — Test coverage is judged by review, not a CI gate
- [0021](0021-lf-line-endings-prettier-code-only.md) — LF line endings; Prettier code only
- [0046](0046-test-layout-colocated-tier-suffix.md) — Test layout: co-located; integration is a `*.integration.test.mjs` suffix; e2e is the subprocess suite in `test/` *(integration placement + skip flag superseded by 0049; unit co-location stands)*
- [0049](0049-centralize-cross-cutting-test-tiers.md) — Centralize the cross-cutting test tiers (integration in `test/integration/`, e2e as its file); co-locate only unit; drop the skip flag for a hard-fail; per-platform real-S3 round-trip at release

## Map from old "design principle #N" references

The seven foundational principles were once numbered `#1`–`#7` in CLAUDE.md. Old references
(in code comments, specs, prose) map directly: **#1 → 0001, #2 → 0002, #3 → 0003, #4 → 0004,
#5 → 0005, #6 → 0006, #7 → 0007.**
