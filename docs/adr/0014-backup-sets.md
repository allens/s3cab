# Backup sets are the unit of snapshot, backup, and restore

A **backup set** is a named list of directories, configured at `~/.s3cab/sets/<name>/` with
an identity `user@machine:set` pinned at creation. It — not a single directory — is the unit
the porcelain operates on. Full design: [specs/backup.md](../../specs/backup.md).

## Why

A person backs up *their stuff* (several directories), across machines, into one bucket. The
set models that directly, and gives snapshots a stable namespace
(`snapshots/<user>@<machine>/<set>/`, see [0013](0013-one-repository-one-bucket.md)) so many
sets share one dedup pool without colliding.

## Consequences

- The local engine runs on sets: `snapshot`/`list`/`compare`/`tree` take `[<set>]`, walk every
  member dir with the set's `exclude.txt`, and write one snapshot (with `#SNAPSHOT` identity +
  `#DIR` headers) into `~/.s3cab/sets/<set>/snapshots/`. The old per-dir `<dir>/.s3cab/` has
  **retired entirely**.
- The set env layer (`~/.s3cab/sets/<set>/env`, written by `setup`) **replaced** the
  never-wired per-dir layer; cloud commands `loadEnv({ set })` ([0015](0015-standard-aws-credential-chain.md)).
- Implemented across slices 1–4 (2026-06); remaining scaffold (`verify`, `compare --remote`)
  tracked in the "Known gaps" list in [CLAUDE.md](../../CLAUDE.md).
