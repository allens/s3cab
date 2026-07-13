import { loadSet } from "../lib/env.mjs";
import { pushSetConfig } from "../lib/set-marker.mjs";
import { readSetExclude } from "../lib/sets.mjs";
import { listSnapshotNames } from "../lib/snapshot-file.mjs";
import { snapshot } from "./snapshot.mjs";
import { upload } from "./upload.mjs";

/**
 * Back up a set to the cloud (docs/design/backup.md): take a fresh snapshot of the
 * set, then upload it — `snapshot()` + `upload()`, always both (ADR-0044). A thin
 * porcelain that composes the two plumbing commands; `backup` itself never hashes
 * (the snapshot already carries every hash) and never walks the filesystem.
 *
 * `backup`'s one piece of smarts is the change-detection baseline it resolves and
 * hands to `upload` explicitly (plumbing is predictable; porcelain is smart): the
 * set's **previous local snapshot** as `--since` (single-owner model — the local
 * history is authoritative), or, on a first backup with no previous snapshot,
 * nothing — `upload` then LISTs the store. The objects-first/snapshot-last
 * invariant and the conditional-PUT backstop both live in `upload`
 * (`uploadSnapshot`); `backup` merely composes (docs/design/backup.md).
 *
 * @typedef {Object} BackupResult
 * @property {string} set - The set backed up
 * @property {string} snapshot - The fresh snapshot that was uploaded
 * @property {number} candidates - Objects considered for upload (new since the last backup)
 * @property {number} uploaded - Those actually transferred (the rest were already in the store)
 *
 * With no update mode ([ADR-0052](../../docs/adr/0052-retire-setup-update-mode.md)),
 * a set's `dirs.txt`/`exclude.txt` are edited by hand, so `backup` is where those
 * edits re-sync to the remote `sets/<name>/` marker (which a later `reattach`
 * reads). It's best-effort metadata: a failure there must not fail a backup whose
 * objects + snapshot are already safely up — the next backup re-publishes.
 *
 * @param {string} [setName] - Backup set to back up (default: the only set)
 * @param {{ debug?: boolean }} [options]
 * @returns {Promise<BackupResult>}
 */
export async function backup(setName, options = {}) {
  // Resolve the set and apply its env layer (its bucket's auth) over the ambient
  // shell (env.mjs, ADR-0022/0055 — the one s3cab layer). `upload` re-resolves it
  // (idempotent); we resolve here for the snapshot-name lookup.
  const set = loadSet(setName);
  const snapshotDir = set.snapshotsDir;

  // Take a fresh snapshot, then read the name it wrote back — the latest local
  // snapshot. (snapshot() returns its diff, not the name it generated, so read
  // the name back rather than change that contract.)
  await snapshot(set.name, options);
  const name = listSnapshotNames(snapshotDir, { latest: true });
  if (!name) {
    throw new Error(`No snapshot was produced for set '${set.name}'.`);
  }

  // The change-detection baseline: the immediately-preceding local snapshot
  // (names are timestamps, sorted newest-first, so the first name below the fresh
  // one is its predecessor). Undefined on a first backup → `upload` LISTs.
  const since = listSnapshotNames(snapshotDir).find((n) => n < name);

  const result = await upload(set.name, { snapshot: name, since });
  if (result.mode !== "snapshot") {
    // Unreachable: a `--snapshot` upload always returns the snapshot-shaped
    // result. The guard narrows the union for the type checker (and would catch
    // a future contract drift) without a cast.
    throw new Error("Expected a snapshot upload result from backup.");
  }

  // Re-sync the set's published config to the remote marker (ADR-0052): the
  // objects + snapshot are already up, so this is best-effort metadata — a hiccup
  // here leaves the marker stale until the next backup, never a failed backup.
  try {
    await pushSetConfig(set.bucket, set.name, {
      dirs: set.dirs,
      exclude: readSetExclude(set.name),
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.warn(
      `Backed up. (Couldn't refresh this set's cloud config just now — ${detail}. ` +
        `It'll re-sync on your next backup.)`,
    );
  }

  return {
    set: set.name,
    snapshot: name,
    candidates: result.candidates,
    uploaded: result.uploaded,
  };
}
