# Provider / onboarding UX

Follow-ups from the ADR-0047 session (2026-07-09) that need a **shape discussion before
building** — parked here so tomorrow's session can pick them up with context intact.

## Onboarding: `setup` needs ambient credentials (open — surfaced by ADR-0055)

[ADR-0055](../docs/adr/0055-per-set-credentials-one-mode.md) (implemented, PR #183) made
credentials per-set — but a set's creds can't be configured until the set exists, and `setup`
needs credentials to claim the remote marker. So `setup` runs on **ambient** creds only. AWS
users are fine (`~/.aws`); non-AWS (R2/B2) users regressed — they must export
`AWS_ENDPOINT_URL_S3` + keys in the shell for the first `setup`, then persist them per-set with
`provider` afterward.

Options to decide: **(a)** accept + document the shell-export-first dance; **(b)** let `setup`
take the provider knobs (`--endpoint`/`--region`/`--profile`/`--keys`) and write the new set's
env *before* claiming the remote, so one command is self-sufficient; **(c)** leave as-is.
Leaning (b) — needs the `cli-design` skill before building.

## `provider --check` — a connection probe (the flagship)

**Problem.** After `provider --endpoint … --region … --keys`, there is no way to learn
whether the configuration *works* short of running a real, stateful command (`setup`, which
also claims the remote set name as a side effect). Every credential CLI has a "did it work?"
probe (`aws sts get-caller-identity`); s3cab has nothing between "configured" and "first
backup". The categorized error relay (ADR-0037) already produces excellent by-cause messages
for exactly this moment (bad secret → signature advice, wrong endpoint, clock skew, access
denied) — a probe would give it a deliberate trigger instead of waiting for a real command
to trip it.

**Sketch.** One cheap authenticated call (e.g. LIST with `MaxKeys: 1`) against a bucket,
reporting success ("Connected to <endpoint/bucket> as …") or relaying the categorized
failure. Exit 0/non-zero so scripts can gate on it.

**Shape questions to grill (cli-design skill first):**

- **Operand:** a bucket (`provider --check <bucket>` — but the positional slot is `[<set>]`),
  a set (probe its bound bucket + its env layer — the realistic end-to-end check), or both
  (set when given, else…the user scope has no bucket to probe)?
- **Flag vs command:** `provider --check` mixes a *doing* mode into a config command
  (the ADR-0035 rejected-merge concern) — is a separate tiny command (`s3cab check`?
  `s3cab provider-check`?) cleaner, or is the mode acceptable because it reads
  (not writes) the same config the command owns?
- **Name:** `--check` vs `--test` vs `--verify` (avoid: `verify` is taken by the
  repository-integrity command — real confusion risk).
- What exactly to probe with only user-scope config and no set/bucket yet (HeadBucket
  needs a bucket; ListBuckets is often denied to scoped tokens).

## `aws --profile` vs `provider --profile` — one flag, two meanings

`provider --profile` = the profile s3cab signs in with. `aws --profile` = an **admin**
profile interpolated into the *printed* commands (output sugar, never used to
authenticate). Same flag name, same `-p` short, different roles — against clig's
"same flag means the same thing across subcommands". Candidate fix: rename the `aws` one
to `--admin-profile` (probably dropping its `-p`). Needs the cli-design skill + a small
ADR note (it touches ADR-0034's flag table). Pre-1.0 is the time if we're doing it.

## Standing rejections (don't re-litigate without new evidence)

- **An `--effective` merged-layers view on `provider` show** — rejected 2026-07-09: the
  always-on `authNotice` at first S3 touch already reports the effective profile/endpoint
  at the moment it matters; a flag would be speculative structure (#7). The show path
  instead notes shell-environment auth when the file scope is empty.
- **Rewriting an SDK "Region is missing" client error** — investigated 2026-07-09 and
  **moot**: `clientConfig()` (src/lib/s3.mjs) already defaults the region to `us-east-1`
  when none is set, so the SDK error cannot occur; a provider that rejects the label
  surfaces as `SignatureDoesNotMatch`/`AccessDenied`, whose advice already mentions the
  region (`badSignatureError`).
