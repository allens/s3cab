import { loadSet } from "../lib/env.mjs";
import { listRemoteSnapshots } from "../lib/remote.mjs";
import { listSets, readSet } from "../lib/sets.mjs";
import { listSnapshotNames } from "../lib/snapshot-file.mjs";

/** @import { BackupSet } from "../lib/sets.mjs" */

/**
 * One set's line in the compact summary: its name and its snapshot times
 * (newest first, narrowed to one by `--latest`).
 * @typedef {Object} SetSnapshots
 * @property {string} name
 * @property {string[]} snapshots
 */
/**
 * The all-sets compact view — every set with its snapshot times. `sets` is `[]`
 * when none exist yet (the renderer then shows the "create one" guidance); this
 * command never prints, so an empty result is data, not a stderr warning.
 * @typedef {Object} ListSummary
 * @property {"summary"} mode
 * @property {SetSnapshots[]} sets
 */
/**
 * The single-set detail view — the whole `BackupSet` (config + derived paths) and
 * its snapshots, local or (with `--remote`) the set's cloud backups.
 * @typedef {Object} ListDetail
 * @property {"detail"} mode
 * @property {BackupSet} set
 * @property {string[]} snapshots
 * @property {boolean} remote
 */
/** @typedef {ListSummary | ListDetail} ListResult */

/**
 * List backup sets and their snapshots (docs/design/backup.md, ADR-0036) — the
 * read half of the old `sets` command. Returns data for the render layer
 * (ADR-0043) in one of two shapes, mode-tagged so its renderer can branch:
 *
 * - **`list`** (no set): a **`summary`** of every set — its name and snapshot
 *   times — so a single-set user still gets `s3cab list` → their snapshots, now
 *   under a heading. Local and offline.
 * - **`list <set>`**: a **`detail`** view of that set — name, bucket, member
 *   directories (with the `dirs.txt` path) and exclude file (with its path), then
 *   its snapshots. The config paths teach where to edit a set ("the files are the
 *   API", ADR-0002).
 * - **`list --remote [<set>]`**: the same `detail` shape, but its snapshots are the
 *   set's cloud backups under `snapshots/<set>/`. Unlike the local all-sets form,
 *   `--remote` resolves a **single** set (the one named, or the only set) — it is a
 *   network call carrying the set's own auth, so listing per-set across every set
 *   would be N round-trips with N env layers; one set keeps it cheap and the
 *   credentials unambiguous (a deliberate narrowing of ADR-0036's "compose over the
 *   grouped form", see docs/design/backup.md).
 *
 * `--latest` narrows the snapshot list to just the newest. Async only because the
 * `--remote` path lists S3.
 * @param {string} [setName] - A single set to show in detail; omit (local only) for all sets
 * @param {object} [options]
 * @param {boolean} [options.latest] - Show only the most recent snapshot
 * @param {boolean} [options.remote] - List the set's cloud backups instead of local snapshots
 * @returns {Promise<ListResult>}
 */
export async function list(setName, options = {}) {
  // --remote is single-set (sole-set default): one network call, one set's auth.
  // `loadSet` resolves the set (named or the only one, erroring if ambiguous) and
  // applies its env layer for credentials.
  if (options.remote) {
    const set = loadSet(setName);
    const snapshots = await snapshotsFor(set, options);
    return { mode: "detail", set, snapshots, remote: true };
  }

  // A named set → the detail view. Local, so no env/credentials are needed.
  if (setName !== undefined) {
    const set = readSet(setName);
    const snapshots = await snapshotsFor(set, options);
    return { mode: "detail", set, snapshots, remote: false };
  }

  // No set named → every set, compact (name + snapshot times).
  const sets = listSets().map((name) => {
    const set = readSet(name);
    const snapshots = listSnapshotNames(set.snapshotsDir, {});
    return {
      name,
      snapshots: options.latest ? snapshots.slice(0, 1) : snapshots,
    };
  });
  return { mode: "summary", sets };
}

/**
 * One set's snapshot names to display: local by default or the set's cloud
 * backups with `--remote`, narrowed to just the newest with `--latest`. Always
 * an array (a one-element array for `--latest`) so the detail view formats
 * uniformly.
 * @param {BackupSet} set
 * @param {{ latest?: boolean, remote?: boolean }} options
 * @returns {Promise<string[]>} Snapshot names, newest first
 */
async function snapshotsFor(set, { latest, remote }) {
  const names = remote
    ? await listRemoteSnapshots(set.bucket, set.name)
    : listSnapshotNames(set.snapshotsDir, {});
  return latest ? names.slice(0, 1) : names;
}
