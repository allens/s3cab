# `provider` — the neutral connection-config door; `aws` narrows to AWS-only

**Status:** accepted (settled 2026-07-09, in the non-AWS onboarding design conversation
that followed the secrets-management work). Supersedes the *name* chosen in
[0041](0041-auth-command-hosts-credential-guide.md) (`auth` → `provider`; the
hosted-guide pattern and the scope model stand), and amends
[0035](0035-aws-profile-sets-command-rationalization.md) point 1: `aws` keeps the name but
loses the non-AWS recipe it had carried since the `bucket` days.

## Context

Non-AWS S3 providers (Cloudflare R2, Backblaze B2, Wasabi, MinIO, …) are first-class
targets ([docs/design/s3-provider-compatibility.md](../design/s3-provider-compatibility.md)),
and for every one of them onboarding reduces to three strings — endpoint, access key,
secret key — plus a region label. Yet the command surface served that audience badly,
**assuming no AWS CLI on the machine** (the correct assumption off AWS):

- The provider-neutral onboarding recipe lived inside a command named **`aws`** — a name
  that audience has no reason to type — and was gated behind a catch-22: `s3cab aws`
  only selected the neutral recipe when a custom endpoint was *already set*, but the
  recipe itself is where a user learned to set the endpoint.
- **No command wrote the endpoint, region, or keys.** `auth` set only `AWS_PROFILE` — an
  `~/.aws` concept — while its show mode *displayed* an endpoint it had no flag to set.
  The remaining knobs were "hand-edit `~/.s3cab/env`".

[0041](0041-auth-command-hosts-credential-guide.md)'s own principle — *name the command
after the concern, not the mechanism* — resolves this: with non-AWS first-class, the
concern turned out bigger than sign-in. It is "which storage provider, where, and how
s3cab signs in to it". `auth` covered only the credential slice.

## Decision

1. **`auth` becomes `provider`** — set, clear, or show the connection to your storage
   provider, at the user or per-set scope (scope model unchanged from
   [0031](0031-aws-profile-config-door.md)/0041):
   - `--profile <name>` — exactly the old `auth --profile` (read-only `~/.aws`
     validation and all);
   - `--endpoint <url>` — writes `AWS_ENDPOINT_URL_S3` (validated as an http(s) URL);
   - `--region <region>` — writes `AWS_REGION` (any string; providers vary, `auto` is
     real for R2);
   - `--keys` — writes `AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY`, read **never from
     flags** (the standing non-goal: flags leak via shell history and the process
     table): on a TTY it prompts (key echoed, secret hidden, sudo-style no-echo); off a
     TTY it reads two lines from stdin, so scripts pipe them;
   - `--unset <knob>` — now takes the knob to clear (`profile` | `endpoint` | `region` |
     `keys`), since the command owns four knobs where `auth` owned one;
   - no flags — show mode, per knob, with the `~/.aws` profile cross-check kept and key
     *presence* only (never the secret). Setters may be combined in one call; `--unset`
     stays exclusive.
2. **The non-AWS onboarding recipe moves out of `aws` into `provider`'s registry
   description** (the 0041 hosted-guide pattern — "option (a)"), alongside the credential
   guide it already hosted. `provider`'s show mode does the discovery: nothing configured
   → point at `s3cab help provider`. A *generative command* for the recipe (option (b))
   was rejected: its interpolated env template is exactly what `--endpoint`/`--keys`
   replace, `provider <bucket>` would collide with the `[<set>]` positional, and a
   vendor-neutral sibling name would reintroduce the discoverability problem being fixed
   ([0006](0006-minimal-code.md): five console-first steps don't earn a command file).
3. **`aws` is AWS-only.** It keeps the IAM/SSO recipes (where its name is honest) and its
   final step becomes `s3cab provider --profile …`. With a custom endpoint set it no
   longer guesses: it points at `s3cab help provider` instead of printing IAM JSON.
   `nonAwsPlan` is deleted from `src/lib/aws.mjs`.
4. **The no-credentials guidance becomes endpoint-aware** (`credentialGuidance`,
   [src/lib/auth.mjs](../../src/lib/auth.mjs)): with a custom endpoint set and no profile,
   the first advice is `s3cab provider --keys` — not "point s3cab at an AWS profile",
   which assumes tooling a non-AWS user doesn't have. The four error pointers move to
   `Run 's3cab help provider'`.

Pre-1.0, so no `auth` alias or deprecation shim (the same consequence 0041 applied to
`profile`). `src/lib/auth.mjs` (credential *resolution*) keeps its name — it is the
mechanism, not the command.

## Consequences

`src/commands/auth.mjs` → `provider.mjs` (export renamed, one-export-per-command);
`src/lib/prompt.mjs` is new (the key-pair reader: TTY prompt with hidden secret, else two
stdin lines — kept deliberately minimal, raw-mode no-echo, no masking rendering). Every
printed `s3cab auth …` suggestion and `help auth` pointer (onboarding recipes,
`credentialGuidance`, README, guide, design docs) now says `provider`. "Provider" enters
[CONTEXT.md](../../CONTEXT.md). The `docs/design/s3-provider-compatibility.md` "friendlier
per-destination endpoint/credential UX" out-of-scope item is now built — this ADR is it.
