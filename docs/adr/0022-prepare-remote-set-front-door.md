# Env is loaded at the entry point; the set layer goes through the `loadSet` door

**Status:** accepted

s3cab's "load env before any S3 op" precondition is satisfied **by construction**, not
enforced per command:

- The **user** env layer (`~/.s3cab/env`) is applied **once at the CLI entry point**
  ([src/s3cab.mjs](../../src/s3cab.mjs) calls `loadEnv()` before dispatching any command), so
  by the time any command body runs the user layer is already in `process.env`. A library
  consumer makes the same one call before using the API.
- The **set** env layer (`~/.s3cab/sets/<set>/env`) is applied by **`loadSet(setName)`** in
  [src/lib/env.mjs](../../src/lib/env.mjs) — the door every set-accepting command routes
  through. It resolves the set (`resolveSet`, the sole-set default) and applies that set's env
  layer on top of the already-loaded user layer, returning the resolved `BackupSet`.

So there is no precondition left to *enforce*: every command runs with the user env already
loaded, and any command that names a set loads that set's layer through the one door. The
scattered `loadEnv()` calls collapse to two structural points (the entry point, and `loadSet`).

This **supersedes** the earlier model of this ADR — one `prepareRemoteSet(set)` front door
called at the top of each set-family command, which still re-stated the "load env first"
precondition at each site. The new model *dissolves* the precondition rather than centralising
its enforcement.

## Why

The old precondition — "load env before any S3 op" — was stated in JSDoc across `remote.mjs`,
`objects.mjs`, `s3.mjs`, and `set-marker.mjs` and re-coded at each command. The seam enforced
it nowhere, so a forgotten `loadEnv` could silently target the wrong region/credentials. The
fix is not to *guard* "did you load env?" at each S3 op but to make env **always already
loaded** before any op runs: load the user layer up front, add the set layer through one door.

**Loading env ≠ building the S3 client.** `loadEnv`/`loadSet` only read small files into
`process.env`; the S3 client stays lazily constructed in `s3.mjs`, and `resolveCredentials`
only fires on an actual S3 call. So loading the user env at the entry point does **not** break
the property that the local commands (`snapshot`/`compare`/`tree`/`list`) need no AWS creds —
they still never construct a client. Routing those local commands through `loadSet` (which
reads the set `env` file) keeps them cred-free for the same reason: reading a file is not a
client build.

**`loadSet` applies only the set layer.** The user layer is guaranteed already loaded (entry
point, or the consumer's one call), so re-applying it would be the same redundant guard this
design removes. Precedence (`set > user`) still holds because user went on first.
(`applyEnvLayer` is idempotent per file, so even an accidental double-apply is a no-op.)

### Rejected alternatives (so the architecture scan's re-suggestion is pre-answered)

We weighed two ways to *type-enforce* the precondition and rejected both, on the
don't-over-engineer edict ([0006](0006-minimal-code.md) / CLAUDE.md #7):

- **A "prepared set" / `Bucket` brand** — a phantom `string & {__envLoaded}` minted by a cast
  at the door, so a bare `uploadSnapshot(bucket, …)` would fail to compile. It works, but it is
  defensive structure guarding a future caller that doesn't exist, for a precondition that has
  never once been violated in practice — and it taxes every remote op's signature with a token
  that merely asserts a `process.env` side effect happened.
- **An RAII `Bucket` class** (private ctor + factory that loads env). Conceptually the cleanest
  *enforcement*, but a read of the code showed it would either become a god-object spanning
  `objects/`+`snapshots/`+`sets/` (destroying the per-area module ownership of ADR-0013/0014/0023)
  or be a thin string-wrapper that simplifies nothing. The bucket isn't actually tangled —
  `s3.mjs` is URI-based, so `bucket` never threads below the three lib modules.

The asymmetry favours dissolving the precondition over enforcing it: the entry-point load plus
the `loadSet` door make the precondition true structurally, with **less** code than either
enforcement scheme — and nothing left for a scan to flag.

### A development tripwire, not type-enforcement

We did *not* type-enforce (the brand/RAII above), but we did keep a cheap development tripwire.
`loadEnv()` drops an ambient `process.env.__S3CAB_ENV_LOADED` breadcrumb, and `s3.mjs`'s `client()`
`assert`s it (`node:assert`, the existing in-repo idiom for can't-happen invariants). It sits in
**one** place — `client()` — because every S3 op routes through it to reach the SDK, so a single
`assert` covers them all. (The env-reading helpers `clientConfig`/`customEndpoint` can't host it:
the client is memoized, so they run only on first construction, while `client()` runs on every op;
the assert is before the memoized `??=`, so cached-client ops are checked too.)

It is *debug scaffolding*, not real domain logic, and is shaped accordingly. In correct use it
never fires — the entry point always loads env, and a lib consumer who has plumbed `loadEnv` in
correctly never trips it. It earns its keep only as a tripwire for **incorrect wiring** (a consumer
who skipped `loadEnv`, or a test that forgot to arrange env), turning that into a clear error
instead of a client built against an unconfigured environment (a cryptic AWS credentials failure).
Because it is an ambient debug flag and not real state, it is deliberately *not* dressed up: the
breadcrumb is a bare `process.env` write/read at the two sites (no shared constant, no
`assertEnvLoaded` wrapper to encapsulate a name that doesn't need hiding — that would be the very
over-abstraction [0006](0006-minimal-code.md) warns against). A typo divergence between the two
literals isn't silent: it would make *every* S3 op throw, caught at once by the first run.
**Because the assert now catches a skipped load, the per-op JSDoc no longer restates the
precondition** — it lives in one place (`client()` + this ADR), not re-derived at every S3 op.

Note this only concerns values consumed from `process.env` at the SDK boundary (the `AWS_*` /
endpoint vars). `S3CAB_BUCKET` is read straight from the set env *file* into `BackupSet.bucket`
(never from `process.env`), and `S3CAB_DEBUG`/`S3CAB_HOME` are shell-bootstrap vars read before
`loadEnv` — none of them concern the tripwire.

## Consequences

- **`loadEnv()` takes no arguments.** It applies only the user layer. The entry point and a
  library consumer call it; **commands do not.** The set layer is `loadSet`'s job.
- **Every set-accepting command routes through `loadSet`** — the cloud ones (`backup`,
  `status`, `restore`, `list --remote`) and the local ones (`snapshot`, `compare`, `tree`,
  `list`) alike. The local commands loading their set env is intended and cred-free (see above).
- **The bucket family** (`upload`, `hashes`) takes a bucket as a CLI arg and no longer calls
  `loadEnv` at all — the entry point has already loaded the user layer. `setup` likewise drops
  its `loadEnv()` calls; its `update` path resolves the existing set through `loadSet`.
- **`resolveSet` stays** as the env-free inner resolver that `loadSet` wraps (and `readSet`'s
  error path uses). No command imports it directly any more.
- **This refines, and does not touch, [0011](0011-validation-in-command-functions.md).** That
  ADR governs *hard parameter validation*, which stays in the command functions; env-loading is
  a `process.env` side effect, this ADR's concern, so 0011 is untouched.
- **Home.** `loadEnv`/`loadSet` live in `env.mjs`, which already owns the env layering and depends
  on `sets.mjs` (for `resolveSet`). The tripwire needs no new module edge: `loadEnv` writes the
  `__S3CAB_ENV_LOADED` breadcrumb and `s3.mjs`'s `client()` reads it straight off `process.env`
  (`node:assert`) — an ambient flag, not an imported symbol.
- **The per-op JSDoc no longer restates the precondition.** The S3-touching ops in `objects.mjs`,
  `remote.mjs`, `set-marker.mjs`, and `s3.mjs` used to each carry a "callers must have loaded
  env" line; with the single `assert` in `client()` catching a skipped load, those restatements
  are gone — the invariant lives in one place (here + `client()`), not re-derived at every op.
