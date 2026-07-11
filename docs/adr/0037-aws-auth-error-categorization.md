# Request-time AWS auth errors are categorized by error code, not HTTP status

**Status:** accepted

When the resolved AWS credentials work at startup but the *server* rejects a request
(invalid/expired token, missing permission, bad signature, clock skew), s3cab translates the
rejection into a friendly, actionable message at the SDK relay boundary
([`src/lib/s3.mjs`](../../src/lib/s3.mjs)'s `expiredCredentialsRelay`, generalized). The
relay **matches on the AWS error *code* (`error.name`)**, enumerated from a fixed list, and
routes each to one of a few remedies — it does **not** key on HTTP status
(`$metadata.httpStatusCode`) or `$fault`. Only the codes we can *fix* or *commonly advise on*
are caught; everything else falls through to the existing raw `ERROR:` dump unchanged. Message
*wording* follows [0030](0030-error-message-guidelines.md); this ADR is about *what we catch
and how we bucket it*.

## Why code, not HTTP status

Categorization exists to give **correct instructions**, and only the AWS code maps ~1:1 to a
user action. HTTP status cannot:

- **403 spans three different fixes** — `AccessDenied` (fix the IAM policy),
  `SignatureDoesNotMatch` (wrong secret / clock / endpoint), `RequestTimeTooSkewed` (sync the
  clock) are *all* 403 client-fault. A single "403 → your credentials are likely wrong"
  message misdirects the clock-skew and signature cases. A status net doesn't dodge the
  ambiguity a code list dodges; it relocates it.
- **The credential family is split across statuses with no logic** — `InvalidToken` is **400**,
  `InvalidAccessKeyId` is **403**, `ExpiredToken` is **400**. So a "403 client-fault net" would
  have *missed the very bug that prompted this work* (`InvalidToken`, the cryptic "The provided
  token is malformed or otherwise invalid"). This split is the empirical proof that status is
  the wrong key. (Source: the S3 error table AWS ships embedded in the SDK,
  `@aws-sdk/client-s3` `models_0.d.ts` — a frozen, SOAP-era enumeration of ~81 codes.)

Matching `error.name` is also what the codebase already does for `ExpiredToken`, `NoSuchKey`,
`NotFound`, `PreconditionFailed`; `AccessDenied` is even a modeled SDK class with
`readonly name: "AccessDenied"`. The unmodeled codes deserialize with `.name` set to the
response `<Code>`. Same mechanism, already proven in `getText`/`objectExists`.

## What we catch: "can fix" + "common and can advise"

Collapsed by **the command we'd show the user** — there are only four distinct remedies, so
that, not a finer taxonomy, is the category axis:

| Remedy shown | AWS codes | Note |
| --- | --- | --- |
| `s3cab profile --profile <name>` | *(chain yields nothing)* | `noCredentialsError`, already built (resolution-time) |
| `aws sso login` | `ExpiredToken`, `ExpiredTokenException`, `TokenRefreshRequired` | `expiredCredentialsError`, already built |
| `s3cab aws <bucket>` | `AccessDenied` | new; headline names the bucket and says "sign-in's fine, missing permission" |
| `s3cab help auth` *(+ headline + raw error)* | `InvalidToken`, `InvalidAccessKeyId`, `InvalidSecurity` (invalid creds); `SignatureDoesNotMatch` (signature); `RequestTimeTooSkewed` (clock skew) | new; no single-command fix, but common and worth orienting |

The fourth bucket has **no single command fix** (the secret could live in env, a profile, SSO,
metadata — s3cab is source-agnostic, [0015](0015-standard-aws-credential-chain.md)), so each
recognized *cause* gets its own plain-language **headline** plus the **raw AWS error**
(code-first, for googling) indented under a label — reusing the `noCredentialsError` style —
and points at `s3cab help auth` for the per-source/per-provider depth. The headline earns its
keep because AWS's raw text is developer-speak: "token is malformed" doesn't tell a
non-technical backup user that *their credentials* are the thing to look at
([0012](0012-consumer-vocabulary-naming.md)).

**No mushy middle.** A code is either in the table (→ its remedy/headline) or it falls through
to today's generic `ERROR:` framing — including the rare, self-descriptive account-level codes
(`AccountProblem`, `AllAccessDisabled`, `NotSignedUp`) and anything unrecognized. Formatting is
what a table row buys; half-dressing an error we don't understand would imply we understand it.

Implementation shape: the relay generalizes from its single `if (isExpiredCredentials)` into
walking a small **ordered table of `{ codes → factory }`**, default = rethrow raw. Data, not
branching ([0006](0006-minimal-code.md)); the existing expired case becomes just another row.

## Non-AWS providers

The `<Code>` vocabulary is de-facto S3-compatibility surface, so the matching is portable where
it matters and inert where it doesn't:

- **SigV4 / authorization codes are portable** — `SignatureDoesNotMatch`, `AccessDenied`,
  `InvalidAccessKeyId`, `RequestTimeTooSkewed` are part of request signing every S3-compatible
  provider (R2, B2, MinIO, Wasabi, Spaces) implements. (`SignatureDoesNotMatch` is *more*
  common off-AWS — wrong endpoint/region is the classic R2/B2 trap.)
- **STS / account codes are AWS-isms** — `InvalidToken`/`ExpiredToken`/`TokenRefreshRequired`
  (session tokens) and the account-level codes concern AWS-specific concepts; off-AWS they
  simply never fire, so their predicates harmlessly never match.

So headlines stay **provider-neutral**, and the only remedy that branches on AWS-vs-not is
**`AccessDenied`** (`s3cab aws` prints an *AWS IAM* policy — meaningless off AWS; the off-AWS
text says "check your provider's bucket/token permissions"). The branch reuses the existing
`customEndpoint()` "targets-AWS?" signal in `s3.mjs` — no new surface. `s3cab help auth` grows
an AWS section and a non-AWS section to hold the per-provider depth.

## Considered and rejected: a metadata "coverage net"

The tempting alternative was a safety net under the named matches: treat *any* 403 / client-fault
as a credential/authorization problem with one generic message, so codes we never enumerated
(or AWS adds later) still get *something* friendlier than raw. Rejected because:

- It **misdirects** — 403 spans creds/permission/clock, so its one message is wrong for some
  members (see "Why code, not HTTP status").
- It **wouldn't even catch the reported bug** — `InvalidToken` is 400.
- The **"silent timebomb" premise is weak** — the S3 auth-error vocabulary is small (~half a
  dozen codes our Put/Get/Head/List/Delete operations can hit) and effectively frozen; the
  realistic "miss" is failing to enumerate an *existing* code, which is bounded and cheap to add
  the day a real user hits one ([0006](0006-minimal-code.md)). A generic guess that can
  misdirect is *worse* than AWS's own honest words.

## Consequences

- A new `accessDeniedError` factory + predicate, a new invalid/signature/clock factory fed by
  per-cause headlines, and the relay generalized to a code→factory table — all at the existing
  relay boundary, with the factories/predicates in [`src/lib/auth.mjs`](../../src/lib/auth.mjs)
  beside `expiredCredentialsError`/`isExpiredCredentials`.
- `s3cab help auth` ([`src/help.mjs`](../../src/help.mjs)) gains AWS + non-AWS sections; it is
  now load-bearing for the depth the terse messages defer to.
- No machinery enforces the code list; it is data, verified by review and a live bad-credential
  check before shipping (the exact `.name` a live response carries, and which codes reach the
  relay vs. get caught earlier by `noCredentialsError`, want one real confirmation —
  [0019](0019-s3-test-strategy.md)'s `s3.mjs` mock makes the relay itself unit-testable without
  the network).
