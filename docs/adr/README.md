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

### Architecture & CLI

- [0010](0010-cli-output-conventions.md) — CLI output: JSON.stringify, stream discipline, env-gated debug
- [0011](0011-validation-in-command-functions.md) — Argument validation lives in the command functions
- [0012](0012-consumer-vocabulary-naming.md) — Consumer-vocabulary command and flag naming
- [0013](0013-one-repository-one-bucket.md) — One s3cab repository == one bucket, fixed layout *(namespace shape partly superseded by 0024)*
- [0014](0014-backup-sets.md) — Backup sets are the unit of snapshot/backup/restore *(identity model partly superseded by 0024)*
- [0015](0015-standard-aws-credential-chain.md) — Standard AWS credential chain; bespoke SSO login removed
- [0022](0022-prepare-remote-set-front-door.md) — Env is loaded at the entry point; the set layer goes through the `loadSet` door
- [0023](0023-porcelain-plumbing-lib-layers.md) — Commands are porcelain or plumbing, over a shared lib
- [0024](0024-set-name-is-the-whole-identity.md) — A backup set's name is its whole identity
- [0025](0025-drop-per-bucket-env-layer.md) — Drop the per-bucket env layer (set > user > shell)
- [0026](0026-bucket-required-at-setup.md) — A bucket is required at setup; no local-only sets
- [0027](0027-compare-local-only-adoption-syncs-manifests.md) — `compare` is local-only; adoption syncs the manifests
- [0028](0028-snapshot-writer-owns-the-grammar.md) — The snapshot writer owns the grammar; the walk yields exclusions as data
- [0029](0029-eager-walk-not-streamed.md) — The walk materializes the full file set up front; it is not streamed into hashing
- [0030](0030-error-message-guidelines.md) — Error messages follow a fixed in-house standard
- [0031](0031-aws-profile-config-door.md) — `s3cab aws`: a profile-config door, with read-only `~/.aws` validation *(command name superseded by 0035 — now `profile`)*
- [0032](0032-generative-onboarding-not-active-provisioning.md) — Cloud onboarding is generative, not active
- [0033](0033-bucket-onboarding-security-model.md) — Bucket onboarding security model: a soft-delete everyday identity, versioning as backstop
- [0034](0034-bucket-command-shape.md) — The `bucket` command shape: a separate, generative cloud-onboarding command *(command name superseded by 0035 — now `aws`)*
- [0035](0035-aws-profile-sets-command-rationalization.md) — Rationalize `bucket`/`aws`/`setup`: `bucket`→`aws`, `aws`→`profile`, `setup` folds into `sets` *(point 3 superseded by 0036)*
- [0036](0036-setup-mutates-list-shows-drop-sets.md) — `setup` mutates a set, `list` shows sets; drop the `sets` command
- [0037](0037-aws-auth-error-categorization.md) — Request-time AWS auth errors are categorized by error code, not HTTP status
- [0038](0038-usage-error-synopsis-not-full-help.md) — Usage errors show the synopsis + the missing arg's description, not the full help block
- [0040](0040-restore-requires-set-name.md) — `restore` requires the set name; no sole-set default

### Build, release & tooling

- [0016](0016-native-executable-build.md) — Native executable via esbuild bundle + Node SEA
- [0017](0017-npm-ships-source.md) — The npm package ships source, not the bundle
- [0018](0018-dependabot-not-renovate.md) — Dependency updates via Dependabot, not Renovate
- [0019](0019-s3-test-strategy.md) — S3 test strategy: mock at s3.mjs, real-AWS gated, no emulator
- [0020](0020-coverage-review-not-gate.md) — Test coverage is judged by review, not a CI gate
- [0021](0021-lf-line-endings-prettier-code-only.md) — LF line endings; Prettier code only

## Map from old "design principle #N" references

The seven foundational principles were once numbered `#1`–`#7` in CLAUDE.md. Old references
(in code comments, specs, prose) map directly: **#1 → 0001, #2 → 0002, #3 → 0003, #4 → 0004,
#5 → 0005, #6 → 0006, #7 → 0007.**
