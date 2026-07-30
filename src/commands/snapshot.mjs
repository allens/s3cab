import { compareSnapshots } from "../lib/compare.mjs";
import { loadSet } from "../lib/env.mjs";
import { generateSnapshot, readBaseline } from "../lib/snapshot.mjs";

/** @import { CompareResult } from "../lib/compare.mjs" */

/**
 * Take a snapshot of a backup set: walk every member directory and write a
 * single snapshot into the set's snapshot store, then report what changed
 * since the previous one (docs/design/backup.md).
 *
 * Thin porcelain over the snapshot engine (`lib/snapshot.mjs`): read the
 * previous snapshot for the hash lookup, generate, compare. `backup` composes
 * the same two engine calls with an object uploader spliced into the write
 * (ADR-0069) — which is why the engine lives in `lib` rather than here.
 * @param {string} [setName] - Backup set to snapshot (default: the only set)
 * @param {object} [options]
 * @param {boolean} [options.rehash] - Re-hash every file instead of reusing previous hashes
 * @param {boolean} [options.debug] - Enable debug mode (and allow a same-minute overwrite)
 * @returns {Promise<CompareResult>} Diff against the previous snapshot
 */
export async function snapshot(setName, options = {}) {
  const set = loadSet(setName);

  const {
    name: previousName,
    previous,
    lookup,
    instant: previousInstant,
  } = await readBaseline(set, options);
  const { name } = await generateSnapshot(set, {
    lookup,
    debug: options.debug,
    previousInstant,
  });

  // Compare with the previous snapshot. When it was already read for the hash
  // lookup above, hand the parse through so the baseline isn't decompressed and
  // parsed a second time; under --rehash it wasn't read, so the compare reads it.
  return await compareSnapshots(set.snapshotsDir, set.dirs, {
    since:
      previous && previousName
        ? { name: previousName, entries: previous }
        : previousName,
    until: name,
    setName: set.name,
  });
}
