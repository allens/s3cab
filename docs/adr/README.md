# Architecture Decision Records

Each file records one decision: *that* it was made and *why* (format: the `ADR-FORMAT.md` of the
`domain-modeling` skill from [mattpocock/skills](https://github.com/mattpocock/skills)).
Domain vocabulary lives in [CONTEXT.md](../../CONTEXT.md); fuller designs in
[docs/design/](../design/); AI-assistant working rules in [CLAUDE.md](../../CLAUDE.md).

New ADR: take the next number, `NNNN-slug.md`. Offer one only when a decision is **hard to
reverse**, **surprising without context**, and **the result of a real trade-off**.

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
- [0007](0007-plain-js-via-jsdoc.md) — Plain JavaScript, typed via JSDoc *(proposed/open)*

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
- [0036](0036-setup-mutates-list-shows-drop-sets.md) — `setup` mutates a set, `list` shows sets; drop the `sets` command
- [0040](0040-restore-requires-set-name.md) — `restore` requires the set name; no sole-set default
- [0042](0042-verify-bucket-operand.md) — `verify` takes a bucket operand (symmetric with `cleanup`); reports per set *(objects-cache rewrite dropped by 0045; the finding-model correction landed 2026-07-05 and is folded into the ADR)*
- [0044](0044-upload-unified-command-surface.md) — Unify `upload` (`--file`/`--snapshot`/`--bucket`); `backup` = snapshot + upload; retire `backup --snapshot` *(implemented; companion to 0045; composition refined by 0069 — `backup` fuses the two into one pass rather than calling the commands in sequence)*
- [0052](0052-retire-setup-update-mode.md) — Retire `setup`'s update mode; a set's directories are edited in the public `dirs.txt` *(partly supersedes 0036 §2 — the upsert's update half)*
- [0053](0053-reattach-command.md) — Split `setup --inherit` into its own `reattach` command; `setup` is create-only *(resolves 0036's deferred "`--inherit` stays a flag" item)*
- [0054](0054-missing-member-dir-aborts.md) — A missing member directory aborts the run (fail, not skip); `dirs.txt` validated at walk time
- [0063](0063-forget-snapshots-delete-paths.md) — `forget` removes snapshots (renaming the old `delete`); `delete` moves to path-scoped content removal *(implemented; the `--set` addressing line is amended by 0064 — `delete` addresses the bucket)*
- [0064](0064-path-scoped-delete-deletion-record.md) — Path-scoped `delete`: participating-set scope, the `deletions/` record, `--everywhere`, and the tool-wide destructive-command pattern (act by default, `-n` previews, non-TTY needs `--force`) *(amends 0063's shape line; the cleanup/forget conversion to the pattern is follow-up work)*

### Output, errors & rendering

- [0010](0010-cli-output-conventions.md) — CLI output: JSON.stringify, stream discipline, env-gated debug *(stdout default inverted by 0043 — JSON now behind `--json`)*
- [0030](0030-error-message-guidelines.md) — Error messages follow a fixed in-house standard
- [0037](0037-aws-auth-error-categorization.md) — Request-time AWS auth errors are categorized by error code, not HTTP status
- [0038](0038-usage-error-synopsis-not-full-help.md) — Usage errors show the synopsis + the missing arg's description, not the full help block
- [0043](0043-human-first-output.md) — Human-first output; `--json` for machines; a central render layer *(implemented; inverts 0010's stdout default)*
- [0075](0075-resolve-time-credential-expiry.md) — An expired sign-in is diagnosed at *resolve* time too, matched on the chain's message (the SDK's error name can't tell expiry from a missing profile); expiry only, and one message shared with the request-time path *(accepted & implemented; completes 0037's remedy table, which caught expiry only at request time)*
- [0076](0076-one-progress-line-driven-by-a-clock.md) — One progress line per pass, paced by `lib/progress.mjs` rather than by per-caller count gates, and redrawn from a clock where the data is bursty or blocking (a LIST page, a pull pipeline). The porcelain announces the pass once so the line carries no constant text; a row earns its name by taking a second, and a figure is shown only once measured *(accepted; extends 0010/0043, settles the display 0069 left behind)*

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
- [0062](0062-bulk-operands-positional-addressing-by-flag.md) — Bulk operands are positional, addressing moves to `--set`/`-S` (`delete`/`restore`/`setup`); `-s` stays `--snapshot` *(accepted, not yet implemented; answers 0040's deferred question; design in docs/design/snapshot-deletion.md)*
- [0060](0060-multipart-tuning-in-flight-bytes.md) — Multipart tuning: 16 MiB parts × 32 concurrent (512 MiB in flight); bytes in flight are the lever, more streams beat bigger parts, and the unset `queueSize` (lib-storage's 4) was the real culprit *(accepted & implemented; measured from three network distances — benchmark kept as an ad-hoc script)*
- [0065](0065-s3-client-request-timeouts.md) — S3 client request + connection timeouts so a dropped connection fails (a retryable `TimeoutError`) instead of hanging forever; the default handler set none. Reasoned, not measured — the value only sets how long a dead link waits *(accepted & implemented; hardens 0059/0060)*
- [0068](0068-network-retries-above-the-sdk.md) — Transport failures are retried *above* the SDK on a 120 s time window, because the SDK's retry budget is a client-wide token bucket that gives a ≥512 MB file only ~0.2 s of tolerance and makes `maxAttempts` inert; throttling/5xx keep stock SDK behaviour *(accepted & implemented; completes 0065's open items, extends 0037's relay)*
- [0066](0066-glacier-ir-storage-tier.md) — Upload straight to Glacier Instant Retrieval, the cheapest instant-access tier, set in the data plane (not a CF lifecycle transition); replaces Intelligent-Tiering, whose 128 KB floor stranded small objects at Standard price *(accepted & implemented; reverses the proposals/storage-tiers.md steer; archive tiers still deferred)*
- [0070](0070-snapshot-restore-fidelity.md) — Snapshots record content, size and mtime, regular files only: no symlinks, hardlink identity, empty directories, permissions or ACLs — s3cab backs up data, not systems, and a content-addressed store has nothing to hang path metadata on *(accepted; makes format.md's description deliberate)*
- [0071](0071-snapshot-paths-absolute-native.md) — Snapshot paths stay absolute and OS-native (the snapshot is a statement of record; the row must stand alone for hand recovery); portability is `restore --output`, whose re-rooting is already separator-agnostic *(accepted; extends 0004, settles the relative-paths and cross-platform-restore questions)*
- [0072](0072-timestamps-utc-in-files-local-in-names.md) — Timestamps split by kind: full UTC instants inside files (mtime, `#SNAPSHOT`, record headers, `CREATED`), local wall clock in names. The `#SNAPSHOT` line widens to carry set, instant, and its own name + IANA zone; the lexical-sort fault in the DST fold and across timezone moves is accepted, with warn-only checks where it is created *(accepted; extends 0004, applies 0012)*
- [0073](0073-refuse-tab-newline-paths.md) — Paths containing a tab or newline are refused and abort the walk, listing every offender; `exclude.txt` is the escape hatch. Aborting is the only option that never writes the path into the TSV, so no escaping scheme is needed *(accepted; closes 0004's open edge case, applies 0054/0010)*

### Auth, credentials & connection config

- [0015](0015-standard-aws-credential-chain.md) — Standard AWS credential chain; bespoke SSO login removed
- [0022](0022-prepare-remote-set-front-door.md) — Env is loaded at the entry point; the set layer goes through the `loadSet` door
- [0025](0025-drop-per-bucket-env-layer.md) — Drop the per-bucket env layer (set > user > shell)
- [0031](0031-aws-profile-config-door.md) — `s3cab aws`: a profile-config door, with read-only `~/.aws` validation *(command name superseded by 0035, 0041, then 0047 — now `provider`)*
- [0041](0041-auth-command-hosts-credential-guide.md) — Rename `profile` → `auth`; the command hosts the credential guide *(name superseded by 0047 — now `provider`)*
- [0047](0047-provider-command-neutral-config-door.md) — `provider`: the neutral connection-config door (profile/endpoint/region/keys); `aws` narrows to AWS-only
- [0055](0055-per-set-credentials-one-mode.md) — Per-set credentials: drop the user env layer (set > shell); each set is one credential mode (profile XOR keys XOR ambient) *(implemented; partly supersedes 0025, amends 0022)*

### AWS onboarding & the provisioning boundary

- [0032](0032-generative-onboarding-not-active-provisioning.md) — Cloud onboarding is generative, not active *(delivery form amended by 0056 — a CloudFormation template, still generative; an active `--run` is left open, not built)*
- [0033](0033-bucket-onboarding-security-model.md) — Bucket onboarding security model: a soft-delete everyday identity, versioning as backstop *(refined by 0056 — managed policy, SSE-S3, DeletionPolicy Retain)*
- [0056](0056-onboarding-via-cloudformation.md) — Cloud onboarding emits CloudFormation templates (still generative); `--sso` retired *(proposed; amends 0032/0033/0035)*
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
