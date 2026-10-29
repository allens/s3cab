import {
  formatDeletionRecord,
  writeDeletionRecord,
} from "./deletion-record.mjs";
import { localMoment } from "./format.mjs";
import { holdDeleteLock } from "./locks.mjs";
import { deleteStoredObjects } from "./objects.mjs";
import { userAtMachine } from "./user-at-machine.mjs";

/**
 * Remove content from the repository, by hash: the record first, then the
 * objects, under the delete lock ([ADR-0112](../../docs/adr/0112-bucket-locks.md))
 * — the operation behind `delete`, which decides *what* and confirms it
 * before this runs.
 *
 * **Record-first ordering** (ADR-0064): the record is written (conditional
 * PUT at the next free index — never an overwrite) *before* any object is
 * deleted, so a crash between the two leaves an over-complete record —
 * objects recorded deleted that still exist, which verify reads as simply
 * present — never missing objects with no explanation.
 *
 * The lock is what keeps a backup from vouching for an object this run is
 * about to remove: a running upload's conditional PUT would see the object
 * present and skip it, and its snapshot would then reference nothing. The
 * record's instant is taken under it too — with `--wait` the lock can come
 * long after the confirmation, and the record says when the content went.
 * @param {string} bucket - The repository's S3 bucket
 * @param {{ hash: string, size: number }[]} items - What to delete, with the sizes the record keeps
 * @param {{ wait?: boolean }} [options] - `wait` for running uploads instead of refusing
 * @returns {Promise<string>} The deletion record's URI
 */
export function deleteContent(bucket, items, { wait = false } = {}) {
  return holdDeleteLock({ bucket, command: "delete", wait }, async () => {
    // One clock read and one identity for the run, so every row agrees by
    // construction. The record is named by index, not by a moment, so only
    // the instant is wanted — the precision names nothing.
    const { instant } = localMoment("seconds");
    const by = userAtMachine();
    const rows = items.map(({ hash, size }) => ({ hash, size, instant, by }));
    const recordUri = await writeDeletionRecord(
      bucket,
      formatDeletionRecord(rows),
    );
    await deleteStoredObjects(
      bucket,
      rows.map(({ hash }) => hash),
    );
    return recordUri;
  });
}
