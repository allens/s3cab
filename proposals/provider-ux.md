# Provider / onboarding UX

Follow-ups from the ADR-0047 session (2026-07-09) that need a **shape discussion before
building** — parked here so tomorrow's session can pick them up with context intact.

## Implement ADR-0055 — per-set credentials, one mode per set (design DONE, build pending)

The design is **settled and captured** in
[ADR-0055](../docs/adr/0055-per-set-credentials-one-mode.md) (grilled 2026-07-12); this is the
build to-do. Drops the s3cab **user** env layer (`~/.s3cab/env`) so the layering is **set >
shell**, makes each set exactly **one credential mode** (profile XOR keys XOR ambient) enforced at
`provider` write time, gives `provider` the **sole-set default**, and rewrites `noCredentialsError`
around the **named set** (classifier → `{ annotation, diagnosis?, fix }` + one assembler; separate
minimal template for the no-set `upload --bucket` case). Motivation: a walkthrough found the
two-precedence-systems trap (a set-layer profile silently beaten by a user-layer key pair) and the
user layer as a parallel-default mechanism — full context in the ADR.

**Slice into ~3 PRs:**

1. **Drop the user layer + thread the set into the error.** Remove the user layer from `env.mjs`
   and the entry-point `loadEnv` (re-home/retire the `__S3CAB_ENV_LOADED` breadcrumb, ADR-0022);
   `loadSet` records the resolved set (name + `envPath`) in module state; simplify
   `profileSource`/`envSources`. `upload --bucket` becomes ambient-only. Update `env.test.mjs`.
2. **One-mode-per-set + sole-set default in `provider`.** `--keys` clears `AWS_PROFILE` and
   vice versa (with a confirmation line); no user scope; a no-set write targets the only set,
   errors on ambiguity; bare show summarizes all sets. `provider --keys` prompts for id+secret
   only (no session token). `provider.test.mjs`.
3. **The error/guidance rewrite.** Invert `noCredentialsError`/`credentialGuidance` to the frame +
   classifier shape; the five validated renderings are in the design-session transcript. Rewrite
   [docs/design/auth.md](../docs/design/auth.md) to the set > shell model; touch README/guide
   credential sections.

An existing `~/.s3cab/env` is simply no longer read (pre-1.0; no migration).

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
