import { requireArg } from "../lib/error.mjs";
import { formatByteValue } from "../lib/format.mjs";
import { deleteStoredObject, listStoredObjects } from "../lib/objects.mjs";
import { promptYesNo } from "../lib/prompt.mjs";
import { referencedObjects } from "../lib/remote.mjs";
import { isInteractive } from "../lib/style.mjs";

// An object younger than this is never deleted (docs/design/backup.md, stated to
// users in the format spec). Under objects-first/snapshot-last, an in-flight
// backup's uploaded-but-not-yet-referenced objects are indistinguishable from
// orphans, so the grace window is what makes concurrent backups safe without a
// lock. Fixed — no `--grace` knob (a foot-gun that buys nothing, and loosening a
// fixed floor later is additive).
const GRACE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Reclaim storage held by orphaned objects — `objects/<hash>` entries no snapshot
 * references any more, the residue of deleted snapshots and crashed backups
 * (docs/design/backup.md). `cleanup`'s the deliberately-heavy, deliberately-rare
 * garbage collector; the everyday commands never delete. The **read-only twin of
 * `verify`**: both compose the same two enumerations (the bucket's *stored*
 * objects and its *referenced* union across every set), and orphans are simply
 * the opposite set-difference — `stored − referenced` where `verify` computes
 * `referenced − stored`.
 *
 * **Operand is the bucket** (not a set): orphanhood is a repository-level fact
 * spanning every set/user/machine, and taking the bucket resolves credentials
 * through the standard chain (like `hashes`/`upload`), where the elevated
 * delete-capable identity lives — not the least-privilege per-set env.
 *
 * **Dry run by default; `--delete` reclaims** (single pass — computes once,
 * confirms, deletes from the set already in memory, no second enumeration). Two
 * damage interlocks (docs/design/backup.md): an **unreadable snapshot aborts both
 * modes** (its references are unknown, so the orphan numbers would be lies —
 * triage with `verify` first), and **missing objects make `--delete` refuse**
 * (the repository is already losing data; don't compound it). The **7-day grace
 * window** protects objects too young to be sure aren't an in-flight backup's.
 *
 * `--delete` warns that cleanup must not run while a backup is (a documented,
 * accepted race — see the design). It reclaims only orphans (`stored −
 * referenced` across every set), so a valid snapshot's objects are never touched.
 *
 * @typedef {Object} CleanupResult
 * @property {string} bucket - The repository bucket cleaned up
 * @property {number} storedObjects - Objects present in the store
 * @property {number} referencedObjects - Distinct objects any snapshot references
 * @property {number} orphanObjects - Deletable orphans (unreferenced, past grace)
 * @property {number} reclaimableBytes - Bytes those orphans hold
 * @property {number} withinGrace - Orphan-looking objects too new to touch (7-day grace)
 * @property {number} missingObjects - Referenced objects absent from the store (an integrity fault)
 * @property {number} deleted - How many were actually removed (0 on a dry run or a declined confirmation)
 *
 * @param {string} [bucket] - The repository's S3 bucket to clean up (required)
 * @param {{ delete?: boolean }} [options] - `--delete` reclaims; default is a dry run
 * @returns {Promise<CleanupResult>}
 */
export async function cleanup(bucket, options = {}) {
  requireArg(bucket, "bucket");
  const doDelete = Boolean(options.delete);

  // Ordering invariant: read every snapshot BEFORE the objects LIST, so a backup
  // finishing mid-run only adds unreferenced objects (protected by the grace
  // window), never makes a referenced object look missing.
  const referencedBySet = await referencedObjects(bucket);

  // Stored objects with size + age. `cleanup` needs LastModified for the grace
  // window; `verify` (which shares this enumeration) just ignores it.
  /** @type {Map<string, { size: number, lastModified?: Date }>} */
  const stored = new Map();
  for await (const { hash, size, lastModified } of listStoredObjects(bucket)) {
    stored.set(hash, { size, lastModified });
  }

  // Interlock #1 (both modes): an unreadable snapshot makes the orphan set a lie
  // (its references are unknown). Read straight off the referenced enumeration —
  // cleanup works at hash level (whole objects reclaimed), so it needs none of
  // verify's per-path problem model; the same two enumerations answer both.
  const unreadable = [...referencedBySet].flatMap(([set, r]) =>
    r.unreadable.map((u) => `${set}/${u.snapshot}`),
  );
  if (unreadable.length > 0) {
    throw new Error(
      `Can't compute orphans safely: ${unreadable.length} snapshot(s) won't read, ` +
        `so their references are unknown and every object they alone reference ` +
        `would look orphaned.\n` +
        `Unreadable: ${unreadable.join(", ")}\n` +
        `Triage first: s3cab verify ${bucket}`,
    );
  }

  // The referenced union (bucket-wide — cleanup must span every set), plus the
  // missing/damaged tallies. Distinct *hashes*, not paths: an object
  // missing/damaged that several files or sets reference is one lost object, so
  // it must count once or the reported number lies. Missing = a referenced hash
  // absent from the store (the broken invariant); damaged = stored, but *any*
  // recorded path size disagrees with the stored LIST size (a torn manifest can
  // record different sizes across paths/snapshots — `verify` has the per-file
  // detail).
  /** @type {Set<string>} */
  const referencedAll = new Set();
  let missing = 0;
  let damaged = 0;
  for (const { referenced } of referencedBySet.values()) {
    for (const [hash, { paths }] of referenced) {
      if (referencedAll.has(hash)) {
        continue;
      }
      referencedAll.add(hash);
      const storedSize = stored.get(hash)?.size;
      if (storedSize === undefined) {
        missing++;
      } else if (
        [...paths.values()].some((p) =>
          [...p.sizes].some((size) => size !== storedSize),
        )
      ) {
        damaged++;
      }
    }
  }
  if (damaged > 0) {
    // Not an orphanhood concern (that's hash-level) — just flag it and point at verify.
    console.warn(
      `Note: ${damaged} object(s) stored at the wrong size. ` +
        `Run 's3cab verify ${bucket}' for detail.`,
    );
  }

  // Orphans: stored − referenced, honoring the grace window. An object with no
  // LastModified is treated as brand new (protected) — the safe direction.
  const now = Date.now();
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

  const report = {
    bucket,
    storedObjects: stored.size,
    referencedObjects: referencedAll.size,
    orphanObjects: orphanHashes.length,
    reclaimableBytes,
    withinGrace,
    missingObjects: missing,
    deleted: 0,
  };

  // The counts report (stored/orphaned/reclaimable + the grace/missing tallies)
  // is the command's *result* — it renders to stdout via renderCleanup (ADR-0043),
  // so it isn't restated here. stderr carries only next-step guidance.
  if (!doDelete) {
    console.warn(
      orphanHashes.length > 0
        ? `Dry run — nothing deleted. Reclaim with: s3cab cleanup ${bucket} --delete`
        : `Dry run — no orphans to reclaim.`,
    );
    return report;
  }

  // Interlock #2 (--delete only): missing objects mean the repo is already losing
  // data — refuse, so cleanup never compounds a loss. Fix with verify first.
  if (missing > 0) {
    throw new Error(
      `Refusing to delete: ${missing} referenced object(s) are missing — the ` +
        `repository is already losing data, so this is not the moment to reclaim.\n` +
        `Triage first: s3cab verify ${bucket}`,
    );
  }

  if (orphanHashes.length === 0) {
    console.warn("Nothing to reclaim.");
    return report;
  }

  // Confirm on a TTY; a non-interactive run proceeds on the explicit --delete.
  if (isInteractive(process.stdin)) {
    const ok = await promptYesNo(
      `Delete ${orphanHashes.length} orphaned object(s) ` +
        `(${formatByteValue(reclaimableBytes)}) from bucket '${bucket}'? ` +
        `This cannot be undone.`,
    );
    if (!ok) {
      console.warn("Cancelled — nothing was deleted.");
      return report;
    }
  }

  // Single pass: delete from the set already in memory (no second enumeration).
  for (const hash of orphanHashes) {
    await deleteStoredObject(bucket, hash);
  }

  // What was reclaimed is the result (→ renderCleanup on stdout); stderr keeps the
  // one race the counts can't convey (docs/design/backup.md).
  console.warn("Don't run cleanup while a backup is running.");

  report.deleted = orphanHashes.length;
  return report;
}
