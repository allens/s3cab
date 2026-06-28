# Rationalize `bucket`/`aws`/`setup`: `bucket`→`aws`, `aws`→`profile`, `setup` folds into `sets`

Status: **accepted and implemented** (design decided via a `/grilling` session 2026-06-27;
implemented in #122). **Point 3 below (folding `setup` into `sets`) is since superseded by
[0036](0036-setup-mutates-list-shows-drop-sets.md)**: the `sets` command built here is to be
*dropped*, with `setup` revived as the set-mutation verb and listing moved to `list` (that
reshaping is tracked in
[proposals/cli-command-rationalization.md](../../proposals/cli-command-rationalization.md)).
Points 1–2 (`bucket`→`aws`, old-`aws`→`profile`) stand as shipped.

Three commands existed for getting s3cab usable before real backup work: `setup` (create/update/
inherit a backup set, [docs/specs/backup.md](../specs/backup.md)), `aws` (point s3cab at an AWS
profile, [0031](0031-aws-profile-config-door.md)), and `bucket` (print the steps to provision an
S3 bucket + identity, [0032](0032-generative-onboarding-not-active-provisioning.md)/
[0033](0033-bucket-onboarding-security-model.md)/[0034](0034-bucket-command-shape.md)). Working
with them surfaced two naming problems, not a structural one:

- **`bucket` didn't communicate its purpose.** It is the command that configures *AWS itself*
  (the bucket, its IAM policy, its lifecycle, and the identity to use) — "bucket" names only the
  noun it acts on, not that it's a setup/configuration action.
- **`setup` and `sets` read as near-synonyms doing related-but-different jobs on the same noun** —
  `sets` lists (read), `setup` creates/updates/inherits (write). Two separate words for one
  lifecycle is easy to mix up (which one shows me what I have vs. which one changes it?).

This ADR records the renaming/merging decision reached by interviewing the user on both points.
It does **not** revisit whether bucket-provisioning should stay a separate command from the
profile-pointer — [0034](0034-bucket-command-shape.md)'s "rare, one-time, per-bucket bootstrap"
vs. "narrow profile-pointer door" reasoning was examined and **still holds**; only the *names*
move.

## Decision

1. **`bucket <name>` → `aws <name>`.** It is the comprehensive "configure your AWS side" command
   (provision the bucket, print its IAM policy/lifecycle, pick IAM-user/SSO/non-AWS, and end in
   pointing at a profile) — "aws" fits what it does; "bucket" named only its argument.
   [0034](0034-bucket-command-shape.md)'s "## The name `bucket`" section (the noun-command
   rationale) is **superseded by this point**; the rest of 0034 (separateness, flags, generative
   posture) stands unchanged.

2. **The former `aws --profile <name> [<set>]` → `profile --profile <name> [<set>]`.** This frees
   "aws" for (1). "profile" names exactly what it does today: it writes/reads/clears
   `AWS_PROFILE` in an env file, never raw secret material (the auth spec's Non-Goals already
   refuse keys via flags) — and it still fits if the command later grows into managing a named
   profile's stored credentials, since in AWS's own vocabulary a profile already *is* the bundle
   that includes credentials. [0031](0031-aws-profile-config-door.md)'s reasoning (a focused
   profile-config door, not a general `config` command; read-only `~/.aws` validation; the
   always-on auth notice) all stands — only the command's name changes throughout that ADR.

3. **`setup`'s create/update/inherit behavior folds into `sets`.** `sets` becomes the single
   command owning the whole backup-set lifecycle: listing (today's behavior, unchanged) plus
   create/update/inherit (today's `setup` behavior, unchanged) — removing the setup/sets
   near-synonym collision rather than inventing a third word. The standalone `setup` command name
   retires.

   > **Superseded by [0036](0036-setup-mutates-list-shows-drop-sets.md).** Working the merged
   > `sets` further showed it to be a four-mode multiplexer; 0036 splits it on the read/write
   > seam instead — `sets` is *dropped*, `setup` is *revived* as the mutation verb, and listing
   > moves into `list`. The synonym this point removed by keeping the noun, 0036 removes by
   > keeping the verb. Points 1–2 are unaffected.

## Rejected alternatives

- **Merge `aws` (profile) + `bucket` into one command.** Considered (Q4/Q5 of the grilling
  session) and rejected: `bucket` would-be `aws` is generative/offline by nature
  ([0032](0032-generative-onboarding-not-active-provisioning.md)), while the profile-pointer's
  `<set>` positional is optional-and-meaningful-when-omitted (no set = user-wide scope) —
  different enough argument semantics that merging would reintroduce the flag-combination
  complexity the user explicitly wanted to avoid, for a problem (discoverability) renaming alone
  already fixes.
- **Subcommand namespacing** (`setup bucket`, `setup aws`, `setup <set>`). Rejected as too large
  an architectural change for the problem at hand — the registry/dispatch model
  ([src/commands.mjs](../../src/commands.mjs)) has no subcommand concept today, and introducing
  one was judged not worth it just to solve a naming/grouping confusion.
- **A new `init` command** taking over `setup`'s job, leaving `sets` read-only. Rejected in favor
  of merging into `sets`: it would still leave "two commands, one noun, only one of them obviously
  named for it" — `init` doesn't share `sets`' stem the way `setup` doesn't, so the memorability
  problem isn't actually solved, and a third word is added rather than two confusing ones removed.
- **Folding the profile-pointer into `setup`/`sets`.** Considered (Q5) and rejected: the
  profile-pointer is offline-always and its `<set>` is optional-meaningful; folding it in would
  make the merged command's network behavior and positional-arg requiredness depend on which
  flags are present — the same kind of invisible-mode complexity flagged in point 4 below, just
  introduced fresh rather than removed.

## Deferred, not decided here

`sets`' create-vs-update mode (inherited unchanged from today's `setup.mjs`) is still inferred
from invisible local state — "does this set already exist locally?" — rather than an explicit
flag. This was flagged during the grilling session as a real shape smell, but deliberately **left
unfixed**: it's idempotent and low-stakes (re-running it just re-publishes the same config), and
fixing it is orthogonal to the rename/merge decided here. Tracked as a future improvement in
[proposals/cli-command-rationalization.md](../../proposals/cli-command-rationalization.md), not
part of this ADR's consequences.

## Consequences

- Three command files change identity: `src/commands/bucket.mjs` becomes the new `aws.mjs`;
  today's `src/commands/aws.mjs` becomes `profile.mjs`; `src/commands/setup.mjs`'s logic merges
  into `src/commands/sets.mjs` (one-export-per-command, [0023](0023-porcelain-plumbing-lib-layers.md),
  still holds — `sets` exports the one merged function).
- `src/commands.mjs`'s registry loses the `setup` entry and gains the merged `sets` entry's
  args/options (today's `setup` entry's shape, plus the existing no-args listing).
- Every doc/help reference to `s3cab bucket`, `s3cab aws`, and `s3cab setup` needs updating —
  ADRs 0026/0030/0031/0033/0034, [docs/specs/auth.md](../specs/auth.md),
  [docs/specs/backup.md](../specs/backup.md), [docs/integration-testing.md](../integration-testing.md),
  [guide/bucket.md](../../guide/bucket.md) (rename to `guide/aws.md`), README.md,
  [CONTEXT.md](../../CONTEXT.md), and [src/help.mjs](../../src/help.mjs)'s `help auth` topic.
- No change to the underlying behavior of any of the three jobs — this is a pure rename/regroup,
  not a redesign of what bucket-provisioning, profile-pointing, or set lifecycle management do.
