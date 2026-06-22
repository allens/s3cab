# Handoff: Architecture candidate #2 — make the "env is loaded" precondition unrepresentable

> Provisional design note (per [proposals/README.md](README.md)) — delete once candidate #2
> ships or is abandoned. Written as a cold-start handoff for a fresh session/machine.

## Where things stand (baseline = `main`)
- **Candidate #1 shipped** (PR #93, merged): a resolved `BackupSet` now carries its own
  derived paths — `readSet`/`resolveSet`/`writeSet` return
  `{ name, dirs, bucket, snapshotsDir, excludePath, envPath }`, the path-builders
  (`setEnvPath`/`setSnapshotsDir`/`setExcludePath`) are unexported, and the
  `~/.s3cab/sets/<name>/…` layout lives only in `src/lib/sets.mjs`. `loadEnv` was retyped to
  take a resolved set and read `set.envPath` (typed to `{ envPath }`).
- **Deny-rule fix shipped** (PR #95, merged): `.claude/settings.json` `Bash(git push *+*)` →
  `Bash(git push * +*)`, so worktree branch names containing `+` are no longer blocked.
- `main` is the clean baseline to branch from.

## The candidate
**Goal:** turn a load-bearing ordering invariant that today lives only in JSDoc into something
construction/types enforce.

Every remote function carries a comment like *"Callers must have loaded their env
(`loadEnv()` or `loadEnv(set)`) first"* (`src/lib/set-marker.mjs`, `src/lib/remote.mjs`,
`src/lib/objects.mjs`, `src/lib/s3.mjs`). Nothing enforces it; violating it surfaces as an
opaque AWS credential error far from the cause. `src/lib/env.mjs`'s `prepareRemoteSet` already
consolidates "resolve + loadEnv" (ADR-0022) but returns a plain `BackupSet` — no proof env was
loaded.

**Deepening:** make `prepareRemoteSet` the *only* constructor of a `PreparedSet` value that the
remote operations require as input. Illegal state (a remote op without env) becomes
unrepresentable; strengthens ADR-0022. This builds directly on candidate #1 — `resolveSet`
already returns a richer set value, so adding the "prepared" guarantee is the next layer on the
same seam.

## Key files
- `src/lib/env.mjs` — `prepareRemoteSet`, `loadEnv` (the front door).
- `src/lib/set-marker.mjs` — `claimRemoteSet`, `readRemoteInfo`, `writeRemoteInfo`,
  `pushSetConfig`, `readSetConfig`, `listRemoteSets`.
- `src/lib/remote.mjs` — `uploadSnapshot`, `readLatestRemoteSnapshot`, `readRemoteSnapshot`,
  `listRemoteSnapshots`, `downloadRemoteSnapshots`.
- `src/lib/objects.mjs` / `src/lib/s3.mjs` — the SDK-facing ops carrying the same precondition.
- Callers: `src/commands/{backup,status,restore,setup}.mjs`.
- ADRs: `docs/adr/0022-prepare-remote-set-front-door.md` (this strengthens it).
  Vocabulary: `CONTEXT.md`.

## Decisions to grill (start with the `grilling` skill)
1. **How do you "brand" a type in plain JS + JSDoc?** It's structurally typed, so "a type only
   `prepareRemoteSet` can mint" needs a class, a private-symbol brand field, or a runtime token.
   This is the crux — weigh against the minimalism edict (CLAUDE.md #8 / ADR-0006): is the brand
   worth the ceremony, or is the real win just at the one door `prepareRemoteSet` already is?
2. **The `setup` create/inherit wrinkle (most important).** Those paths call `set-marker` ops
   (`claimRemoteSet`, `readRemoteInfo`, `listRemoteSets`, `readSetConfig`) **before a local set
   exists**, with only the *user* env layer loaded (`loadEnv()` no-arg). So "PreparedSet = a
   resolved set + env" does **not** fit them. Decide whether the guarantee is about *a set's* env
   vs *some* env loaded — `PreparedSet` may need to be broader than a set, or create/inherit stay
   a separate documented path.
3. **Which ops require it** — set-marker vs remote vs objects/s3 layers; where the seam sits.
4. **Testability** — how tests construct a `PreparedSet` without real credentials (mirror the
   `loadEnv` `{ envPath }` narrowing decision from candidate #1).

## Workflow reminders
- **Node v26.3.0** required for tests (`.nvmrc`; `Temporal` is used). `nvm use` — but **don't
  pipe `nvm use` through `tail`/another command** (subshell swallows the PATH change); if `node`
  still resolves to the wrong version, prepend `~/.nvm/versions/node/v26.3.0/bin` to PATH.
- `npm run typecheck` · `npm run lint` · `npx prettier --check "src/**/*.mjs"` · `npm test`.
- Work in a **worktree** (CLAUDE.md #13); the `+` push papercut is fixed, so `feat/…` worktree
  branches push fine now. Request a **Copilot review** after `gh pr create` (CLAUDE.md #15,
  GraphQL `requestReviews` `botIds` mutation).
- Pre-1.0 → bold, correct refactors are fine (CLAUDE.md #8).

## The rest of the architecture review (not yet done)
Candidate #3 (separate the upload *plan* from execution), #4 (snapshot-file owns the TSV format
end-to-end — `walk.mjs` stops writing format lines), #5 (a progress-writer module). #2 is the
recommended next because it builds straight on #1.
