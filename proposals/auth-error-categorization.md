# Task: friendly messages for invalid/rejected AWS credentials (close the raw-dump gap)

**Scope:** larger, and the design is **not 100% settled** — do a round of pre-implementation
grilling in the implementation session before coding (the direction below is agreed; the edges
flagged "open" are not). Likely earns an ADR.

**Origin:** a user run-through hit a raw, cryptic AWS message —

```
$ s3cab setup set1 . -b s3cab-test
ERROR: The provided token is malformed or otherwise invalid.
```

— and asked "I thought this was addressed previously, or is this another auth edge case?" It's the
latter: a real gap.

---

## Diagnosis (settled)

Request-time AWS credential failures form a family. Only two branches are handled today; the
reported one (and a sibling) fall through to AWS's raw text:

| Category | User action | Status today |
| --- | --- | --- |
| Chain resolves **nothing** | set creds up | ✅ `noCredentialsError` ([auth.mjs:29](../src/lib/auth.mjs#L29), in `resolveCredentials`) |
| Resolved, server says **expired** (`ExpiredToken`/`ExpiredTokenException`) | refresh them | ✅ `expiredCredentialsError` via the relay ([s3.mjs:164-174](../src/lib/s3.mjs#L164)) |
| Resolved, server says **invalid/malformed** (`InvalidToken` & cousins) | fix/replace them | ❌ **raw dump** — the reported gap |
| Resolved & valid but **not authorized** (`AccessDenied`) | fix the IAM policy | ❌ also raw — sibling gap |
| anything else | — | raw (acceptable) |

"The provided token is malformed or otherwise invalid" is S3's `InvalidToken`: creds _did_ resolve
(so `noCredentialsError` can't fire — it needs the chain to yield nothing) and they're _not_ expired
(so `isExpiredCredentials` doesn't match), so it sails through the relay's `throw error`
([s3.mjs:172](../src/lib/s3.mjs#L172)) to the top-level catch raw. The fix is **symmetric to the
expired case**: sibling predicate + factory at the same relay boundary. Categories are ~1:1 with
user action, which is why each needs its own message.

## Agreed direction — hybrid: named matches for specificity + metadata net for coverage

A pure name allowlist is a **timebomb**: any AWS code we didn't list — missed, or added by AWS
later — falls back to the raw dump _silently_. So don't make the name list responsible for
coverage, only for specificity:

1. **Named matches** for precise advice — an `invalidCredentialsError` factory (advice: _check/
   replace_ your creds, **not** "refresh" — folding into `expiredCredentialsError` would give the
   wrong fix) keyed on a predicate `isInvalidCredentials` (sibling to `isExpiredCredentials`,
   [auth.mjs:86](../src/lib/auth.mjs#L86)); likely an `accessDeniedError` too (advice: fix the IAM
   policy).
2. **A metadata safety net underneath** — AWS SDK errors carry an HTTP status
   (`$metadata.httpStatusCode`) and a client/server `$fault`; the credential/authorization
   rejection class is **403 / client-fault**. Any 403 client-fault we didn't specifically name →
   one friendly generic message ("AWS rejected this — your credentials are likely wrong or your
   policy is missing a permission; run `s3cab help auth`"). This catches **future** codes
   automatically because it keys on the durable category, not the volatile name. The name list just
   upgrades the common ones from "decent" to "precise."

All of this lives at the relay boundary in [s3.mjs](../src/lib/s3.mjs) (`expiredCredentialsRelay` →
generalize it), with factories/predicates in [auth.mjs](../src/lib/auth.mjs), following ADR-0030
(goal-framed, constructive, copy-pasteable fix).

## Open questions for the implementation session's pre-grilling

- **Verify the SDK shape against reality** before coding: exact field names (`error.name`,
  `error.$metadata.httpStatusCode`, `error.$fault`) and which status each error actually carries —
  confirm against the SDK types **and a live bad-credential response**. The 403/client-fault
  _shape_ is agreed; the exact fields are not hand-waved as settled.
- **Predicate scope** — which names go in `isInvalidCredentials`? Candidate family: `InvalidToken`,
  `InvalidClientTokenId`, `UnrecognizedClientException`, `InvalidAccessKeyId`. Hold back
  `SignatureDoesNotMatch` (ambiguous — clock skew / region / endpoint, not always a bad secret).
- **403 spans auth vs authz** — keep two named buckets (invalid-creds, access-denied) above the net,
  or let the net's single message address both? How to phrase a message spanning both without
  misdirecting.
- **Is `AccessDenied` in scope now or deferred** to a follow-up?
- **Root-cause aside** (not blocking the UX fix): why did a fresh `setup ... -b s3cab-test` hit
  `InvalidToken` at all — stale `AWS_SESSION_TOKEN`, or set-env layering ([env.mjs](../src/lib/env.mjs))?
  Worth reproducing; the translation fix stands regardless.

## Artifact

Once the edges are settled, capture the strategy as an **ADR** — _allowlist-for-specificity +
metadata-net-for-coverage_, and **why** (the silent-fall-through timebomb a pure enumeration
creates). That "why" is exactly the non-obvious, hard-to-reverse reasoning an ADR exists to hold.

---

When done and verified (with the ADR landed), delete this file.
