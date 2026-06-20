# Snapshot format decisions

Epic: settle the format questions *while it is still young and uncommitted* — each of these is
hard to change once snapshots are in the wild.

- **Consider relative paths in snapshot files.** The base dir is already in the `#SNAPSHOT`
  header; storing paths relative would make backup dirs relocatable (today a renamed parent
  makes *every* file "moved"), shrink snapshot files, and make them portable across machines.
  Big format decision — weigh against #2/#4 while the format is still young and uncommitted.
- **Define the TSV tab/newline-in-path rule** (known gap). Simplest honest answer: reject such
  paths at snapshot time with a clear error naming the file.
- **Snapshot timestamps: timezone + precision.** Names use local time with no offset — DST
  fold can produce ambiguous/colliding names, and snapshots taken on machines in different
  zones don't order. UTC (or offset-suffixed) + seconds precision is worth deciding before the
  format freezes.
- **Decide restore fidelity now, while the format is young.** Snapshots store hash/size/mtime
  only: no empty directories, no permissions/owner, no Windows attributes. `restore` will be
  limited by what `snapshot` recorded — even if the answer is "content + mtime only,
  documented", decide it deliberately.
- **Cross-platform restore.** Snapshots store platform-native absolute paths; restoring a
  Windows backup on Linux (disaster-recovery scenario — the whole point of the tool) needs a
  path-translation story. Strengthens the relative-paths idea above.
