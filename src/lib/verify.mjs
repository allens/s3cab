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

import { sizeDisagreements } from "./referenced.mjs";

/** @import { ReferencedResult } from "./referenced.mjs" */

/**
 * The storage classes a plain GET can't read: the object must first be
 * restored from the archive (a `RestoreObject` request, hours to complete)
 * or moved back by a lifecycle rule. `GLACIER_IR` is not one — instant
 * retrieval reads like `STANDARD`, which is why s3cab stores in it (s3.mjs's
 * `awsOnlyPutParams`). `INTELLIGENT_TIERING` hides its archive tiers behind
 * one class name the LIST can't see through; an object in one of those reads
 * as fine here and fails in `restore` (guide/format.md, the restorer's storage
 * class rule).
 */
const ARCHIVE_CLASSES = new Set(["GLACIER", "DEEP_ARCHIVE"]);

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
 *  - **invalid** — a snapshot row the reader refused (ADR-0101), with its
 *    `reason`: no restore will produce this path from that snapshot.
 *  - **archived** — the object is stored, but in a storage class a GET can't
 *    read (`ARCHIVE_CLASSES`): a bucket lifecycle rule moved it to an archive
 *    tier, and `restore` would fail on it exactly as on a missing one. Every
 *    path referencing it is a problem, as for missing; the size check is moot.
 *    The finding clears when the object is moved back to an instant-access
 *    class, not when a `RestoreObject` request lands a temporary readable
 *    copy: the LIST still says the archive class, the copy expires, and
 *    telling the two apart is a HEAD per object, which ADR-0042 rules out.
 *
 * A set with **no snapshot checked** (`snapshotsChecked` 0, and none
 * unreadable) is a finding in itself — `setHasFindings` — because nothing
 * was verified: its marker is in the bucket and its snapshots are gone, which
 * is what a `verify || alert` cron job exists to notice.
 * @param {string} name - The set's name
 * @param {ReferencedResult} referencedResult - This set's referenced enumeration
 * @param {Map<string, { size: number, storageClass?: string }>} stored - Bucket's stored objects (hash → LIST size and storage class; `scanBucket`'s map, whose age this diff ignores)
 * @param {Map<string, { deletedOn: string }>} [deleted] - The deletion rows
 *   that explain an absence (`explainingDeletions`): hash → when it was deliberately deleted
 * @returns {SetReport}
 */
export function verifySet(name, referencedResult, stored, deleted = new Map()) {
  const { referenced, snapshotsChecked, unreadable, invalid } =
    referencedResult;

  /** @type {SetReport["problems"]} */
  const problems = invalid.map(({ snapshot, path, reason }) => ({
    path,
    problem: /** @type {const} */ ("invalid"),
    snapshots: [snapshot],
    reason,
  }));
  /** @type {SetReport["expectedMissing"]} */
  const expectedMissing = [];

  for (const [hash, entry] of referenced) {
    const object = stored.get(hash);
    const storedSize = object?.size;

    // Missing is a property of the *hash*, so it is decided once per object
    // rather than re-tested at every path: nothing is stored, so every path
    // referencing it is a finding and none has a size to disagree with.
    if (storedSize === undefined) {
      const record = deleted.get(hash);
      for (const [path, { snapshots }] of entry.paths) {
        const snaps = [...snapshots].sort();
        if (record) {
          expectedMissing.push({
            path,
            snapshots: snaps,
            deletedOn: record.deletedOn,
          });
        } else {
          problems.push({ path, problem: "missing", snapshots: snaps });
        }
      }
      continue;
    }

    // Archived is likewise the hash's: stored, but unreadable until restored
    // from the archive tier, so every path is a finding and the size is moot.
    const storageClass = object?.storageClass;
    if (storageClass && ARCHIVE_CLASSES.has(storageClass)) {
      for (const [path, { snapshots }] of entry.paths) {
        problems.push({
          path,
          problem: "archived",
          snapshots: [...snapshots].sort(),
          storageClass,
        });
      }
      continue;
    }

    for (const { path, snapshots, recordedSize } of sizeDisagreements(
      entry,
      storedSize,
    )) {
      problems.push({
        path,
        problem: "wrong-size",
        snapshots,
        recordedSize,
        storedSize,
      });
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
 * `problems` list and any `unreadableSnapshots`. Empty across both, with at
 * least one snapshot checked, means the set verified clean — `setHasFindings`
 * is the one rule. `problems` is one row per broken *file* (not per object): a
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
 * @property {number} snapshotsChecked - Snapshots read successfully; 0 is itself a finding (`setHasFindings`)
 * @property {number} referencedObjects - Distinct object hashes referenced
 * @property {{ path: string, problem: "missing" | "wrong-size" | "invalid" | "archived", snapshots: string[], recordedSize?: number, storedSize?: number, reason?: string, storageClass?: string }[]} problems
 * @property {{ path: string, snapshots: string[], deletedOn: string }[]} expectedMissing
 * @property {{ snapshot: string, reason: string }[]} unreadableSnapshots
 */

/**
 * Whether a set's report carries any finding — what drives verify's exit code
 * (any finding in any named set → exit 1, ADR-0042). A per-path problem, an
 * unreadable snapshot, and a set with no snapshot checked at all each count; a
 * clean set has none of them and at least one snapshot read. `expectedMissing`
 * never counts (ADR-0064): a recorded deletion is permanent, deliberate state,
 * and exiting 1 on it forever would train the user to ignore the
 * `verify || alert` alarm — deliberate ≠ fault.
 * @param {SetReport} report
 * @returns {boolean}
 */
export const setHasFindings = (report) =>
  report.problems.length > 0 ||
  report.unreadableSnapshots.length > 0 ||
  report.snapshotsChecked === 0;

/**
 * The bucket's versioning as `verify` found it
 * ([ADR-0118](../../docs/adr/0118-verify-reports-bucket-versioning.md)):
 * `unknown` when the read failed, with the code the server gave as `reason`.
 * @typedef {{ state: "enabled" | "suspended" | "never-enabled" } | { state: "unknown", reason: string }} Versioning
 */

/**
 * Whether a verify run has any finding — its exit code, and the one rule the
 * command and its renderer both ask so the two can't drift: a set with
 * findings, no set at all, or a bucket whose versioning was switched off.
 * "All verified" can't be said of nothing, and a bucket with no set is most
 * likely the wrong bucket
 * ([ADR-0117](../../docs/adr/0117-health-reports-count-only-what-they-checked.md)).
 * Versioning that is off for good, or couldn't be read, is not a finding: an
 * alarm on every run gets ignored (ADR-0118).
 * @param {{ sets: SetReport[], versioning: Versioning }} result
 * @returns {boolean}
 */
export const verifyHasFindings = ({ sets, versioning }) =>
  sets.length === 0 ||
  sets.some(setHasFindings) ||
  versioning.state === "suspended";
