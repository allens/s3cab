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
 * @param {{ rehash?: boolean, "include-online-only"?: boolean, debug?: boolean }} [options] -
 *   `--rehash` re-hashes every file instead of reusing previous hashes;
 *   `--include-online-only` hashes cloud placeholders too, downloading each
 *   (ADR-0081); `--debug` leaves an uncompressed copy and allows a same-minute
 *   overwrite. The inline form (rather than a `@param options.x` list) because a
 *   kebab-case key can't be spelled in the dotted one — the same shape
 *   `cleanup`/`delete` use for `--dry-run`.
 * @returns {Promise<CompareResult>} Diff against the previous snapshot
 */
export async function snapshot(setName, options = {}) {
  const set = loadSet(setName);

  const baseline = await readBaseline(set, options);
  const { name: previousName, previous, previousErrors } = baseline;
  const { name } = await generateSnapshot(set, {
    baseline,
    debug: options.debug,
    includeOnlineOnly: options["include-online-only"],
  });

  // Compare with the previous snapshot. `readBaseline` above already read it —
  // regardless of `--rehash`, which only suppresses the hash *lookup* — so hand
  // that parse through rather than paying to decompress and parse it again.
  // Both halves go through — its entries *and* the paths it couldn't hash, which
  // is what stops a file that was merely locked last time reading as new
  // (ADR-0079).
  return await compareSnapshots(set.snapshotsDir, set.dirs, {
    since:
      previous && previousName
        ? { name: previousName, entries: previous, errors: previousErrors }
        : previousName,
    until: name,
    setName: set.name,
  });
}
