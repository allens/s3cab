# Credential expiry is diagnosed at resolve time too, matched on the chain's message

**Status:** accepted

An expired sign-in is the steady-state auth failure: once a set works, the thing that breaks it
next week is a session running out, not a missing profile. It can surface at two moments, and
until now only one of them was diagnosed:

- **at request time** — the chain hands back a token it never validated and the *server* rejects
  it. Caught at the SDK relay boundary by error code ([0037](0037-aws-auth-error-categorization.md)),
  answered by `expiredCredentialsError`;
- **at resolve time** — the SSO token cache holds a session that has already run out, so the
  chain refuses to hand anything back at all. This fell into `noCredentialsError`, whose
  classifier keys on *what the set declares* — and a set relying on ambient credentials declares
  nothing, so the user got the generic "nothing configured, pick one" menu.

The resulting message was **wrong at the headline** ("No credentials found for set 'onedrive'"
— they were found, they had expired; "the set's own settings … (no credentials there)" reads as
a config gap), and it **buried the only correct action**: `aws sso login` appeared as a
parenthetical under two `s3cab provider` commands that would have the user reconfigure a set
that is perfectly fine.

So: **`noCredentialsError` tests the cause for expiry first and hands off to
`expiredCredentialsError`**, which grows the resolve-time context (the set, the effective
profile, the chain's own words). 0037's remedy table already had the seam visible — its row 1 is
"chain yields nothing → `noCredentialsError`" and row 2 is "expired → `aws sso login`" — and
this case is *both* rows; it landed on row 1 only because that row is keyed on **where** the
failure happened rather than **why**.

## Why the message, not the error code

0037's rule is "match `error.name`, never HTTP status", and it stands — for **request**-time
rejections, where `.name` carries the service's response code. It cannot apply here: the SDK
throws the same `TokenProviderError` / `CredentialsProviderError` for an expired session as it
does for a missing profile, an unknown `sso_session`, or an unreadable config. The name is a
*layer*, not a cause. Only the text discriminates:

| Thrown by | Message |
| --- | --- |
| `@aws-sdk/token-providers` | `Token is expired. To refresh this SSO session run 'aws sso login' …` |
| `@aws-sdk/credential-provider-sso` | `The SSO session associated with this profile has expired. …` |

Both carry the word "expired", so one case-insensitive word test covers both. Matching AWS's
prose is admittedly weaker than matching a code — but the failure mode is what makes it
acceptable: **if AWS rewords, the test stops matching and the message falls back to the generic
frame** — exactly today's behaviour, never a wrong instruction. The predicate has no other
consequence: nothing branches on it but which of two messages we print.

## Where the line is

**Expiry only.** Every other chain failure keeps the "looked in" frame and its per-case fix, and
we do not start reading the SDK's prose for "profile not found", "sso_session missing", or the
rest. This is 0037's "no mushy middle" applied to the resolve-time side: expiry earns a message
match because it is the *one* resolve-time cause with a single unambiguous remedy and the one a
working install hits over and over. Anything else is either already pinpointed by what the set
declares (which is more reliable than parsing prose) or honestly unclassified.

## One message, both moments

The remedy is identical whichever moment catches it, so there is **one factory**, not a fourth
near-duplicate expiry text — a user shouldn't get different wording because their token happened
to lapse a second earlier. The resolve-time context only *adds*: the set name in the headline,
and the chain's own words quoted under it (there is no equivalent at request time — the server
just rejects a signature). Naming the set keeps it consistent with the rest of the family, and
is safe here precisely because the fix block contains no `s3cab provider` command to misdirect
with.

## Consequences

- A module-private `isExpiredSignIn` predicate and one branch at the top of `noCredentialsError`
  in [`src/lib/auth.mjs`](../../src/lib/auth.mjs); `expiredCredentialsError` takes an optional
  `{ set, profile, reason }`. The request-time relay in `src/lib/s3.mjs` is untouched.
- When `AWS_PROFILE` is set, the first bullet becomes the whole command
  (`aws sso login --profile <name>`).
- The remedy list's "request a new set" became "request new ones" — with a *backup set* now
  named in the same message, "set" could only be read wrong (CONTEXT.md reserves the word).
- The expired path is unit-tested from both SDK texts; nothing enforces that the texts stay
  current, by design (see the failure mode above).

## Amendment (2026-09-05): the Roles Anywhere exchange joins the resolve-time frame

[0057](0057-roles-anywhere-credential-mode.md) added a fourth credential mode whose failures
went the other way. `resolveCredentials` returned from the Roles Anywhere branch *before* the
`try` that gives the chain's failure its set-scoped frame, so only the once-per-machine "no
identity" case got the polished message, while the *recurring* failure — the `CreateSession`
exchange refused (a stack torn down or deployed in another region, a certificate the trust
anchor no longer vouches for), a body that wasn't the session JSON, a timeout — surfaced as a
hand-written plain `Error` with an HTTP status and a response body. It reached the request-time
relay ([0037](0037-aws-auth-error-categorization.md)) and matched none of its rows, all keyed on
`name`/errno. One user-facing concern, two families that shared nothing.

**So the frame covers both halves of the exchange**, and the line between "credential failure"
and "transport failure" is drawn by **type, at the throw site**:

- `createSession` throws a `RolesAnywhereSessionError` (`src/lib/error.mjs`) for everything the
  endpoint *said* — a non-2xx, a non-JSON or credential-less body, the inactivity timeout — with
  the message reduced to the reason, terse and factual, because the frame quotes it as step 2's
  "which reported:". `resolveRolesAnywhereCredentials` catches that type alone and hands it to
  `noCredentialsError` with `rolesAnywhere: "session"`; the absent-identity case is
  `rolesAnywhere: "identity"`. Each is a `credentialCase` of its own, with step 2 naming the
  machine identity or the endpoint rather than the ambient chain, and the fix spelled for the
  set's bucket (`S3CAB_BUCKET` is in the environment by then).
- A socket error — `ENOTFOUND`, `ECONNRESET`, a happy-eyeballs `AggregateError` — is **rethrown
  raw**. The relay's network retry keys on the errno, and a wrapper would hide it; the earlier
  entry's premise that the relay "never sees" this path was wrong, and that is exactly why the
  catch must be narrow. The request-time table itself is untouched, as this ADR already required.
- The expiry hand-off above is **skipped** in Roles Anywhere mode. "Expired" in a refusal is AWS
  describing the certificate or the trust anchor, and `aws sso login` would be the wrong
  instruction — the one thing the message match was accepted on condition of never giving.

The readiness rule moved the same way: `setup --roles-anywhere` refused a set without a
complete identity and `provider --roles-anywhere` did not, though both go through
`gatherProviderConfig`. The gate now lives there (`src/lib/provider.mjs`), so a marker is never
written for an identity that would fail the very next cloud op, and both doors print the same
recipe (`setupSteps` in `src/lib/roles-anywhere.mjs`, the one home for the three commands).
