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
