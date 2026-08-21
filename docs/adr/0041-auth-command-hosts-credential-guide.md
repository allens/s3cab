# Rename `profile` → `auth`; the command hosts the credential guide

**Status:** accepted (settled 2026-07-03, in the help-topics grilling session that also
produced the topics-are-cross-cutting-only rule and the aws-topic fold, PR #144) —
**implemented** (2026-07-03). Supersedes the *name* chosen in
[0035](0035-aws-profile-sets-command-rationalization.md) (`aws`→`profile`); the command's
behaviour, scope model, and read-only `~/.aws` validation
([0031](0031-aws-profile-config-door.md)) are unchanged. **The name is in turn superseded
by [0047](0047-provider-command-neutral-config-door.md)** (`auth` → `provider`, which also
grows endpoint/region/keys knobs); the hosted-guide pattern and everything else here stands.

## Context

After the aws-topic fold, two names still covered one concern: you *configured* auth via
`s3cab profile` but *learned* it via `s3cab help auth` (a 73-line topic, pointed at by four
error messages). The user's original naming instinct ("we very nearly called `profile` this
way back") resurfaced during the grilling: name the command after the concern, not the
mechanism.

## Decision

1. **The command is `s3cab auth`** — set, clear, or show how s3cab signs in. `--profile`
   stays as the flag: the profile is the *mechanism*, auth is the *concern*.
2. **The auth topic folds into the command's registry `description`** (resolution order,
   supported options, the by-cause server-rejection guide). Topics shrink to `exclude`
   only, per the topics-are-cross-cutting-only rule.
3. **`s3cab help auth` keeps working** — with the topic gone it routes to the
   command's help via the `help <command>` routing, so the four error-message pointers
   ("Run 's3cab help auth' for details.") needed no change. *(Overtaken by 0047's rename:
   with no `auth` command, `s3cab help auth` is now an unknown-name error; the pointers
   were re-aimed at `provider`.)*
4. The name does **not** re-open a login flow: [0015](0015-standard-aws-credential-chain.md)
   stands, and the description a user lands on *teaches* the no-login model — which is the
   answer to the "does `auth` overpromise?" concern: the command is also the front door for
   understanding how auth works.

## Consequences

`src/commands/profile.mjs` → `auth.mjs` (export renamed to match, per the
one-export-per-command rule); every printed `s3cab profile …` suggestion (onboarding
recipes, the command's own messages, README/guide/design docs) now says `s3cab auth …`.
Pre-1.0, so no alias or deprecation shim for the old name.
