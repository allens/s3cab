# Env-loading for the set family goes through one front door

The set-family cloud commands (`backup`, `status`, `restore`, `list --remote`) resolve their
set and load its env through a single `prepareRemoteSet(set)` in
[src/lib/env.mjs](../../src/lib/env.mjs), called at the top of the command — not by
hand-coding the `resolveSet` + `loadEnv` pair at each site, and not by enforcing the
precondition in the remote operations' signatures.

This **refines** [0011](0011-validation-in-command-functions.md): env-loading still lives at
the command layer (the library surface), now via a shared helper the command *calls* rather
than an inline `loadEnv`.

## Why

The "load env before any S3 op" precondition was stated in JSDoc across `remote.mjs` and
re-coded identically at four command sites; the seam enforced it nowhere, so a forgotten
`loadEnv` silently targeted the wrong bucket's region/credentials. One front door gives the
precondition a single home (locality) and an obvious thing for a new command to copy.

**Consolidated, not enforced — deliberately.** We weighed threading a "prepared set" token
into every remote/object op so the precondition couldn't be skipped (a bare
`uploadSnapshot(bucket, namespace)` call would then fail to compile). Rejected: the only
thing it buys is protection against a future caller that doesn't exist, and it would tax
every remote op's signature with a token that merely asserts a `process.env` side effect
happened. The asymmetry favours consolidation — you might get bitten once when a new command
forgets the front door, fix it in minutes, and never worry again; the enforce version is
permanent defensive structure (against [0006](0006-minimal-code.md) / the don't-over-engineer
edict).

## Consequences

- **Scope is the set family only.** The bucket family (`upload`, `hashes`, `setup`) already
  has its bucket in hand as a CLI arg and calls `loadEnv()` in one line (a bare `loadEnv()`
  since [ADR-0025](0025-drop-per-bucket-env-layer.md) dropped the per-bucket layer); a
  `prepareBucket()` wrapper would be a pass-through, so those keep the inline call. The
  snapshot-op JSDoc preconditions name the real requirement — the *env loaded* before any S3
  op — and note `prepareRemoteSet` as the set-family path (`listRemoteSnapshots` is in
  fact reached both ways: `setup` directly, the set family via the front door).
  `listRemoteNamespaces` and the `objects.mjs` ops keep the plain `loadEnv` wording.
- **Home.** `prepareRemoteSet` lives in `env.mjs`, which already owns `loadEnv` and depends
  on `sets.mjs` (for `resolveSet`) — no new cycle. `resolveSet` is the env-free inner step,
  reached only through `prepareRemoteSet` for cloud use; since every set is bound to a bucket
  at setup ([ADR-0026](0026-bucket-required-at-setup.md), enforced in `readSet`), the resolved
  set is already cloud-ready and there is no separate bucket-guarding tier — the original
  `resolveRemoteSet` folded back into `resolveSet`. This pass also split env-layering out of
  `auth.mjs` into `env.mjs`, leaving `auth.mjs` credentials-only.
- A new `remote.mjs`/`objects.mjs` caller must still remember the precondition — now "go
  through `prepareRemoteSet`" — since it is not compiler-enforced.
