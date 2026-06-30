# A backup set's name is its whole identity

**Status:** accepted (2026-06-21) — supersedes the `user@machine` parts of
[0013](0013-one-repository-one-bucket.md) and [0014](0014-backup-sets.md). Implemented: the
set **name** is the whole identity, the remote layout flattened to `snapshots/<set>/`, the
`setup` collision check + `--inherit` succession + the `sets/<set>/` marker (`dirs.txt` /
`exclude.txt` / `info`) all landed. The full design is in
[docs/specs/backup.md](../specs/backup.md).

A backup set's **name** (a user-chosen `[a-z0-9-]+` label, e.g. `work-laptop`) is its *entire*
identity: it is at once the local handle, the local directory name, and the remote namespace.
The `user@machine:set` identity / `user@machine/set` namespace that [0014](0014-backup-sets.md)
pinned at creation is **dropped** — no machine, and no auto-derived `user`, in the stored
identity at all.

## Why

s3cab backs up *a person's data*, not a fleet of machines. Tying a set's identity to the
machine it was created on is fleet-management thinking: it forks the backup history when the
host is renamed or replaced, and forces an adoption ceremony to point a second machine at the
same data. The real anchor is "a user and their data," which the bare set name already names.

Uniqueness in a shared bucket — the one thing the `user@machine` prefix bought — is recovered
more simply by a **setup-time collision check** ("first person wins"): `setup` refuses a name
already present in the bucket and suggests `--inherit`. `$username` is offered as the suggested
default for the first set's name, nudging toward scoped names without *enforcing* structure.

## Consequences

- **Remote layout flattens** to `snapshots/<set>/<timestamp>.tsv.zst` (one segment, not
  `snapshots/<user>@<machine>/<set>/`). Directory-per-set, *not* a flat
  `snapshots/<set>-<timestamp>` filename, because a `-`-bearing name (`work-laptop`) can't be
  split back into (set, timestamp) and would prefix-collide with `work-laptop-backup`.
- **Set config is pushed to the remote** at `sets/<set>/{dirs.txt, exclude.txt}` — for
  full-DR recovery (a fresh machine restores the data *and* the set config) and as the
  collision-registration marker (a set with no snapshots yet is otherwise invisible). The set
  `env` is **never** pushed (it holds credentials), and the bucket name / namespace are not
  stored (redundant once in the bucket).
- **`--inherit` replaces `setup --from`** for the one legitimate succession case — retiring or
  recovering a machine. The flat name *is* the argument, so adoption collapses from
  `--from <user@machine/set>` to a bare boolean `--inherit`. Two live machines on one set is a
  discouraged-but-tolerated power-user case (e.g. a OneDrive-synced directory); it is never
  locked out, and `--inherit` must not disable the prior machine.
- **An advisory "created-on `<machine>`" field** lives in the remote `sets/<set>/` marker —
  surfaced only in the collision error to help a human choose rename-vs-inherit, re-stamped on
  a successful inherit. It is advisory metadata, never part of the identity, so it cannot
  reintroduce history-forking.
- **Defensive name/path code largely dissolves:** `validateNamespace` / `isNamespace` (the
  `user@machine/set` shape), `namespacePart` (the sha256 fallback), and the `S3CAB_NAMESPACE`
  pinning + the `namespace` field all go. `validateSetName` (`[a-z0-9-]+`) becomes the keystone
  guard — it is what keeps the single name clean as handle, path segment, and remote key with
  zero escaping anywhere downstream. `validateBucketName` and `assertPathSegment` (kept alive
  by the `objects.<bucket>` cache path) stay; `sanitizeNamePart` is demoted to cosmetic use
  for the `$username` default suggestion.
