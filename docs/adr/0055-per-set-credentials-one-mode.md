# Per-set credentials: drop the user env layer; each set is one credential mode

**Status:** accepted (2026-07-12) — **implemented** (2026-07-12, PR #183). **Partly supersedes
[0025](0025-drop-per-bucket-env-layer.md)** (removes the *user* layer, leaving set > shell) and
**amends [0022](0022-prepare-remote-set-front-door.md)** (there is no user layer to load at the
entry point). Sharpens [0015](0015-standard-aws-credential-chain.md)'s "respect the existing AWS
setup, don't invent a parallel mechanism". Restructures the resolve-time error of
[0037](0037-aws-auth-error-categorization.md)'s sibling path.

## Context

The credential model is two precedence systems stacked on each other:

1. s3cab's **per-key env-file layering** — set > user > shell ([0025](0025-drop-per-bucket-env-layer.md)),
   merged into `process.env`;
2. inside that merged environment, the **AWS SDK chain's own cross-source order**
   ([0015](0015-standard-aws-credential-chain.md)) — static env keys (`fromEnv`) resolve *before*
   an `AWS_PROFILE`-based source (`fromIni`/`fromSSO`).

A code walkthrough of `noCredentialsError` surfaced that **these two orders can disagree**. If a
set's env sets `AWS_PROFILE` and the user layer sets `AWS_ACCESS_KEY_ID`/`_SECRET`, both land in
`process.env`; the chain then resolves the static keys *first*, so the user-layer keys silently
beat the set-layer profile — the exact opposite of what "set overrides user" promises. The bug is
that s3cab treats auth as a **bag of `AWS_*` variables** it hands the chain to arbitrate, with no
notion of *intent*.

Two further smells fell out:

- The **user layer is a parallel default mechanism** competing with the machine's real default
  (`~/.aws`, a default profile, exported `AWS_*`, an instance role). That is the very thing
  [0015](0015-standard-aws-credential-chain.md) says not to invent. Of the user layer's three
  jobs today — the per-set auth fallback, `provider`'s default write-scope, and the
  `upload --bucket` escape hatch's fallback — none needs a bespoke s3cab file; the standard chain
  already *is* the machine default.
- The four-state `credentialGuidance` exists mostly to untangle **user-vs-set profile confusion**
  (a profile set in one layer, resolving nothing). Remove the confusion and the branch collapses.

The env-file *mechanism* is not at fault and is kept: writing `AWS_*` into `process.env` lets the
SDK pick up profile/region/endpoint/keys natively with zero credential-construction glue — a
bespoke config file would be *more* machinery, not less. The only truly bespoke variable is
`S3CAB_BUCKET`. What is over-built is the *layering*.

## Decision

**1. Drop the s3cab *user* env layer (`~/.s3cab/env`).** A set's env
(`~/.s3cab/sets/<set>/env`) becomes the single s3cab layer, over the ambient shell + the standard
AWS chain. The machine-wide default is handed back to the standard AWS setup itself. This collapses
the layering to **set > shell** and removes the cross-layer profile-vs-keys trap's largest surface.

**2. A set carries exactly one credential mode — profile XOR keys XOR ambient — enforced at write
time.** `provider --keys <set>` clears any `AWS_PROFILE` on that scope, and `--profile` clears the
keys, each with a plain confirmation. A set env then always encodes one intent, and the silent
precedence within a scope becomes unrepresentable *through the front door*. Region and endpoint are
**orthogonal connection knobs** that pair with any mode.

- **profile** — `AWS_PROFILE` → delegate to `~/.aws` (itself possibly SSO / static keys /
  `credential_process`).
- **keys** — `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`, **long-lived only**. Temporary
  credentials (a session token) belong to a profile (auto-refreshed) or the ambient shell, and are
  **never written to a file** — they would rot within hours and make the file lie about being
  configured. `provider --keys` prompts for the pair only, no session token.
- **ambient** — the set writes no creds; a default profile / exported `AWS_*` / instance role
  supplies them via the chain.

**2a. `setup` accepts the provider knobs, reversing [0036](0036-setup-mutates-list-shows-drop-sets.md)
point 4.** With the user layer gone, credentials live only on the set — but the set doesn't exist
until `setup`'s first claim succeeds, and that claim itself needs credentials. For a non-AWS
provider (whose keys can't ride the ambient AWS chain) there is no way to configure the set's
mode *before* the set exists, so `setup` takes the same knob set as `provider`
(`--profile`/`--keys`/`--endpoint`/`--region`; `--roles-anywhere` joined with
[0057](0057-roles-anywhere-credential-mode.md)), authenticates the claim with them, and saves them
to the new set's env only on a win. `provider` remains the door for changing them afterwards.
(Landed in PR #183; previously recorded only as a code comment in `commands/setup.mjs`.)

**3. `provider` adopts the sole-set default.** With the user scope gone, a write with no set name
targets the **only** set (erroring on ambiguity — *"which set?"*); bare `provider` show summarizes
all sets. The old "explicit-scope-for-safety" exception was guarding the now-deleted *all-backups*
scope; once every scope is a specific set, a single-set user has one unambiguous target.

**4. The resolve-time error is restructured around the set.** It **names the set**, leads with an
optional **pinpoint diagnosis** line (profile-not-in-`~/.aws`, endpoint-set-but-no-keys), then a
constant **"looked in"** frame (the set env path + the ambient chain, embedding the chain's own
message), then a tailored **fix menu**. `noCredentialsError` is inverted: one classifier yields a
case's distinctive `{ annotation, diagnosis?, fix }`, one assembler owns the shared frame — the
four repeated full-message branches of `credentialGuidance` go away. The bare-`--bucket` (no set)
case is a **separate minimal template**, deliberately not forced into the frame (it is the
plumbiest plumbing command). No keys-present branch exists here: keys present means the chain
resolves *something*, so a wrong key surfaces later as a request-time rejection
([0037](0037-aws-auth-error-categorization.md)), a different message.

### Rejected / non-goals

- **Detecting a hand-edited "both profile and keys" set env.** The front door enforces one mode; a
  hand-edit that defeats it is the user's own risk. It would be near-trivial to spot at
  `authNotice` (both vars are in `process.env` by then) but adds low-value noise to a hot path
  ([0006](0006-minimal-code.md)) — not built.
- **Session tokens in files** — see mode "keys" above.
- **Touching the SDK or re-architecting resolution.** [0015](0015-standard-aws-credential-chain.md)
  stands: use the standard chain, invent nothing.

## Consequences

- **`env.mjs`** — the user layer and its entry-point load go; `loadSet` records the resolved set
  (name + `envPath`) in module state for the error to name. `profileSource`/`envSources` simplify
  (a value's origin is `set '<name>' config` or `your environment` — no user tier). The
  `__S3CAB_ENV_LOADED` breadcrumb of [0022](0022-prepare-remote-set-front-door.md) is re-homed or
  retired as the entry-point `loadEnv` shrinks.
- **`auth.mjs`** — `noCredentialsError`/`credentialGuidance` restructured (classifier + assembler,
  set-aware inputs); still sync, with the async `~/.aws` cross-check staying in `resolveCredentials`.
- **`provider.mjs`** — no user scope; sole-set default; mutual-exclusion clearing on `--keys`/`--profile`.
- **`s3.mjs`** — `authNotice`'s `profileSource` labels simplify.
- **`upload --bucket`** — the escape hatch is now **ambient-only** (no user-env fallback); a doc tweak.
- **Docs** — [docs/design/auth.md](../design/auth.md) rewritten to the set > shell model and the
  new error; README/guide credential sections; [0025](0025-drop-per-bucket-env-layer.md) carries a
  forward banner; this ADR is the record.
- **Slicing** — implementable in ~3 PRs: (1) drop the user layer + thread the set into the error;
  (2) one-mode-per-set enforcement in `provider` + sole-set default; (3) the error/guidance rewrite.
