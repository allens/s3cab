// The core of the `cleanup` command (docs/design/backup.md) — the read-only
// twin of `verifySet` (verify.mjs), realized in code rather than just prose.
// Given the bucket's *referenced* objects (the per-set union of hashes across
// every snapshot, from `referencedObjects` in remote.mjs) and its *stored*
// objects (hash → size from one `objects/` LIST, `listStoredObjects` in
// objects.mjs), `planCleanup` computes the deletion plan: the orphans
// (`stored − referenced`), the bytes they hold, and the diagnostic tallies
// (missing/damaged) plus any unreadable snapshots. Pure, and — like
// `verifySet` — it never throws: the interlock *policy* (abort on unreadable,
// refuse to act on missing) is the command's, so the plan is unit-testable by
// asserting on returned data, with no mocked seams.
//
// `reclaim` is the acting half: the deletes themselves, under the delete lock
// ([ADR-0112](../../docs/adr/0112-bucket-locks.md)). The plan was made with
// no lock held, so a backup may have finished between the scan and the lock;
// its snapshot's objects look like orphans to the plan. The **top-up** closes
// that: once the lock is held and no upload can start, LIST `snapshots/`
// again, read only what the scan's listing lacked, and take those references
// out of the orphan list and into the keep-set compaction trims against. The
// interlocks the scan applies to a snapshot (unreadable, or a refused row)
// apply to a topped-up one too, for the same reason: an unknown reference
// makes the orphan list a lie.

import { compactDeletionRecords } from "./deletion-record.mjs";
import { holdDeleteLock } from "./locks.mjs";
import { deleteStoredObjects } from "./objects.mjs";
import {
  sizeDisagreements,
  unreadableMessage,
  unreadableSnapshots,
} from "./referenced.mjs";
import { readNewSnapshots } from "./remote.mjs";
import { shellCommand, styleEnabled } from "./style.mjs";

/** @import { ReferencedResult } from "./referenced.mjs" */

/**
 * The deletion plan `cleanup` acts on, computed from the two enumerations already
 * in hand (zero extra requests). Everything the command needs to report, gate, and
 * delete — nothing it must recompute:
 *  - `orphanHashes` is the actual delete-list (`stored − referenced`), not just
 *    a count, so the act path deletes from the plan with no second pass.
 *  - `missing`/`damaged` are distinct-*hash* tallies (an object several files or
 *    sets reference is one lost object — count it once or the number lies), driving
 *    interlock #2 and the wrong-size warning respectively. `damaged` is
 *    intentionally absent from the user-facing `CleanupResult` (it points at verify
 *    for the per-file detail); it rides the plan so the command can warn on it.
 *  - `unreadable` is the bucket-wide `set/snapshot` list (`unreadableSnapshots`);
 *    a non-empty one is interlock #1, and the command owns the wording.
 * @typedef {Object} CleanupPlan
 * @property {number} storedObjects - Objects present in the store
 * @property {number} referencedObjects - Distinct objects any snapshot references
 * @property {Set<string>} referencedHashes - Those objects themselves (`referencedObjects` is its size) — what deletion-record compaction trims against
 * @property {string[]} orphanHashes - Deletable orphans (unreferenced)
 * @property {number} reclaimableBytes - Bytes those orphans hold
 * @property {number} missing - Referenced objects absent from the store (integrity fault)
 * @property {number} damaged - Stored objects whose recorded size disagrees with storage
 * @property {string[]} unreadable - `set/snapshot` names that would not read
 */

/**
 * Compute the cleanup plan — the `stored − referenced` orphan set and the
 * diagnostic tallies — from the two enumerations. Pure and non-throwing: the
 * command layer turns `unreadable`/`missing` into aborts (docs/design/backup.md).
 *
 * `missing` = a referenced hash absent from `stored` (the broken
 * objects-first/snapshot-last invariant) — **except** hashes the deletion
 * record explains (`deleted`, ADR-0064): those are deliberately gone, not an
 * integrity fault, and counting them would make the act path's interlock
 * refuse forever after the first path-scoped `delete`. `damaged` = stored, but
 * *any* recorded path size disagrees with the stored LIST size (a torn snapshot
 * file can record different sizes across paths/snapshots; `verify` has the
 * per-file detail).
 * @param {Map<string, ReferencedResult>} referencedBySet - Per-set referenced enumeration (`referencedObjects`)
 * @param {Map<string, { size: number }>} stored - Stored objects: hash → size (`listStoredObjects`)
 * @param {{ deleted?: Set<string> | Map<string, unknown> }} [options] - `deleted` =
 *   hashes the deletion record marks deliberately removed (`readDeletionRecords`)
 * @returns {CleanupPlan}
 */
export function planCleanup(
  referencedBySet,
  stored,
  { deleted = new Set() } = {},
) {
  const unreadable = unreadableSnapshots(referencedBySet);

  // The referenced union (bucket-wide — cleanup must span every set), plus the
  // missing/damaged tallies, each over distinct hashes (an object several files or
  // sets reference is one lost object — count it once).
  /** @type {Set<string>} */
  const referencedAll = new Set();
  /** @type {Set<string>} */
  const damagedHashes = new Set();
  let missing = 0;
  for (const { referenced } of referencedBySet.values()) {
    for (const [hash, entry] of referenced) {
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
      // Only *whether* anything disagrees — cleanup counts damaged objects, it
      // doesn't report which file or which size (that is `verify`'s job).
      if (sizeDisagreements(entry, storedSize).length > 0) {
        damagedHashes.add(hash);
      }
    }
  }
  const damaged = damagedHashes.size;

  // Orphans: stored − referenced.
  /** @type {string[]} */
  const orphanHashes = [];
  let reclaimableBytes = 0;
  for (const [hash, { size }] of stored) {
    if (referencedAll.has(hash)) {
      continue;
    }
    orphanHashes.push(hash);
    reclaimableBytes += size;
  }

  return {
    storedObjects: stored.size,
    referencedObjects: referencedAll.size,
    referencedHashes: referencedAll,
    orphanHashes,
    reclaimableBytes,
    missing,
    damaged,
    unreadable,
  };
}

/**
 * The `set/snapshot` names whose rows were refused (ADR-0101), each once —
 * interlock #1's twin: a refused row references nothing, so content only it
 * names would count as an orphan.
 * @param {Map<string, ReferencedResult>} referencedBySet
 * @returns {string[]}
 */
export const invalidRowSnapshots = (referencedBySet) => [
  ...new Set(
    [...referencedBySet].flatMap(([set, { invalid }]) =>
      invalid.map(({ snapshot }) => `${set}/${snapshot}`),
    ),
  ),
];

/**
 * Interlock #1: an unreadable snapshot makes the orphan set a lie (its
 * references are unknown), so abort before reporting numbers that would be
 * wrong. Triage with verify first.
 * @param {string} bucket
 * @param {string[]} names - `set/snapshot`, from `unreadableSnapshots`
 * @returns {Error}
 */
export const unreadableSnapshotsError = (bucket, names) =>
  new Error(
    unreadableMessage({
      names,
      bucket,
      lead: "Can't clean up safely",
      consequence:
        "objects nothing else references would look unused and be deleted",
      color: styleEnabled(process.stderr),
    }),
  );

/**
 * Interlock #1's twin: a refused row references nothing (ADR-0101), so content
 * only it names would count as an orphan. Each snapshot is named once; verify
 * gives the paths and why.
 * @param {string} bucket
 * @param {string[]} names - `set/snapshot`, from `invalidRowSnapshots`
 * @returns {Error}
 */
export const invalidRowsError = (bucket, names) => {
  const one = names.length === 1;
  return new Error(
    [
      `Can't clean up safely — ${one ? "this snapshot has rows" : "these snapshots have rows"} ` +
        `that aren't valid, so content only those rows name would look unused ` +
        `and be deleted:`,
      ...names.map((name) => `  ${name}`),
      ``,
      `Check ${one ? "it" : "them"} with:`,
      `  ${shellCommand(`s3cab verify ${bucket}`, styleEnabled(process.stderr))}`,
    ].join("\n"),
  );
};

/**
 * The plan, less what the snapshots that appeared since the scan reference:
 * their objects leave the orphan list and join the keep-set. Pure; the
 * interlocks on the added snapshots are `reclaim`'s.
 * @param {CleanupPlan} plan
 * @param {Map<string, { size: number }>} stored - The scan's store LIST, for the bytes
 * @param {Map<string, ReferencedResult>} added - The new snapshots' references (`readNewSnapshots`)
 * @returns {CleanupPlan}
 */
export function topUp(plan, stored, added) {
  const referencedHashes = new Set(plan.referencedHashes);
  for (const { referenced } of added.values()) {
    for (const hash of referenced.keys()) {
      referencedHashes.add(hash);
    }
  }
  /** @type {string[]} */
  const orphanHashes = [];
  let reclaimableBytes = 0;
  for (const hash of plan.orphanHashes) {
    if (referencedHashes.has(hash)) {
      continue;
    }
    orphanHashes.push(hash);
    reclaimableBytes += stored.get(hash)?.size ?? 0;
  }
  return {
    ...plan,
    referencedObjects: referencedHashes.size,
    referencedHashes,
    orphanHashes,
    reclaimableBytes,
  };
}

/**
 * What `reclaim` did.
 * @typedef {Object} Reclaimed
 * @property {number} deleted - Orphans removed, after the top-up
 * @property {number} reclaimedBytes - The bytes those held
 * @property {Awaited<ReturnType<typeof compactDeletionRecords>>} compaction - What the deletion record's compaction did
 */

/**
 * Act on a plan: under the delete lock, top the plan up with the snapshots
 * that appeared since the scan, delete the orphans that remain, then compact
 * the deletion record against the topped-up keep-set (ADR-0090). The lock is
 * what makes the plan safe to act on — no upload can start while it is held,
 * and the top-up accounts for the ones that finished before it was taken.
 * Compaction rides under the same lock for the same reason: the keep-set it
 * trims against must be complete.
 *
 * The caller has already applied the scan's interlocks (unreadable, refused
 * rows, damaged record, missing) and confirmed; a topped-up snapshot that is
 * unreadable or has a refused row aborts here, with the same errors and
 * nothing deleted.
 * @param {string} bucket - The repository's S3 bucket
 * @param {object} scan - What the scan read, and the plan made from it
 * @param {CleanupPlan} scan.plan
 * @param {Map<string, string[]>} scan.snapshotFiles - The scan's `snapshots/` listing
 * @param {Map<string, { size: number }>} scan.stored - The scan's store LIST
 * @param {{ wait?: boolean }} [options] - `wait` for running uploads instead of refusing
 * @returns {Promise<Reclaimed>}
 */
export function reclaim(
  bucket,
  { plan, snapshotFiles, stored },
  { wait = false } = {},
) {
  return holdDeleteLock({ bucket, command: "cleanup", wait }, async () => {
    const added = await readNewSnapshots(bucket, snapshotFiles);
    const unreadable = unreadableSnapshots(added);
    if (unreadable.length > 0) {
      throw unreadableSnapshotsError(bucket, unreadable);
    }
    const invalid = invalidRowSnapshots(added);
    if (invalid.length > 0) {
      throw invalidRowsError(bucket, invalid);
    }
    const topped = topUp(plan, stored, added);
    await deleteStoredObjects(bucket, topped.orphanHashes);
    const compaction = await compactDeletionRecords(
      bucket,
      topped.referencedHashes,
    );
    return {
      deleted: topped.orphanHashes.length,
      reclaimedBytes: topped.reclaimableBytes,
      compaction,
    };
  });
}
