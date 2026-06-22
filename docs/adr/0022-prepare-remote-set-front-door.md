# Env is loaded at the entry point; the set layer goes through the `loadSet` door

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
don't-over-engineer edict ([0006](0006-minimal-code.md) / CLAUDE.md #8):

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
- **Home.** `loadEnv`/`loadSet` live in `env.mjs`, which already owns the env layering and
  depends on `sets.mjs` (for `resolveSet`) — no new cycle. The snapshot/object-op JSDoc
  preconditions now state the structural invariant ("user env is loaded at the entry point
  before any command runs; set commands also load their set env via `loadSet`") rather than a
  per-call "load env first" instruction.
