# `s3cab aws`: a profile-config door, with read-only `~/.aws` validation

**Status:** partly superseded by [0035](0035-aws-profile-sets-command-rationalization.md)

> **Command name superseded by [0035](0035-aws-profile-sets-command-rationalization.md)**
> (accepted): the profile-config door described here is now **`s3cab profile`** — the
> rename freed `aws` for the cloud-onboarding command. Only the command's *name* moved;
> every decision below (a focused door not a general `config`, read-only `~/.aws`
> validation, the always-on notice, explicit scope) stands. The `s3cab aws` form
> throughout this ADR is the *historical* name.

`s3cab aws` is a small, focused command for pointing s3cab at an AWS profile —
writing `AWS_PROFILE` into s3cab's own env files (`~/.s3cab/env` for the user-wide
default, or a set's `env` for a per-set override), showing the current setting, or
clearing it. It is the discoverable, safe door onto the one piece of auth config a
clean (secret-free) user actually needs to set; before it, the only documented way
was hand-editing `~/.s3cab/env`.

This ADR records three decisions that are not obvious from the code.

## 1. A focused profile command, not a general `s3cab config`

A general `config` command (à la `git config`) was considered and rejected. The
deciding factor: there is no real second knob to justify the generality, so a
`config` command whose only meaningful key is `profile` would be *speculative*
structure ([0006](0006-minimal-code.md)).

Surveying everything s3cab's env can carry:

- **`AWS_PROFILE`** is the one clean knob worth a command. A user who ran
  `aws configure` just needs to tell s3cab which profile to use.
- **Region / endpoint** collapse away: region lives in the profile for a profile
  user, and the only users who need region/endpoint are long-lived-key users on
  non-AWS providers (R2/B2/MinIO) — who are *already* hand-editing `~/.s3cab/env`
  to place their secret keys (we refuse keys via flags, [auth spec](../design/auth.md)
  Non-Goals), so adding region/endpoint on the next line is free.
- **A "default bucket" is a phantom.** Comments once claimed env could carry a
  user-level default bucket, but no code ever read one — only a *set's*
  `S3CAB_BUCKET` is consumed, and `setup` already writes it. Those comments were
  corrected alongside this work.

So the real domain is just "the AWS profile," at two scopes: a user-wide default
and per-set overrides (e.g. one set backing up to a work account, another to a
personal one). That is a coherent, non-speculative command — and exactly the shape
originally sketched (`s3cab aws --profile <name> [<set>]`).

## 2. s3cab now *reads* `~/.aws` (read-only) to validate a profile

When `aws --profile <name>` is given, s3cab checks the name against the profiles
defined in `~/.aws/config` + `~/.aws/credentials` (via `@smithy/shared-ini-file-loader`'s
`parseKnownFiles`, in `src/lib/aws-profiles.mjs`) and **warns, listing the available
profiles, if the name is unknown — but still writes it.** This catches a typo at
config time instead of as a surprise on the next cloud op.

This is a deliberate, bounded softening of s3cab's "stay out of `~/.aws`" stance.
[0015](0015-standard-aws-credential-chain.md) and the auth spec's Design Principle 3
forbid s3cab *writing* `~/.aws/config` / `~/.aws/credentials` — shared AWS config
stays user-owned. **Reading** it to validate does not violate that: the SDK already
reads those files; s3cab never modifies them. The validation is *advisory* — it
warns, never blocks (a profile you are about to create is a legitimate reason to set
it first), and is best-effort (if the files can't be read, validation is skipped
silently). We use the canonical AWS-family parser rather than hand-rolling an INI
reader, so the `[profile X]` vs `[X]` asymmetry and the `AWS_CONFIG_FILE` /
`AWS_SHARED_CREDENTIALS_FILE` overrides are handled for us, not re-implemented
([0006](0006-minimal-code.md)).

## 3. An always-on notice of the profile/endpoint in use

On the first S3 touch of a run, s3cab prints one line to stderr — e.g. `Using AWS
profile: work` (or `…, endpoint: …`, or `Using S3 endpoint: …` for keys-based
non-AWS) — so "which account/endpoint am I about to touch?" never needs guessing.
It is emitted from `client()` (the single lazy client choke point), so it fires
exactly once and **never** for the offline commands that never build a client. It
reports the *effective* values after env layering; the line is computed by a pure,
unit-tested `authNotice()` helper. It is **always on**, not behind `S3CAB_DEBUG` —
the whole value is everyday confidence, which a debug gate would defeat.

## Scope is explicit (a deliberate divergence)

`aws`'s positional set is explicit: **omitting it means the user scope, not the
sole-set default** the read commands use ([0022](0022-prepare-remote-set-front-door.md),
`resolveSet`). Where your credentials point is precisely where a silent default
would be wrong, and "no set" already means a different explicit thing (the user
layer) rather than "guess the set." A named set must already exist — `aws` never
*creates* one (that is `setup`'s job, which also claims the remote name).

## Consequences

- One new direct dependency, `@smithy/shared-ini-file-loader` (AWS-family).
- The command is purely local — no S3, no credentials, no client — so it stays fast
  and works offline.
- `noCredentialsError` and the `help auth` topic now point at `s3cab aws --profile`
  as the quickest setup, making the command discoverable from the failure path.
