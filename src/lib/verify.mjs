// The pure core of the `verify` command (docs/design/backup.md,
// [ADR-0042](../../docs/adr/0042-verify-bucket-operand.md)): given a
// set's *referenced* objects (the union of hashes across its snapshots, each with
// the size(s) and snapshot(s) that reference it) and the bucket's *stored* objects
// (hash → size from one `objects/` LIST), compute the four finding classes as two
// opposite set-differences' first half. No S3, no filesystem — the S3 reads live
// in remote.mjs (`referencedObjects`, snapshots) and objects.mjs (`listStoredObjects`,
// the LIST); this module is the diff, kept pure so the finding classes are
// unit-testable without a bucket.

/**
 * One object referenced by a set's snapshots: the `size`(s) its rows record (a
 * Set, so a hash recorded with *different* sizes across rows — a corrupt snapshot
 * — is caught for free), the `snapshots` that reference it, and one `examplePath`
 * for the report.
 * @typedef {Object} ReferencedObject
 * @property {Set<number>} sizes - Distinct sizes the snapshot rows record for this hash (>1 = conflicting rows)
 * @property {Set<string>} snapshots - Names of the snapshots that reference it
 * @property {string} examplePath - One path this content was stored under (first seen)
 */

/**
 * The result of enumerating a set's referenced objects (built by `referencedObjects`
 * in remote.mjs): the `referenced` map, how many snapshots were read successfully
 * (`snapshotsChecked`), and the `unreadable` snapshots — those that failed to
 * decompress/parse, a finding in their own right (their references went unchecked).
 * @typedef {Object} ReferencedResult
 * @property {Map<string, ReferencedObject>} referenced
 * @property {number} snapshotsChecked
 * @property {{ snapshot: string, reason: string }[]} unreadable
 */

/**
 * Whether an error reading a remote snapshot means the *snapshot itself* is
 * damaged (a finding — verify records it and carries on) rather than an
 * operational S3 failure (network/auth/throttle — an ordinary error that aborts
 * the run, docs/design/backup.md). Damage is a zstd decompression failure
 * (`code` like `ZSTD_error_*`) or a snapshot-parse assertion (`AssertionError`
 * from `parseSnapshotStream`); anything else — an SDK/credential/network error —
 * is *not* corruption and is rethrown, so an outage never masquerades as data
 * loss. Unknown → not corruption → abort (the safe direction).
 * @param {unknown} error
 * @returns {boolean}
 */
export function isCorruptSnapshotError(error) {
  if (!Error.isError(error)) {
    return false;
  }
  const code = /** @type {NodeJS.ErrnoException} */ (error).code;
  return (
    error.name === "AssertionError" ||
    (typeof code === "string" && code.startsWith("ZSTD_"))
  );
}

/**
 * Sort a finding array by hash — deterministic report output (and stable tests),
 * independent of snapshot/LIST encounter order.
 * @template {{ hash: string }} T
 * @param {T[]} findings
 * @returns {T[]}
 */
const byHash = (findings) =>
  findings.sort((a, b) => a.hash.localeCompare(b.hash));

/**
 * Verify one set against the bucket's stored objects — the completeness check
 * plus the size cross-check, computed entirely from the two enumerations already
 * in hand (zero extra requests, docs/design/backup.md). Produces the set's report:
 * counts plus the four finding-class arrays. The bucket is the same for every set
 * in a run (verify's operand), so it is carried on the top-level result, not here.
 *
 * Per referenced hash, in order of severity so a hash is reported once:
 *  1. **Conflicting rows** (`sizes.size > 1`): the snapshot files disagree on its
 *     size — content fixes size, so a snapshot is corrupt. Reported independent of
 *     the stored side, and it is what makes the size cross-check well-defined
 *     (an ambiguous "expected" size is *not* also flagged as a mismatch).
 *  2. **Missing object**: not in `stored` — the broken objects-first/snapshot-last
 *     invariant, the core check.
 *  3. **Size mismatch**: stored, but the LIST `Size` ≠ the (unambiguous) recorded
 *     size — a truncated/overwritten object.
 * @param {string} name - The set's name
 * @param {ReferencedResult} referencedResult - This set's referenced enumeration
 * @param {Map<string, number>} stored - Bucket's stored objects (hash → LIST size)
 * @returns {SetReport}
 */
export function verifySet(name, referencedResult, stored) {
  const { referenced, snapshotsChecked, unreadable } = referencedResult;

  /** @type {SetReport["missingObjects"]} */
  const missingObjects = [];
  /** @type {SetReport["sizeMismatches"]} */
  const sizeMismatches = [];
  /** @type {SetReport["conflictingRows"]} */
  const conflictingRows = [];

  for (const [hash, entry] of referenced) {
    const snapshots = [...entry.snapshots].sort();
    const examplePath = entry.examplePath;
    // Sorted ascending, so a conflicting hash reports a deterministic size (the
    // smallest recorded), not one picked by Set-insertion order. Every referenced
    // entry has ≥1 size (`referencedObjects` adds one as it creates the entry),
    // so the `?? 0` fallback never fires.
    const sizes = [...entry.sizes].sort((a, b) => a - b);
    const recordedSize = sizes[0] ?? 0;

    if (sizes.length > 1) {
      conflictingRows.push({ hash, sizes, snapshots, examplePath });
    }

    const storedSize = stored.get(hash);
    if (storedSize === undefined) {
      missingObjects.push({ hash, size: recordedSize, snapshots, examplePath });
    } else if (sizes.length === 1 && recordedSize !== storedSize) {
      // Only when the recorded size is unambiguous — a conflicting hash is
      // already a finding, and "expected" would be undefined.
      sizeMismatches.push({
        hash,
        expectedSize: recordedSize,
        storedSize,
        snapshots,
        examplePath,
      });
    }
  }

  return {
    set: name,
    snapshotsChecked,
    referencedObjects: referenced.size,
    missingObjects: byHash(missingObjects),
    sizeMismatches: byHash(sizeMismatches),
    conflictingRows: byHash(conflictingRows),
    unreadableSnapshots: unreadable,
  };
}

/**
 * A single set's verify report: how much was checked, plus the four finding-class
 * arrays. Empty arrays across the board mean the set verified clean.
 * @typedef {Object} SetReport
 * @property {string} set
 * @property {number} snapshotsChecked - Snapshots read successfully
 * @property {number} referencedObjects - Distinct object hashes referenced
 * @property {{ hash: string, size: number, snapshots: string[], examplePath: string }[]} missingObjects
 * @property {{ hash: string, expectedSize: number, storedSize: number, snapshots: string[], examplePath: string }[]} sizeMismatches
 * @property {{ hash: string, sizes: number[], snapshots: string[], examplePath: string }[]} conflictingRows
 * @property {{ snapshot: string, reason: string }[]} unreadableSnapshots
 */

/**
 * Whether a set's report carries any finding — what drives verify's exit code
 * (any finding in any named set → exit 1, ADR-0042). All four classes count: a
 * clean set has empty arrays across the board.
 * @param {SetReport} report
 * @returns {boolean}
 */
export const setHasFindings = (report) =>
  report.missingObjects.length > 0 ||
  report.sizeMismatches.length > 0 ||
  report.conflictingRows.length > 0 ||
  report.unreadableSnapshots.length > 0;
