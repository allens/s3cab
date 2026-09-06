import { readDeletionRecords } from "./deletion-record.mjs";
import { listStoredObjects } from "./objects.mjs";
import { referencedObjects } from "./remote.mjs";

/** @import { ReferencedResult } from "./referenced.mjs" */
/** @import { RecordedDeletion } from "./deletion-record.mjs" */

// The read-side composition of a repository's three layouts — `snapshots/`
// (remote.mjs), `objects/` (objects.mjs) and the root-level deletion record
// (deletion-record.mjs) — for the two commands that judge a whole bucket at
// once: `verify` (referenced − stored) and `cleanup` (stored − referenced).
// The write-side twin is upload.mjs, which composes the first two halves on
// the way in; neither prefix owner composes the other, so the composition
// lives in its own module on both sides.
//
// What this module owns is the **order** of the three reads, which is a
// safety property rather than a convenience (docs/design/repository-protocol.md,
// "the ordering in 1–3 is itself a guard"). Nothing locks the bucket, so a
// backup or a `delete` can land between any two of the reads, and the order
// decides whether that makes the scan *over*-estimate what is referenced (safe:
// an extra orphan, protected by cleanup's grace window and ignored by verify)
// or *under*-estimate it (silent data loss: a referenced object reported
// missing, or an orphan that is not one deleted). Read in this order every
// concurrent change falls on the safe side:
//
//   1. every snapshot, before the objects LIST — a backup finishing mid-run
//      can only add objects the scan has not seen a reference to, never a
//      reference to an object the LIST had not seen;
//   2. the objects LIST;
//   3. the deletion records last — a `delete` writes its record *before* it
//      removes objects, so any object that vanished during 2 has its
//      explanation on hand by 3.
//
// Callers get all three from one call and cannot get them another way round,
// which is the enforcement: the invariant is the function's body, not a
// comment at each call site. `referencedObjects` stays exported from
// remote.mjs for `forget`, which needs the snapshot half alone.

/**
 * What a whole-bucket scan reads, in the order it read it. `stored` is
 * materialized rather than streamed because both consumers ask "is this hash
 * stored?" per referenced object (CLAUDE.md's consumer-decides stance), and it
 * carries the LIST's `Size` and `LastModified` for the same reason
 * `listStoredObjects` does: `verify` wants the size, `cleanup` the age, and one
 * LIST already returns both.
 * @typedef {Object} BucketScan
 * @property {Map<string, ReferencedResult>} referencedBySet - The referenced enumeration per set name (`referencedObjects`)
 * @property {Map<string, { size: number, lastModified?: Date }>} stored - Every stored object: hash → LIST size and age
 * @property {Map<string, RecordedDeletion>} deleted - The deletion record: hash → when it was deliberately deleted
 */

/**
 * Scan a bucket safely: read every snapshot, then LIST `objects/`, then read
 * the deletion records — the one order under which a concurrent backup or
 * `delete` can only make the result over-estimate what is referenced (see the
 * header). A snapshot LIST failure or an operational S3 error aborts; a
 * damaged snapshot is recorded under its set as unreadable and the scan
 * continues (`referencedObjects`).
 * @param {string} bucket - The repository's S3 bucket
 * @returns {Promise<BucketScan>}
 */
export async function scanBucket(bucket) {
  const referencedBySet = await referencedObjects(bucket);

  /** @type {BucketScan["stored"]} */
  const stored = new Map();
  for await (const { hash, size, lastModified } of listStoredObjects(bucket)) {
    stored.set(hash, { size, lastModified });
  }

  const deleted = await readDeletionRecords(bucket);

  return { referencedBySet, stored, deleted };
}
