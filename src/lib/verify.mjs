// The pure core of the `verify` command (docs/design/backup.md,
// [ADR-0042](../../docs/adr/0042-verify-bucket-operand.md)): given a
// set's *referenced* objects (the union of hashes across its snapshots, each
// carrying every path that references it, that path's recorded size and the
// snapshot(s) it appears in) and the bucket's *stored* objects (hash → size from
// one `objects/` LIST), compute the set's **per-path problems** — the
// referenced − stored difference, expressed one row per broken file. No S3, no
// filesystem — the S3 reads live in remote.mjs (`referencedObjects`, snapshots)
// and objects.mjs (`listStoredObjects`, the LIST); this module is the diff, kept
// pure so the problem model is unit-testable without a bucket. The shape it
// consumes — and the classifier deciding which snapshot reads become findings —
// is the enumeration's own vocabulary, in referenced.mjs.

/** @import { ReferencedResult } from "./referenced.mjs" */

/**
 * Verify one set against the bucket's stored objects — the completeness check
 * plus the size cross-check, computed entirely from the two enumerations already
 * in hand (zero extra requests, docs/design/backup.md). Produces the set's report:
 * counts plus a flat **per-path `problems`** list. The bucket is the same for
 * every set in a run (verify's operand), so it is carried on the top-level
 * result, not here.
 *
 * The check is file-centric: each referenced *path* is measured against the one
 * actual stored object for its content (docs/design/backup.md, ADR-0042).
 *  - **missing** — the content's hash is absent from `stored` (the broken
 *    objects-first/snapshot-last invariant): every path referencing it is a
 *    problem, since none can be restored. **Partitioned by the deletion record**
 *    (ADR-0064): a hash the record explains is `expectedMissing` — deliberately
 *    deleted, reported with its date, *not* a finding — while an unexplained one
 *    stays the alarming problem it always was. A recorded hash that is stored
 *    anyway (content re-backed-up after a delete) is simply present; the record
 *    entry is moot and the normal checks apply.
 *  - **wrong-size** — the object is stored, but this path's recorded size ≠ the
 *    stored LIST size (a truncated/overwritten upload, or a torn snapshot-file row).
 *    Recorded per path, so a hash whose paths disagree on size (the old
 *    "conflicting rows" case) surfaces as a wrong-size problem on exactly the
 *    file(s) that disagree with storage — no separate category, no ambiguous
 *    skip. When both apply the object is missing, so wrong-size is moot.
 * @param {string} name - The set's name
 * @param {ReferencedResult} referencedResult - This set's referenced enumeration
 * @param {Map<string, number>} stored - Bucket's stored objects (hash → LIST size)
 * @param {Map<string, { deletedOn: string }>} [deleted] - The repository's
 *   deletion records (`readDeletionRecords`): hash → when it was deliberately deleted
 * @returns {SetReport}
 */
export function verifySet(name, referencedResult, stored, deleted = new Map()) {
  const { referenced, snapshotsChecked, unreadable } = referencedResult;

  /** @type {SetReport["problems"]} */
  const problems = [];
  /** @type {SetReport["expectedMissing"]} */
  const expectedMissing = [];

  for (const [hash, entry] of referenced) {
    const storedSize = stored.get(hash);
    for (const [path, { sizes, snapshots }] of entry.paths) {
      const snaps = [...snapshots].sort();
      if (storedSize === undefined) {
        const record = deleted.get(hash);
        if (record) {
          expectedMissing.push({
            path,
            snapshots: snaps,
            deletedOn: record.deletedOn,
          });
        } else {
          problems.push({ path, problem: "missing", snapshots: snaps });
        }
        continue;
      }
      // Every recorded size for this path is checked against the one stored
      // object; a torn snapshot file that recorded two sizes yields a row per bad one.
      for (const size of sizes) {
        if (size !== storedSize) {
          problems.push({
            path,
            problem: "wrong-size",
            snapshots: snaps,
            recordedSize: size,
            storedSize,
          });
        }
      }
    }
  }

  // Deterministic report output (and stable tests), independent of snapshot/LIST
  // encounter order. The sort is *total*: the same path can legitimately appear
  // more than once — under different content hashes across snapshots (a file that
  // changed), or a torn path at two sizes — so tie-break past (path, problem) on
  // recorded size and then referencing snapshots.
  problems.sort(
    (a, b) =>
      a.path.localeCompare(b.path) ||
      a.problem.localeCompare(b.problem) ||
      (a.recordedSize ?? -1) - (b.recordedSize ?? -1) ||
      a.snapshots.join(",").localeCompare(b.snapshots.join(",")),
  );

  expectedMissing.sort(
    (a, b) =>
      a.path.localeCompare(b.path) || a.deletedOn.localeCompare(b.deletedOn),
  );

  return {
    set: name,
    snapshotsChecked,
    referencedObjects: referenced.size,
    problems,
    expectedMissing,
    unreadableSnapshots: unreadable,
  };
}

/**
 * A single set's verify report: how much was checked, plus a flat per-path
 * `problems` list and any `unreadableSnapshots`. Empty across both means the set
 * verified clean. `problems` is one row per broken *file* (not per object): a
 * missing object referenced by five paths yields five rows — the user thinks in
 * files, and hashes never surface (docs/design/backup.md, ADR-0042).
 * `unreadableSnapshots` stays separate because it is not file-shaped — a corrupt
 * snapshot file has no file list to annotate, only a lost restore point.
 *
 * `expectedMissing` is a separate field, deliberately **not** a `problems` row
 * (ADR-0064): a deliberately deleted file is context, not damage, so
 * `setHasFindings` needs no carve-out and a `--json` consumer can't mistake it
 * for a fault. One row per path, with the deletion record's date.
 * @typedef {Object} SetReport
 * @property {string} set
 * @property {number} snapshotsChecked - Snapshots read successfully
 * @property {number} referencedObjects - Distinct object hashes referenced
 * @property {{ path: string, problem: "missing" | "wrong-size", snapshots: string[], recordedSize?: number, storedSize?: number }[]} problems
 * @property {{ path: string, snapshots: string[], deletedOn: string }[]} expectedMissing
 * @property {{ snapshot: string, reason: string }[]} unreadableSnapshots
 */

/**
 * Whether a set's report carries any finding — what drives verify's exit code
 * (any finding in any named set → exit 1, ADR-0042). Both a per-path problem and
 * an unreadable snapshot count; a clean set has neither. `expectedMissing` never
 * counts (ADR-0064): a recorded deletion is permanent, deliberate state, and
 * exiting 1 on it forever would train the user to ignore the `verify || alert`
 * alarm — deliberate ≠ fault.
 * @param {SetReport} report
 * @returns {boolean}
 */
export const setHasFindings = (report) =>
  report.problems.length > 0 || report.unreadableSnapshots.length > 0;
