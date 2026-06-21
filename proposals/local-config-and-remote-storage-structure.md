# Local config & remote storage structure — settled redesign

A reshape of how s3cab stores config and data, locally and remotely, and of the set identity
model. **Design settled** in a grilling session (2026-06-20); **mostly implemented** (2026-06-21).
The *why* of each major decision is recorded as an ADR — this file is the detailed design and
implementation home until the change *fully* lands, at which point `CONTEXT.md` +
`docs/specs/backup.md` are rewritten to match and this file is deleted.

> **Status (2026-06-21):** **ADR-0025 done** (per-bucket env dropped); **ADR-0024 done** (set
> name = whole identity, flattened `snapshots/<set>/`, `setup` collision check + `--inherit`,
> the `sets/<set>/` marker with `dirs.txt`/`exclude.txt`/`info`); **ADR-0026's setup-requirement
> done** (`--bucket` required at `setup`). **One slice remains** — ADR-0026's code cleanup:
> fold `resolveRemoteSet` into `resolveSet`, make `BackupSet.bucket` non-optional, and delete
> `formatSets`' "(no bucket — local only)" branch. **Delete this file when that lands.**

Decisions of record:
[ADR-0024](../docs/adr/0024-set-name-is-the-whole-identity.md) (set name = whole identity),
[ADR-0025](../docs/adr/0025-drop-per-bucket-env-layer.md) (drop per-bucket env),
[ADR-0026](../docs/adr/0026-bucket-required-at-setup.md) (bucket required at setup).

## Identity & naming

- A set's **name** is its entire identity — the local handle, the local folder name, *and* the
  remote namespace, one `[a-z0-9-]+` string (e.g. `work-laptop`). No `user`/`machine` component
  is stored. This drops the old `user@machine:set` identity / `user@machine/set` namespace.
- The anchor is "a user and their data," not a machine. Machine is not how a person thinks
  about their backup, and baking it into the identity forks history on host rename/replacement.
- Bucket-wide uniqueness is **"first person wins,"** enforced by a setup-time collision check.
- `setup` offers a sanitized `$username` as the **suggested default** name for the first set —
  a nudge toward scoped names, not enforced structure.
- `validateSetName` (`[a-z0-9-]+`) is the keystone guard that keeps the single name clean as
  handle, path segment, and remote key with no escaping downstream.

## Local layout (`~/.s3cab/`)

```
~/.s3cab/
├── env                      user-level env (auth defaults)
├── objects.<bucket>         per-bucket objects cache (unchanged)
└── sets/
    └── <set>/
        ├── dirs.txt         member directories, one absolute path per line
        ├── exclude.txt      optional exclude patterns
        ├── env              S3CAB_BUCKET + any per-set auth overrides (NO namespace pin)
        └── snapshots/
            └── <timestamp>.tsv.zst
```

- Folder-per-set is kept (not flattened to `~/.s3cab/<set>.dirs`): it mirrors the remote 1:1,
  avoids the `<set>-<timestamp>` snapshot-filename ambiguity, keeps "a set is one folder;
  delete the folder = delete the set," and reads cleanly under `ls ~/.s3cab/sets/`.
- `env` stays **inside** the set folder. The secret/non-secret boundary is enforced by the
  remote push being an explicit allowlist (`dirs.txt` + `exclude.txt` only), not by physical
  separation.

## Env layering

Collapses from four layers to three: **set > user > shell**. The per-bucket `env.<bucket>`
layer is removed (ADR-0025). Auth lives in the user env (single-bucket common case) or the set
env (overrides). **✅ Done (2026-06-21)** — ADR-0025's slice landed; this is the one part of the
redesign already implemented (`bucketEnvPath` + the per-bucket `loadEnv` branch removed,
`loadEnv` no longer resolves/returns a bucket).

## Remote layout (`s3://<bucket>/`)

```
s3://<bucket>/
├── objects/<sha256>                       content store (unchanged)
├── snapshots/<set>/<timestamp>.tsv.zst    one folder per set
└── sets/<set>/
    ├── dirs.txt                           pushed config (DR + collision marker)
    └── exclude.txt
```

- Snapshots are folder-per-set (`snapshots/<set>/…`), **not** flat
  `snapshots/<set>-<timestamp>` — a `-`-bearing name can't be split back into (set, timestamp)
  and would prefix-collide with another set (`work-laptop` vs `work-laptop-backup`).
- `dirs.txt` + `exclude.txt` are pushed for the **full-DR** story: point a fresh machine at the
  bucket, restore the data, and the set config comes back so it resumes backing up the same
  dirs/excludes (only creds need re-entering). Dirs are a machine-specific *hint*; excludes are
  portable. Writing `sets/<set>/` at setup also doubles as the **collision-registration
  marker** (a set with no snapshots yet is otherwise invisible).
- The set `env` is **never** pushed (credentials). The bucket name and namespace are not stored
  (redundant once in the bucket).
- The remote `sets/<set>/` marker also carries an **advisory "created-on `<machine>`" field**,
  surfaced only in the collision error to help a human choose rename-vs-inherit, and re-stamped
  on a successful `--inherit`. Advisory only — never part of the identity.

## Setup & inherit

- **`--bucket` is required** (ADR-0026); setup always touches S3. Local-only (bucket-less) sets
  are dropped. Offline `snapshot`/`compare`/`tree` still work *after* a one-time online setup.
- **Create:** `s3cab setup <name> <dirs…> --bucket <b>`. Collision-check `sets/<name>/`; if it
  exists → error naming the owning machine and suggesting `--inherit`; else claim the marker +
  create the local set.
- **Inherit (succession):** `s3cab setup <name> --inherit --bucket <b>`. Requires `sets/<name>/`
  to exist remotely; pulls its `dirs.txt`/`exclude.txt`, creates the local set, re-stamps the
  owning machine. No dirs argument. For machine **retirement/replacement or DR only**.
- **Two live machines on one set** is a discouraged-but-tolerated power-user case (e.g. a
  OneDrive-synced folder, where both machines hold the same content so the interleaved-snapshot
  confusion is benign). It is never locked out, and `--inherit` must not disable the prior
  machine.

## Code cleanup this unlocks

- **Removed (✅ ADR-0024):** ~~`validateNamespace` / `isNamespace`~~, ~~`namespacePart`~~,
  ~~`S3CAB_NAMESPACE` pinning + the `namespace` field~~, ~~`bucketEnvPath` + the per-bucket
  precedence branch~~ (✅ ADR-0025).
- **Still to remove (last slice, ADR-0026 cleanup):** the `resolveRemoteSet` two-tier resolver
  (fold into `resolveSet`; `BackupSet.bucket` becomes non-optional) — kept this slice because a
  bucket-less set can still exist until the resolver fold makes the type honest.
- **Kept:** `validateSetName` (the keystone), `validateBucketName` (input sanity),
  `assertPathSegment`.
- **Demoted (✅):** `sanitizeNamePart` to `validateSetName`'s suggestion + the `$username`
  default.
- **Leftover settled:** `assertPathSegment` **stays** on the set-name→folder path — it is
  load-bearing for `loadEnv({ set })` / `setEnvPath`, which build the path *without* a
  `listSets()` membership check (there's a test pinning it); `validateSetName` + `listSets()`
  do not fully cover it.

## At implementation time

- ~~Flip ADR-0024/0025 to accepted~~ ✅; ADR-0026 is **partly accepted** (setup-requirement done,
  resolver fold pending). ~~Drop the "pending" notes on [0013] / [0014]~~ ✅ (now marked
  "historical").
- ~~Update `CONTEXT.md`~~ ✅ (Identity/Namespace collapsed into the set name, Inherit verb,
  bucket-required Setup).
- Update `docs/specs/backup.md`: ✅ banner + Status reflect the landed state; the **detail
  sections** (identity, on-disk, setup/inherit, `#SNAPSHOT`, remote layout) get their **full
  prose rewrite when the last slice lands** (with this file's deletion).
- **Delete this proposal file** once ADR-0026's resolver-fold slice lands.
