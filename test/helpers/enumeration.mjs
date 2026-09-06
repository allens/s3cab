import { addSnapshotReferences } from "../../src/lib/referenced.mjs";

/** @import { ReferencedResult } from "../../src/lib/referenced.mjs" */

// The referenced enumeration (`Map<set, ReferencedResult>`, the shape
// `referencedObjects` returns) from a compact fixture, for every unit test that
// plans over one. The fixture is written the way the bucket is — set →
// snapshot → path → what the row records — and each snapshot's rows go through
// `addSnapshotReferences`, the fold production uses. So a test cannot hold a
// shape a real read would not produce, and the derived facts (which snapshots
// reference a path, how many were read, a path recorded at two sizes across
// snapshots) fall out of the data instead of being spelled by hand.
//
// Before this, seven test files each carried their own builder — three named
// `ref`, two named `enumeration`, five incompatible signatures — and a new test
// picked one by proximity. One fixture shape, one way to build it.

/**
 * @typedef {Record<string, [hash: string, size?: number]>} SnapshotRows
 *   path → the hash and size its row records (size defaults to 100)
 */
/**
 * @typedef {Record<string, Record<string, SnapshotRows>>} EnumerationSpec
 *   set → snapshot name → its rows. A fixture held in a variable before it is
 *   passed needs this as its `@type`, or the tuples widen to plain arrays.
 */

/**
 * @param {EnumerationSpec} spec - set → snapshot name → its rows
 * @param {Record<string, (string | { snapshot: string, reason: string })[]>} [unreadable]
 *   set → the snapshots that would not read; a bare name gets a zstd reason.
 *   Every set named here must appear in `spec` (with `{}` if it has no readable
 *   snapshot), so a mistyped set name fails instead of vanishing.
 * @returns {Map<string, ReferencedResult>}
 */
export function enumeration(spec, unreadable = {}) {
  /** @type {Map<string, ReferencedResult>} */
  const bySet = new Map();
  for (const [set, snapshots] of Object.entries(spec)) {
    /** @type {ReferencedResult["referenced"]} */
    const referenced = new Map();
    for (const [name, rows] of Object.entries(snapshots)) {
      addSnapshotReferences(
        referenced,
        name,
        Object.entries(rows).map(([path, [hash, size = 100]]) => [
          path,
          { hash, size },
        ]),
      );
    }
    bySet.set(set, {
      referenced,
      snapshotsChecked: Object.keys(snapshots).length,
      unreadable: (unreadable[set] ?? []).map((entry) =>
        typeof entry === "string"
          ? { snapshot: entry, reason: "zstd: Data corruption detected" }
          : entry,
      ),
    });
  }
  for (const set of Object.keys(unreadable)) {
    if (!bySet.has(set)) {
      throw new Error(`unreadable names a set not in the fixture: ${set}`);
    }
  }
  return bySet;
}
