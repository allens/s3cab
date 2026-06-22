# Handoff: load user env at the entry point; a `loadSet` door for set env

> Provisional implementation plan (per [proposals/README.md](README.md)) — delete once it ships
> or is abandoned. Written as a cold-start handoff for a fresh session/machine, because the
> session that produced it wandered in from a different starting point (see "How we got here").

## TL;DR

Today every command re-states and re-implements a precondition — *"load s3cab's env into
`process.env` before any S3 op"* — enforced by nothing but JSDoc. Instead of **enforcing** it
(a brand/token/class — all rejected, see below), **dissolve** it: load the user env **once at
the entry point**, and have every set-accepting command load its set env through one **`loadSet`**
door. Then the precondition is true by construction, the scattered `loadEnv()` calls collapse to
two structural points, and there is nothing left for an architecture scan to flag.

This is **not** more machinery — it removes machinery. No new types, no class, no brand.

## How we got here (so you don't re-tread it)

- This supersedes **architecture candidate #2** (PR #96, the `PreparedSet`/"make the env
  precondition unrepresentable" handoff). **Close PR #96** — its premise is abandoned.
- We tried two ways to *type-enforce* the precondition and **rejected both**, on the
  don't-over-engineer edict (CLAUDE.md #8 / ADR-0006):
  - A **pure-JSDoc `Bucket` brand** (a phantom `string & {__envLoaded}` minted by a cast at the
    door). Worked, but it was defensive structure guarding a caller that doesn't exist, for a
    precondition that has **never once been violated** in practice.
  - An **RAII `Bucket` class** (private ctor + factory that loads env). Conceptually the cleanest
    *enforcement*, but a read of the code showed it would either become a 14-method god-object
    spanning `objects/`+`snapshots/`+`sets/` (destroying the per-area module ownership of
    ADR-0013/0014/0023) or be a thin string-wrapper that simplifies nothing. The bucket isn't
    actually tangled — `s3.mjs` is URI-based, so `bucket` never threads below the three lib
    modules.
- The breakthrough: the real fix isn't to *guard* "did you load env?" at each S3 op, it's to make
  env **always already loaded** before any op runs. That's this plan.

## The decision (settled)

**Two functions, cleanly orthogonal:**

- **`loadEnv()`** — applies the **user** layer (`~/.s3cab/env`) only. Drop its current optional
  `set` param. Called by **(1)** the CLI entry point [src/s3cab.mjs](../src/s3cab.mjs) before it
  dispatches a command, and **(2)** a library consumer once before using the API (a documented
  convention — see below). **Commands do not call it.**
- **`loadSet(setName)`** — resolves the set (`resolveSet`) **and** applies the **set** layer
  (`~/.s3cab/sets/<set>/env`) on top, returning the resolved `BackupSet`. Replaces
  `prepareRemoteSet`. Every command that takes a set argument routes through it. It is exported
  only so the `commands/` modules can import it — it is **internal**, not part of the documented
  consumer surface.

**Key properties that make this correct and minimal:**

1. **`loadSet` applies only the set layer**, not user-then-set. The user layer is *guaranteed*
   already loaded (entry point, or consumer convention), so re-applying it would be the same
   redundant guard we're removing. Precedence (`set > user`) still holds because user went on
   first. (`applyEnvLayer` is already idempotent per file, so even an accidental double-apply is a
   no-op — but we simply don't.)
2. **Loading env files ≠ building the S3 client.** `loadEnv` only reads small files into
   `process.env`; the S3 client stays lazily constructed in `s3.mjs` (`client()`), and
   `resolveCredentials` only fires on an actual S3 call. So loading user env at the entry point
   does **not** break the "local commands (`list`/`tree`/`snapshot`/`compare`) need no AWS creds"
   property — they still never construct a client. Likewise, routing those local commands through
   `loadSet` (which reads the set `env` file) keeps them cred-free: reading a file is not a client
   build.
3. **No `loadSetEnv` helper.** Loading a set's env is *always* paired with resolving that set —
   nothing wants one without the other — so it lives inside `loadSet`, not as a separate named
   function (#8).
4. **The library-consumer contract is one call: `loadEnv()` once before using the API —
   uniformly, for every command.** Because `loadSet` adds only the *set* layer, a set command
   relies on that up-front user load too (the common-case credentials live in the **user** layer),
   so the contract is identical for set and bucket commands. There is no "this command self-loads,
   that one doesn't" asymmetry — one rule. Document it in `loadEnv`'s JSDoc; do **not** stand up a
   separate consumer guide (s3cab is CLI-only today — #8).

### Worked traces (so the two-points model is unambiguous)

CLI — `s3cab backup photos`:
1. entry point ([s3cab.mjs](../src/s3cab.mjs)) calls `loadEnv()` → **user** layer in `process.env`
2. `backup()` calls `loadSet("photos")` → **set** layer applied on top (`set > user`)
3. `uploadSnapshot(...)` first builds the S3 client → it reads the fully-layered `process.env`

CLI — `s3cab tree photos` (local, no S3): steps 1–2 identical; no client is ever built (reading
the env files is not a client build — property #2), so it still needs no AWS creds.

Library consumer:
```js
import { loadEnv } from "s3cab/.../env.mjs";
import { backup } from "s3cab/.../backup.mjs";
loadEnv();                 // the one-call contract — user layer
await backup("photos");    // backup's loadSet adds the set layer
```

`loadSet()` with no name keeps the **sole-set default** (it wraps `resolveSet`), so
`s3cab backup` with exactly one set still works.

## The change set (concrete)

> Line numbers are from the branch point; they drift — grep for the symbol if a hunk doesn't
> match. Pre-1.0, so be bold (CLAUDE.md #8); favour getting the shape right. **Anything not listed
> here is unchanged** — e.g. `sets`, `help`, and `--version` take no set and need no edit (the
> entry-point `loadEnv()` covers them; `--version`/`help` exit before it, which is fine — they
> touch nothing).

### 1. `src/lib/env.mjs` — the two doors
- `loadEnv(set?)` → **`loadEnv()`**: drop the `set` param; apply only the user layer. Update the
  doc comment (it is now "the single up-front user-env load; entry point + consumer call it;
  commands don't").
- `prepareRemoteSet(setName)` → **`loadSet(setName)`**: `const set = resolveSet(setName);` then
  `applyEnvLayer(set.envPath, parseEnvFile(set.envPath));` then `return set;`. Doc: "the set door;
  user env is already loaded, so this adds only the set layer; precedence holds."
- Keep `applyEnvLayer`/`parseEnvFile`/`appliedEnvFiles`/`userEnvPath` as-is. Refresh the module
  header comment to describe the new model (user up front, set via `loadSet`).

### 2. `src/s3cab.mjs` — load user env before dispatch
- Import `loadEnv` from `./lib/env.mjs`.
- Call `loadEnv();` immediately before `const result = await command.exec(...)` (i.e. **after**
  the `--version`/`help`/unknown-command early exits, so those don't load env; **inside** the
  `try` so a malformed env file surfaces through the existing error handler).

### 3. Set-accepting commands → `loadSet` (and they now load set env)
Each currently calls `prepareRemoteSet` or `resolveSet`; switch to `loadSet` (import from
`../lib/env.mjs`; drop the `resolveSet` import from `../lib/sets.mjs` where it becomes unused):
- `backup.mjs` (`prepareRemoteSet` → `loadSet`)
- `status.mjs` (`prepareRemoteSet` → `loadSet`)
- `restore.mjs` (`prepareRemoteSet` → `loadSet`)
- `list.mjs` — **both** paths: the `--remote` `prepareRemoteSet` → `loadSet`, **and** the local
  `resolveSet(setName).snapshotsDir` → `loadSet(setName).snapshotsDir`
- `snapshot.mjs` (`resolveSet` → `loadSet`)
- `compare.mjs` (`resolveSet` → `loadSet`)
- `tree.mjs` (`resolveSet` → `loadSet`)

(Local commands loading set env is intended — "any command that accepts a set arg loads its set
env" — and is cred-free per property #2. Call this out in the PR description so a reviewer doesn't
read it as an accidental client build.)

### 4. Bucket-family commands → delete their `loadEnv()`
- `upload.mjs`: remove the `loadEnv();` call and the `loadEnv` import (user env now comes from the
  entry point). **Do not** add anything back to "make it self-contained" — that would re-introduce
  the redundant guard we are removing.
- `hashes.mjs`: same.

### 5. `setup.mjs` — three paths
- **create**: remove `loadEnv();` (entry point loads user env; create needs no set env — it is
  *writing* the set).
- **inherit**: remove `loadEnv();` (same).
- **update**: it currently reads the set, then later loads its env:
  ```js
  const existing = readSet(name);
  if (options.bucket && options.bucket !== existing.bucket) { throw … }
  const dirs = …; const set = …;
  loadEnv(set);                                   // ← remove
  await pushSetConfig(existing.bucket, name, …);
  ```
  Become:
  ```js
  const existing = loadSet(name);                 // resolve + load set env, in one
  if (options.bucket && options.bucket !== existing.bucket) { throw … }
  const dirs = …; const set = …;
  await pushSetConfig(existing.bucket, name, …);
  ```
  (`loadSet(name)` with an explicit name resolves exactly that set — same as `readSet(name)` —
  and the bucket-match check is pure-local, so order is fine.)
- Adjust `setup.mjs` imports: import `loadSet` from `../lib/env.mjs`; drop `loadEnv`; drop
  `readSet` from `../lib/sets.mjs` if `update` was its only user.

### 6. `resolveSet` stays
It remains the env-free inner resolver that `loadSet` wraps (and `readSet`'s error path uses). No
command imports it after step 3. Update its doc comment (it currently name-drops `prepareRemoteSet`
and "offline commands call `resolveSet` directly" — both now stale → mention `loadSet`).

## Tests are consumers — push the work onto the tests

**Guiding principle from the user:** *prefer making a test do the env setup over soiling the
purity of the real code.* Do **not** re-add `loadEnv()` to commands/lib to make tests pass.

What changes: a test that calls a command/lib function directly no longer gets env loaded for
free (the CLI entry point, which now does the user load, isn't in the picture). So:
- **Any test that calls a command — or an S3-touching lib op — directly must `loadEnv()` first**
  (the uniform contract); for a set op, the command's `loadSet` then adds the set layer. This
  covers `upload`/`hashes` (which lost their own `loadEnv`) and every set command alike.
- `src/lib/env.test.mjs` is the big one: its `prepareRemoteSet` block → `loadSet`, and its
  `loadEnv(set)`-layering tests split into `loadEnv()` (user) + `loadSet()` (set-on-top, with
  user pre-loaded). `resolveSet` tests in `sets.test.mjs` are unaffected (`resolveSet` unchanged).

Don't try to enumerate every affected test up front — **run `npm test` + `npm run typecheck` and
fix what breaks**; that surfaces the exact set. Each fix is the same shape (arrange env in the
test's setup).

## Docs to update (part of the same PR)
- **Rewrite [ADR-0022](../docs/adr/0022-prepare-remote-set-front-door.md)** to the new model: the
  precondition is now satisfied structurally (user env at the entry point; set env via the
  `loadSet` door), not enforced and not hand-coded per command. Note the rejected alternatives
  (brand, RAII class) in one paragraph so the architecture scan's re-suggestion is pre-answered.
  Retitle + update the index line in `docs/adr/README.md`.
- **Leave [ADR-0011](../docs/adr/0011-validation-in-command-functions.md) alone** — it governs
  *hard parameter validation* (which stays in the command functions); env-loading is a
  side-effect, ADR-0022's concern, so 0011 is untouched. (Say this in the ADR-0022 rewrite.)
- **Reword the "Callers must have loaded their env first" JSDoc** on the S3-touching ops in
  `objects.mjs`, `remote.mjs`, `set-marker.mjs`, `s3.mjs` to state the new invariant ("user env is
  loaded at the entry point before any command runs; set commands also load their set env via
  `loadSet`"). This is also what removes the "shallow unenforced seam" the scan keys on.
- **Update [CLAUDE.md](../CLAUDE.md)** where it documents the front door — the "Auth splits in
  two… `loadEnv`/`prepareRemoteSet`" bullet under Architecture orientation — to `loadEnv`/`loadSet`
  and the new model. Grep the repo for `prepareRemoteSet` and fix every reference (CONTEXT.md too,
  if it carries the term).

## Workflow reminders
- **Node v26.3.0** for tests (`.nvmrc`; `Temporal` is used). `nvm use` — don't pipe it through
  another command (subshell eats the PATH change).
- `npm run typecheck` · `npm run lint` · `npx prettier --check "src/**/*.mjs"` · `npm test`.
- Work in a **worktree** (CLAUDE.md #13), sibling path `../s3cab.worktrees/<branch>`. It's a code
  change, so `npm install` in the fresh worktree first.
- One **feat/refactor branch → one PR** (CLAUDE.md #11). Commit per logical step. Request a
  **Copilot review** after `gh pr create` (CLAUDE.md #15, the GraphQL `botIds` mutation), and bring
  its comments back to discuss, don't auto-action (#10).
- Pre-1.0 → bold, correct refactors are fine (#8). This one *removes* code; lean into it.
