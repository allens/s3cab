import { loadSet } from "../lib/env.mjs";
import { listRemoteSnapshots } from "../lib/remote.mjs";
import { NO_SETS_MESSAGE, listSets, readSet } from "../lib/sets.mjs";
import { listSnapshotNames } from "../lib/snapshot-file.mjs";

/** @import { BackupSet } from "../lib/sets.mjs" */

/**
 * List backup sets and their snapshots (docs/specs/backup.md, ADR-0036) — the
 * read half of the old `sets` command. Three shapes:
 *
 * - **`list`** (no set): every set compactly — `name:` then its snapshot times —
 *   so a single-set user still gets `s3cab list` → their snapshots, now under a
 *   heading. Local and offline.
 * - **`list <set>`**: that set in detail — name, bucket, member directories (with the
 *   `dirs.txt` path), and its exclude file (with the `exclude.txt` path), then its
 *   snapshots. The config paths teach where to edit a set ("the files are the
 *   API", ADR-0002).
 * - **`list --remote [<set>]`**: the set's cloud backups under `snapshots/<set>/`,
 *   shown in the detail view. Unlike the local all-sets form, `--remote` resolves
 *   a **single** set (the one named, or the only set) — it is a network call and
 *   carries the set's own auth, so listing it per-set across every set would be N
 *   round-trips with N env layers; one set keeps it cheap and the credentials
 *   unambiguous (a deliberate narrowing of ADR-0036's "compose over the grouped
 *   form", see docs/specs/backup.md).
 *
 * `--latest` narrows the snapshot list to just the newest. Like the old `sets`
 * listing and `hashes`, the formatted listing *is* the result, so it goes to
 * stdout directly and the function returns `undefined` (a deliberate exception to
 * the dispatcher's JSON serialization). Async only because the `--remote` path
 * lists S3.
 * @param {string} [setName] - A single set to show in detail; omit (local only) for all sets
 * @param {object} [options]
 * @param {boolean} [options.latest] - Show only the most recent snapshot
 * @param {boolean} [options.remote] - List the set's cloud backups instead of local snapshots
 * @returns {Promise<undefined>}
 */
export async function list(setName, options = {}) {
  // --remote is single-set (sole-set default): one network call, one set's auth.
  // `loadSet` resolves the set (named or the only one, erroring if ambiguous) and
  // applies its env layer for credentials.
  if (options.remote) {
    const set = loadSet(setName);
    const snapshots = await snapshotsFor(set, options);
    process.stdout.write(formatDetail(set, snapshots, true) + "\n");
    return undefined;
  }

  // A named set → the detail view. Local, so no env/credentials are needed.
  if (setName !== undefined) {
    const set = readSet(setName);
    const snapshots = await snapshotsFor(set, options);
    process.stdout.write(formatDetail(set, snapshots, false) + "\n");
    return undefined;
  }

  // No set named → every set, compact (name + snapshot times).
  const names = listSets();
  if (names.length === 0) {
    console.warn(NO_SETS_MESSAGE);
    return undefined;
  }

  const blocks = names.map((name) => {
    const set = readSet(name);
    const snapshots = listSnapshotNames(set.snapshotsDir, {});
    const shown = options.latest ? snapshots.slice(0, 1) : snapshots;
    return `${name}:\n` + indentSnapshots(shown);
  });
  process.stdout.write(blocks.join("\n") + "\n");
  return undefined;
}

/**
 * One set's snapshot names to display: local by default or the set's cloud
 * backups with `--remote`, narrowed to just the newest with `--latest`. Always
 * an array (a one-element array for `--latest`) so the block formats uniformly.
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

/**
 * The detail view for one set: its config (bucket, member directories, exclude file)
 * then its snapshots. The `dirs.txt`/`exclude.txt` paths are shown — absolute and
 * platform-native (from `node:path`, rooted at `homedir()`) — so the listing
 * doubles as "where do I edit this set": a capable terminal opens the path in the
 * default editor, and at worst it copy-pastes. ("The files are the API",
 * [0002](../../docs/adr/0002-no-lock-in-hard-constraint.md).)
 * @param {BackupSet} set
 * @param {string[]} snapshots - Snapshot names to list, newest first
 * @param {boolean} remote - Whether these are the set's cloud backups
 * @returns {string}
 */
function formatDetail(set, snapshots, remote) {
  return [
    `name: ${set.name}`,
    `bucket: ${set.bucket}`,
    `dirs (${set.dirsPath}):`,
    ...(set.dirs.length ? set.dirs.map((dir) => `  ${dir}`) : ["  (none)"]),
    `exclude file: ${set.excludePath}`,
    `${remote ? "remote snapshots" : "snapshots"}:`,
    indentSnapshots(snapshots),
  ].join("\n");
}

/**
 * Render snapshot names as indented lines, or a `(none yet)` placeholder when
 * there are none — so an empty set reads clearly rather than as a blank gap.
 * @param {string[]} names
 * @returns {string}
 */
function indentSnapshots(names) {
  if (names.length === 0) return "  (none yet)";
  return names.map((name) => `  ${name}`).join("\n");
}
