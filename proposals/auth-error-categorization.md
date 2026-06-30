# Task: friendly messages for invalid/rejected AWS credentials (close the raw-dump gap)

**Status:** design settled in pre-implementation grilling (2026-06-30) →
[ADR-0037](../docs/adr/0037-aws-auth-error-categorization.md). This file now tracks the
**remaining implementation**; delete it once the code lands and is verified.

**Origin:** a user run-through hit a raw, cryptic AWS message —

```
$ s3cab setup set1 . -b s3cab-test
ERROR: The provided token is malformed or otherwise invalid.
```

— a real gap: S3's `InvalidToken` resolved fine (so `noCredentialsError` can't fire) and isn't
expired (so the relay's `isExpiredCredentials` doesn't match), so it sails through to the
top-level catch raw.

## Diagnosis (settled)

Request-time AWS credential failures form a family. Only two branches are handled today; the
reported one (and siblings) fall through to AWS's raw text:

| Category | User action | Status today |
| --- | --- | --- |
| Chain resolves **nothing** | set creds up | ✅ `noCredentialsError` ([auth.mjs:29](../src/lib/auth.mjs#L29)) |
| Resolved, server says **expired** (`ExpiredToken`/`ExpiredTokenException`) | refresh them | ✅ `expiredCredentialsError` via the relay ([s3.mjs:164](../src/lib/s3.mjs#L164)) |
| Resolved, server says **invalid/malformed** (`InvalidToken` & cousins) | fix/replace them | ❌ **raw dump** — the reported gap |
| Resolved & valid but **not authorized** (`AccessDenied`) | fix the IAM policy | ❌ also raw — sibling gap |
| Resolved & valid but **clock skew** (`RequestTimeTooSkewed`) / **bad signature** (`SignatureDoesNotMatch`) | sync clock / check secret+region+endpoint | ❌ also raw |
| anything else | — | raw (acceptable) |

## Design — see [ADR-0037](../docs/adr/0037-aws-auth-error-categorization.md)

The grilling **rejected** the originally-proposed HTTP-status/`$fault` "coverage net" (it
misdirects, and wouldn't even catch the reported `InvalidToken`, which is HTTP **400** not 403).
Landed design, in full in the ADR:

- **Match on the AWS error *code* (`error.name`)**, enumerated from the SDK's frozen S3 error
  table — never HTTP status. Relay generalizes to an ordered `{ codes → factory }` table.
- **Catch only "can fix" + "common & can advise"**, bucketed by the four distinct remedies:
  `s3cab profile` (no creds, built) · `aws sso login` (expired, built) · `s3cab aws <bucket>`
  (`AccessDenied`) · `s3cab help auth` + per-cause headline + raw error (invalid-creds,
  signature, clock-skew).
- **No mushy middle:** account-level codes (`AccountProblem`/`AllAccessDisabled`/`NotSignedUp`)
  and anything unrecognized fall through to today's raw `ERROR:` framing.
- **Non-AWS:** code matching is portable (SigV4 codes) / inert (STS+account codes); headlines
  stay provider-neutral; only the `AccessDenied` remedy branches on `customEndpoint()`.

## Handoff — paste into the implementation session

Read [ADR-0037](../docs/adr/0037-aws-auth-error-categorization.md) (the *why* — don't
re-litigate) and this file first. **Core rule:** match request-time AWS rejections on the error
*code* (`error.name`), never HTTP status; catch only "can fix" + "common & can advise" codes,
bucketed by the four remedies (`s3cab profile` / `aws sso login` / `s3cab aws <bucket>` /
`s3cab help auth`); account-level + unrecognized codes fall through to the raw `ERROR:` dump —
no generic middle. Wording follows [ADR-0030](../docs/adr/0030-error-message-guidelines.md) and
consumer vocabulary [ADR-0012](../docs/adr/0012-consumer-vocabulary-naming.md); the catch-all
headlines embed the raw AWS error (code-first, for googling) indented under a label, reusing the
`noCredentialsError` style. Work in a worktree, uncommitted for review, ask before committing.

1. **`auth.mjs`** — `accessDeniedError` (+ `isAccessDenied`); an invalid/signature/clock factory
   fed by per-cause headlines (+ predicates). Fold `TokenRefreshRequired` into the expired path.
2. **`s3.mjs`** — generalize `expiredCredentialsRelay` into the code→factory table (existing
   expired case becomes a row); thread `args.input.Bucket` so `accessDeniedError` can name the
   bucket; branch the `AccessDenied` remedy on `customEndpoint()`.
3. **`help.mjs`** — expand `helpTopics.auth` with AWS + non-AWS sections covering replace-creds
   (by source: env / profile / SSO), signature (secret/region/endpoint), and clock-sync (per-OS).
4. **Tests** — relay table unit tests via the `s3.mjs` mock (no network); assert each code →
   its factory, and unknown → rethrow raw.
5. **Live confirmation before shipping** — the exact `.name` a live bad-credential response
   carries, and which codes reach the relay vs. are caught earlier by `noCredentialsError`. (The
   grilling never had a real rejected response to hand, so expect to confirm this live.)

When done and verified, delete this file (the ADR is the lasting record).
