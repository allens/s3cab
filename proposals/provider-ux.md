# Provider / onboarding UX

Follow-ups from the ADR-0047 session (2026-07-09) that need a **shape discussion before
building** — parked here with context intact.

_The flagship item, `provider --check` (a connection probe), moved to its own file
2026-07-18: [provider-check.md](provider-check.md)._

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
