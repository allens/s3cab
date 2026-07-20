// The pure core of the `cleanup` command (docs/design/backup.md) — the read-only
// twin of `verifySet` (verify.mjs), realized in code rather than just prose. Given
// the bucket's *referenced* objects (the per-set union of hashes across every
// snapshot, from `referencedObjects` in remote.mjs) and its *stored* objects (hash
// → size + age from one `objects/` LIST, `listStoredObjects` in objects.mjs),
// compute the deletion plan: the orphans (`stored − referenced`, past the grace
// window), the bytes they hold, and the diagnostic tallies (missing/damaged) plus
// any unreadable snapshots. No S3, no filesystem, no clock of its own (`now` is
// injected) and — like `verifySet` — it never throws: the interlock *policy*
// (abort on unreadable, refuse `--delete` on missing) is the command's, so the
// plan is unit-testable by asserting on returned data, with no mocked seams.

/** @import { ReferencedResult } from "./verify.mjs" */

// An object younger than this is never an orphan (docs/design/backup.md, stated to
// users in the format spec). Under objects-first/snapshot-last, an in-flight
// backup's uploaded-but-not-yet-referenced objects are indistinguishable from
// orphans, so the grace window is what makes concurrent backups safe without a
// lock. Fixed — no `--grace` knob (a foot-gun that buys nothing, and loosening a
// fixed floor later is additive).
export const GRACE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * The deletion plan `cleanup` acts on, computed from the two enumerations already
 * in hand (zero extra requests). Everything the command needs to report, gate, and
 * delete — nothing it must recompute:
 *  - `orphanHashes` is the actual delete-list (`stored − referenced`, past grace),
 *    not just a count, so `--delete` deletes from the plan with no second pass.
 *  - `missing`/`damaged` are distinct-*hash* tallies (an object several files or
 *    sets reference is one lost object — count it once or the number lies), driving
 *    interlock #2 and the wrong-size warning respectively. `damaged` is
 *    intentionally absent from the user-facing `CleanupResult` (it points at verify
 *    for the per-file detail); it rides the plan so the command can warn on it.
 *  - `unreadable` is structured (`{ set, snapshot, reason }`), so the command owns
 *    the message wording; a non-empty list is interlock #1.
 * @typedef {Object} CleanupPlan
 * @property {number} storedObjects - Objects present in the store
 * @property {number} referencedObjects - Distinct objects any snapshot references
 * @property {string[]} orphanHashes - Deletable orphans (unreferenced, past grace)
 * @property {number} reclaimableBytes - Bytes those orphans hold
 * @property {number} withinGrace - Orphan-looking objects too new to touch (7-day grace)
 * @property {number} missing - Referenced objects absent from the store (integrity fault)
 * @property {number} damaged - Stored objects whose recorded size disagrees with storage
 * @property {{ set: string, snapshot: string, reason: string }[]} unreadable - Snapshots that would not read
 */

/**
 * Compute the cleanup plan — the `stored − referenced` orphan set and the
 * diagnostic tallies — from the two enumerations. Pure and non-throwing: the
 * command layer turns `unreadable`/`missing` into aborts (docs/design/backup.md).
 *
 * `missing` = a referenced hash absent from `stored` (the broken
 * objects-first/snapshot-last invariant) — **except** hashes the deletion
 * record explains (`deleted`, ADR-0064): those are deliberately gone, not an
 * integrity fault, and counting them would make the `--delete` interlock
 * refuse forever after the first path-scoped `delete`. `damaged` = stored, but
 * *any* recorded path size disagrees with the stored LIST size (a torn snapshot
 * file can record different sizes across paths/snapshots; `verify` has the
 * per-file detail). Orphans honour the grace window measured from `now`; an
 * object with no `lastModified` is treated as brand new (protected) — the safe
 * direction.
 * @param {Map<string, ReferencedResult>} referencedBySet - Per-set referenced enumeration (`referencedObjects`)
 * @param {Map<string, { size: number, lastModified?: Date }>} stored - Stored objects: hash → size + age (`listStoredObjects`)
 * @param {{ now?: number, deleted?: Set<string> | Map<string, unknown> }} [options] - `now` (ms)
 *   for the grace window (defaults to the wall clock); `deleted` = hashes the
 *   deletion record marks deliberately removed (`readDeletionRecords`)
 * @returns {CleanupPlan}
 */
export function planCleanup(
  referencedBySet,
  stored,
  { now = Date.now(), deleted = new Set() } = {},
) {
  const unreadable = [...referencedBySet].flatMap(([set, r]) =>
    r.unreadable.map((u) => ({ set, snapshot: u.snapshot, reason: u.reason })),
  );

  // The referenced union (bucket-wide — cleanup must span every set), plus the
  // missing/damaged tallies, each over distinct hashes (an object several files or
  // sets reference is one lost object — count it once).
  /** @type {Set<string>} */
  const referencedAll = new Set();
  /** @type {Set<string>} */
  const damagedHashes = new Set();
  let missing = 0;
  for (const { referenced } of referencedBySet.values()) {
    for (const [hash, { paths }] of referenced) {
      const storedSize = stored.get(hash)?.size;
      // missing is per distinct hash — decide it once, on first sighting. A
      // hash the deletion record explains is deliberately absent, not missing.
      if (!referencedAll.has(hash)) {
        referencedAll.add(hash);
        if (storedSize === undefined && !deleted.has(hash)) {
          missing++;
        }
      }
      // damaged must scan *every* set that references the hash: a torn snapshot
      // file can record the wrong size in a later set than the first to point at
      // it. Once flagged, skip re-scanning. (Missing hashes have no stored size to
      // compare against.)
      if (storedSize === undefined || damagedHashes.has(hash)) {
        continue;
      }
      for (const { sizes } of paths.values()) {
        for (const size of sizes) {
          if (size !== storedSize) {
            damagedHashes.add(hash);
          }
        }
      }
    }
  }
  const damaged = damagedHashes.size;

  // Orphans: stored − referenced, honouring the grace window.
  /** @type {string[]} */
  const orphanHashes = [];
  let reclaimableBytes = 0;
  let withinGrace = 0;
  for (const [hash, { size, lastModified }] of stored) {
    if (referencedAll.has(hash)) {
      continue;
    }
    const ageMs = now - (lastModified ? lastModified.getTime() : now);
    if (ageMs < GRACE_MS) {
      withinGrace++;
      continue;
    }
    orphanHashes.push(hash);
    reclaimableBytes += size;
  }

  return {
    storedObjects: stored.size,
    referencedObjects: referencedAll.size,
    orphanHashes,
    reclaimableBytes,
    withinGrace,
    missing,
    damaged,
    unreadable,
  };
}
