// The pure core of the `verify` command (docs/design/backup.md,
// [ADR-0042](../../docs/adr/0042-verify-bucket-operand.md)): given a
// set's *referenced* objects (the union of hashes across its snapshots, each
// carrying every path that references it, that path's recorded size and the
// snapshot(s) it appears in) and the bucket's *stored* objects (hash → size from
// one `objects/` LIST), compute the set's **per-path problems** — the
// referenced − stored difference, expressed one row per broken file. No S3, no
// filesystem — the S3 reads live in remote.mjs (`referencedObjects`, snapshots)
// and objects.mjs (`listStoredObjects`, the LIST); this module is the diff, kept
// pure so the problem model is unit-testable without a bucket.

/**
 * One referenced path within a set: the `sizes` its snapshot rows record and the
 * `snapshots` that reference the content under this path. Recorded per path (not
 * per hash) so the problem model is file-centric — a hash under many paths yields
 * many entries — and so a recorded-size mismatch is attributed to the exact
 * file(s) whose size disagrees with storage. `sizes` is a Set because content
 * fixes size — so a healthy path records exactly one — but a *torn* snapshot file can
 * record the same path at two sizes across snapshots; keeping both lets that hide
 * nowhere (each is checked against the one stored object).
 * @typedef {Object} PathReference
 * @property {Set<number>} sizes - The distinct sizes the snapshot rows record for this path (normally one)
 * @property {Set<string>} snapshots - Names of the snapshots that reference it under this path
 */

/**
 * One object referenced by a set's snapshots: the `paths` it was stored under,
 * each with its recorded size and referencing snapshots. Content-addressed dedup
 * means one hash can back many paths; verify reports against the *paths*, so all
 * of them are retained (cheap — usually one path per content).
 * @typedef {Object} ReferencedObject
 * @property {Map<string, PathReference>} paths - Each path referencing this content
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
 *    problem, since none can be restored.
 *  - **wrong-size** — the object is stored, but this path's recorded size ≠ the
 *    stored LIST size (a truncated/overwritten upload, or a torn snapshot-file row).
 *    Recorded per path, so a hash whose paths disagree on size (the old
 *    "conflicting rows" case) surfaces as a wrong-size problem on exactly the
 *    file(s) that disagree with storage — no separate category, no ambiguous
 *    skip. When both apply the object is missing, so wrong-size is moot.
 * @param {string} name - The set's name
 * @param {ReferencedResult} referencedResult - This set's referenced enumeration
 * @param {Map<string, number>} stored - Bucket's stored objects (hash → LIST size)
 * @returns {SetReport}
 */
export function verifySet(name, referencedResult, stored) {
  const { referenced, snapshotsChecked, unreadable } = referencedResult;

  /** @type {SetReport["problems"]} */
  const problems = [];

  for (const [hash, entry] of referenced) {
    const storedSize = stored.get(hash);
    for (const [path, { sizes, snapshots }] of entry.paths) {
      const snaps = [...snapshots].sort();
      if (storedSize === undefined) {
        problems.push({ path, problem: "missing", snapshots: snaps });
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

  return {
    set: name,
    snapshotsChecked,
    referencedObjects: referenced.size,
    problems,
    unreadableSnapshots: unreadable,
  };
}

/**
 * A single set's verify report: how much was checked, plus a flat per-path
 * `problems` list and any `unreadableSnapshots`. Empty across both means the set
 * verified clean. `problems` is one row per broken *file* (not per object): a
 * missing blob referenced by five paths yields five rows — the user thinks in
 * files, and hashes never surface (docs/design/backup.md, ADR-0042).
 * `unreadableSnapshots` stays separate because it is not file-shaped — a corrupt
 * snapshot file has no file list to annotate, only a lost restore point.
 * @typedef {Object} SetReport
 * @property {string} set
 * @property {number} snapshotsChecked - Snapshots read successfully
 * @property {number} referencedObjects - Distinct object hashes referenced
 * @property {{ path: string, problem: "missing" | "wrong-size", snapshots: string[], recordedSize?: number, storedSize?: number }[]} problems
 * @property {{ snapshot: string, reason: string }[]} unreadableSnapshots
 */

/**
 * Whether a set's report carries any finding — what drives verify's exit code
 * (any finding in any named set → exit 1, ADR-0042). Both a per-path problem and
 * an unreadable snapshot count; a clean set has neither.
 * @param {SetReport} report
 * @returns {boolean}
 */
export const setHasFindings = (report) =>
  report.problems.length > 0 || report.unreadableSnapshots.length > 0;
