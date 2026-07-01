# Auth & onboarding UX

Epic: make credential/setup failures **self-explanatory**, so a user who hits "no
credentials" while onboarding understands *why* and *how to fix it* — instead of
being sent in a circle. Settled by a design session 2026-07-02 (ready to implement;
this file is deleted when it lands, folding the of-record parts into
[docs/specs/auth.md](../docs/specs/auth.md)).

## Why (the journey that motivated it)

A cautious first-timer ran `setup <set> . -b <bucket>`, was walked through the missing
args, then hit **`ERROR: No AWS credentials found`** whose advice was *"point s3cab at an
AWS profile: `s3cab profile --profile <name>`"*. But a profile **was** already set
(`AWS_PROFILE=s3cab-test` in `~/.s3cab/env`) — it just wasn't in `~/.aws`, so it resolved
no credentials. Told to *set a profile they already had*, they ran `s3cab profile` to
investigate and got `AWS for all backups — profile: s3cab-test (…)` — a bare fragment that
could be read as *another* error and gave no hint that `s3cab-test` was the culprit. The
whole loop contradicted itself.

## Settled decisions

| Area | Decision |
| --- | --- |
| **Setup validation** | Keep **setup-time** claim/validation (needs creds). ADR-0026 **stands** — the "lazy claim" alternative was reconsidered and rejected (see [ADR-0026](../docs/adr/0026-bucket-required-at-setup.md)'s reaffirmation note). The fix is a *helpful failure*, not a deferred one. |
| **Credential error** | Make it **configuration-aware** and fix it **centrally** in `resolveCredentials`/`noCredentialsError` so every cloud command (setup/backup/status/inherit) inherits it. |
| **`profile` show** | name:value (it's a query), symbol-free, with a proactive `~/.aws` diagnostic. |
| **Scope label** | "all backups" → **"Default AWS profile"** (per-set profiles override it). |
| **`update` ordering** | Remote-first, so a creds failure leaves no local/cloud drift. |
| **`doctor`/`info` command** | **Not** added — supersedes the bullet in [output-ux.md](output-ux.md). Under setup-time validation, `setup` *is* the checkpoint; the errors + `profile` show carry the diagnosis. |

## Design

### 1. Configuration-aware credential error (central)

`noCredentialsError` ([src/lib/auth.mjs](../src/lib/auth.mjs)) currently *always* advises
"point s3cab at a profile" — wrong when one is set. Branch on `AWS_PROFILE`, using
`listProfiles()` (from `aws-profiles.mjs`, already used by `profile`'s `warnIfUnknownProfile`)
to diagnose:

- **`AWS_PROFILE` not set** → today's advice (point s3cab at a profile).
- **set, but not in `~/.aws`** → *"s3cab is set to use profile 'X', but it isn't in your AWS
  config — that's why there are no credentials. Create it (`aws configure --profile X`, or
  `aws configure sso` for SSO), or point elsewhere (`s3cab profile --profile <name>`)."* ← the
  missing "aha".
- **set, present, but no creds** → *"profile 'X' is configured but yielded no credentials — if
  SSO, `aws sso login --profile X`; else check its keys."*

Wiring: the `~/.aws` lookup is async, so it happens in `resolveCredentials` (already async)
and is passed into the error factory. Wording follows [ADR-0030](../docs/adr/0030-error-message-guidelines.md).
Scope: this is the **resolve-time** ("found nothing") path only — the **request-time**
rejections (expired/invalid at the server) already have good handling
([expiredCredentialsError](../src/lib/auth.mjs) + [ADR-0037](../docs/adr/0037-aws-auth-error-categorization.md));
don't touch or duplicate them.

### 2. `profile` show — legible + diagnostic

`describeScope` ([src/commands/profile.mjs](../src/commands/profile.mjs)) becomes a
name:value status and runs the same `~/.aws` cross-check, so *looking* flags a broken
profile (closing the asymmetry where the *set* path warns but the *show* path stays silent).

Healthy (user / per-set):
```
Default AWS profile: s3cab-test   (~/.s3cab/env)
AWS profile for set 'photos': prod-account   (~/.s3cab/sets/photos/env)
```
Broken:
```
Default AWS profile: s3cab-test   (~/.s3cab/env)
Not in your AWS config — no credentials to use.
To fix it:  aws configure --profile s3cab-test
```
No symbols; the warning lines appear only when broken, so a healthy result reads
unmistakably as a statement of state. The rare two-value (endpoint) case adds a second
`AWS endpoint for …: …` line.

### 3. "Default AWS profile" relabel

`resolveScope`'s user-scope `label: "all backups"` overclaims — per-set profiles override
the user default (env layering, [ADR-0022](../docs/adr/0022-prepare-remote-set-front-door.md)/[ADR-0025](../docs/adr/0025-drop-per-bucket-env-layer.md)),
so a set with its own profile does *not* use it. The rest of the code already says "default"
(the registry arg desc; the set's own "none" message). Relabel to the **default** framing
across show/set/clear/none. Because "default" reads as a clean query noun ("Default AWS
profile:") but stiffly in an action sentence ("Cleared … for the default"?), give the user
scope **two forms**: a query-noun and a short action-phrase (e.g. "the default (all
backups)") — i.e. split the single `label` field.

### 4. `update` remote-first

`update` ([src/commands/setup.mjs](../src/commands/setup.mjs)) writes local *then* pushes
config, so a creds failure mid-update leaves local ahead of cloud. Reorder to push config
*then* commit local (mirroring `create`'s remote-first order), so a failure changes nothing.
Guiding principle: **re-running `setup` converges** (idempotent steps), not strict
transactional atomicity.

## Tests

Each change gets an asserting test ([ADR-0020](../docs/adr/0020-coverage-review-not-gate.md)):
the three credential-error branches (mock `listProfiles`), `describeScope`'s healthy/broken
output at both scopes, and `update`'s remote-first ordering (a failed push leaves local
`dirs.txt` unchanged).
