import { requireArg } from "../lib/error.mjs";
import { listStoredObjects, writeObjectsCache } from "../lib/objects.mjs";
import { referencedObjects } from "../lib/remote.mjs";
import { setHasFindings, verifySet } from "../lib/verify.mjs";

/** @import { SetReport } from "../lib/verify.mjs" */

/**
 * Check that the backups in a bucket are complete and undamaged (docs/design/backup.md,
 * [ADR-0042](../../docs/adr/0042-verify-bucket-operand.md)): every object a
 * snapshot references must exist under `objects/` at its recorded size. List
 * requests only — no egress — so it is safe to run routinely
 * (`s3cab verify <bucket> || alert` is the cron idiom).
 *
 * The **operand is the bucket**, symmetric with `cleanup`: one repository is
 * checked in one run, under one credential resolved through the standard chain
 * (no per-set env). Its two enumerations are both bucket-level — that is the only
 * meaningful cost (one `objects/` LIST), so checking "everything in this
 * repository" is the honest unit. Findings are still reported **per set**, since
 * `referencedObjects` groups the bucket's snapshots by the set that owns them.
 *
 * Findings are a flat **per-path `problems`** list per set (`verifySet`) — each
 * referenced file that is `missing` (its content absent from `objects/`, the
 * broken invariant) or `wrong-size` (stored, but at a size ≠ the one recorded) —
 * plus any `unreadableSnapshots`. Both are computed from two enumerations with
 * zero extra requests: the bucket's *referenced* objects (`referencedObjects`,
 * per set) and its *stored* objects (one `listStoredObjects` LIST). **Read the
 * snapshots before the LIST** (the ordering invariant): a backup landing mid-run
 * then only bumps the orphan count, never fakes a missing object.
 *
 * **One local side effect:** verify rewrites this machine's per-bucket objects
 * cache from the completed LIST (`writeObjectsCache`) — authoritative ground truth
 * it already paid for, which warms the next backup and heals a poisoned cache. It
 * never writes to the bucket. **Exit 1** when any set has findings (via
 * `process.exitCode`, so the JSON report still prints); a clean run returns 0.
 *
 * @param {string} [bucket] - The repository's S3 bucket to check
 * @returns {Promise<{ bucket: string, sets: SetReport[], storedObjects: number, orphanObjects: number, orphanObjectsExact: boolean }>}
 *   Per-set reports, the total stored-object count, and the orphan count (stored
 *   objects no snapshot references — a hint toward `cleanup`, never a finding).
 *   `orphanObjectsExact` is true only when every snapshot was readable; an
 *   unreadable snapshot's references are unknown, so the count is then an **upper
 *   bound** (objects it alone referenced masquerade as orphans).
 */
export async function verify(bucket) {
  requireArg(bucket, "bucket");

  // Ordering invariant: read every snapshot (across all sets) BEFORE the objects
  // LIST, so a backup finishing mid-run only bumps the orphan count.
  const referencedBySet = await referencedObjects(bucket);

  // One bucket-wide LIST → stored hash → size, and the complete hash set for the
  // cache rewrite and the orphan count.
  /** @type {Map<string, number>} */
  const stored = new Map();
  for await (const { hash, size } of listStoredObjects(bucket)) {
    stored.set(hash, size);
  }

  /** @type {SetReport[]} */
  const reports = [];
  /** @type {Set<string>} */
  const referencedAll = new Set();
  for (const [set, referenced] of referencedBySet) {
    reports.push(verifySet(set, referenced, stored));
    for (const hash of referenced.referenced.keys()) {
      referencedAll.add(hash);
    }
  }
  reports.sort((a, b) => a.set.localeCompare(b.set));

  // Heal/warm this machine's per-bucket cache from the completed LIST above.
  await writeObjectsCache(bucket, stored.keys());

  // Orphans (stored − referenced): storage no snapshot references. Not a finding
  // — crash orphans are expected — but the hook toward `cleanup`, which reclaims
  // them. Exact only when every snapshot was readable: an unreadable snapshot's
  // references are unknown, so objects it alone referenced count here as orphans,
  // making the number an upper bound.
  let orphanObjects = 0;
  for (const hash of stored.keys()) {
    if (!referencedAll.has(hash)) {
      orphanObjects++;
    }
  }
  const orphanObjectsExact = reports.every(
    (report) => report.unreadableSnapshots.length === 0,
  );

  // Any finding in any set → exit 1 (ADR-0042). Set process.exitCode rather than
  // throw, so the JSON report still serializes to stdout (the entry point prints
  // a returned result even when the exit code is nonzero).
  if (reports.some(setHasFindings)) {
    process.exitCode = 1;
  }

  return {
    bucket,
    sets: reports,
    storedObjects: stored.size,
    orphanObjects,
    orphanObjectsExact,
  };
}
