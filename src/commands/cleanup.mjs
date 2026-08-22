import { planCleanup } from "../lib/cleanup.mjs";
import {
  compactDeletionRecords,
  readDeletionRecords,
} from "../lib/deletion-record.mjs";
import { requireArg } from "../lib/error.mjs";
import { countOf, formatByteValue } from "../lib/format.mjs";
import { deleteStoredObject, listStoredObjects } from "../lib/objects.mjs";
import { promptYesNo } from "../lib/prompt.mjs";
import { unreadableMessage } from "../lib/referenced.mjs";
import { referencedObjects } from "../lib/remote.mjs";
import { isInteractive } from "../lib/style.mjs";

/**
 * Reclaim storage held by orphaned objects — `objects/<hash>` entries no snapshot
 * references any more, the residue of deleted snapshots and crashed backups
 * (docs/design/backup.md). `cleanup`'s the deliberately-heavy, deliberately-rare
 * orphan deleter; the everyday commands never delete. The **read-only twin of
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
 * **Acts by default; `-n`/`--dry-run` previews; `-f`/`--force` skips the prompt**
 * (single pass — computes once, confirms, deletes from the set already in memory,
 * no second enumeration). Non-interactive runs refuse without `--force` (clig:
 * fail with instructions, never block on a prompt) — the tool-wide
 * destructive-command pattern
 * ([ADR-0064](../../docs/adr/0064-path-scoped-delete-deletion-record.md)) `delete`
 * also follows, here with the gentler y/N tier: cleanup removes only orphans past
 * the grace window, never content a live snapshot references. Two damage
 * interlocks (docs/design/backup.md): an **unreadable snapshot aborts both modes**
 * (its references are unknown, so the orphan numbers would be lies — triage with
 * `verify` first), and **missing objects make the act path refuse** (the
 * repository is already losing data; don't compound it). The **7-day grace
 * window** protects objects too young to be sure aren't an in-flight backup's.
 *
 * Reclaiming warns that cleanup must not run while a backup is (a documented,
 * accepted race — see the design). It reclaims only orphans (`stored −
 * referenced` across every set), so a valid snapshot's objects are never touched.
 *
 * An acting run (never a dry run or a declined one) also **compacts the
 * deletion record** ([ADR-0090](../../docs/adr/0090-deletion-record-format-compaction.md)):
 * the `objects.deleted-<n>.tsv` files are merged into one fresh file, dropping
 * rows whose hash no snapshot anywhere references — safe *because* interlock #1
 * held, so the referenced union is complete and an unknown reference protects
 * every row. Trimming is housekeeping, not reclamation: it needs no
 * confirmation of its own, since a dropped row is one nothing can ever ask
 * about again.
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
 * @property {number} compactedRecordFiles - Deletion-record files merged away (0 = the record was already compact, or the run didn't act)
 * @property {number} trimmedRecordRows - Deletion-record rows dropped because no snapshot references their hash
 *
 * @param {string} [bucket] - The repository's S3 bucket to clean up (required)
 * @param {{ "dry-run"?: boolean, force?: boolean }} [options] - acts by default; `-n`/`--dry-run` previews, `-f`/`--force` skips the prompt (and is required non-interactively)
 * @returns {Promise<CleanupResult>}
 */
export async function cleanup(bucket, options = {}) {
  requireArg(bucket, "bucket");
  const dryRun = Boolean(options["dry-run"]);
  const force = Boolean(options.force);

  // The non-interactive gate, up front — before the expensive scan, so a
  // misconfigured cron job fails in milliseconds with the fix, not minutes in.
  // Acting deletes objects; with no terminal to confirm on, the intent must be
  // explicit (--force). Mirrors delete (ADR-0064's destructive-command pattern).
  if (!dryRun && !force && !isInteractive(process.stdin)) {
    throw new Error(
      `Reclaiming storage deletes objects, and there is no terminal to ` +
        `confirm on.\n` +
        `Preview what would be reclaimed:\n` +
        `  s3cab cleanup ${bucket} --dry-run\n` +
        `Or reclaim without a prompt:\n` +
        `  s3cab cleanup ${bucket} --force`,
    );
  }

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

  // The deletion records, read last (like verify): a referenced hash the
  // record explains is deliberately absent (ADR-0064), not a missing-object
  // integrity fault — without this, the first path-scoped `delete` would make
  // interlock #2 refuse forever.
  const deleted = await readDeletionRecords(bucket);

  // The whole diff — orphans (with the grace window), the delete-list, and the
  // missing/damaged/unreadable tallies — is one pure computation over the two
  // enumerations (planCleanup, cleanup.mjs; the read-only twin of verifySet).
  // Everything below is the command's job: turn the plan's data into aborts,
  // warnings, a prompt, and the deletes.
  const plan = planCleanup(referencedBySet, stored, { deleted });
  const { orphanHashes, missing, damaged, reclaimableBytes } = plan;

  // Interlock #1 (both modes): an unreadable snapshot makes the orphan set a lie
  // (its references are unknown), so abort before reporting numbers that would be
  // wrong. Triage with verify first.
  if (plan.unreadable.length > 0) {
    throw new Error(
      unreadableMessage({
        names: plan.unreadable,
        bucket,
        lead: "Can't clean up safely",
        consequence:
          "objects nothing else references would look unused and be deleted",
      }),
    );
  }

  if (damaged > 0) {
    // Not an orphanhood concern (that's hash-level) — just flag it and point at verify.
    console.warn(
      `Note: ${countOf(damaged, "object")} stored at the wrong size. ` +
        `Run 's3cab verify ${bucket}' for detail.`,
    );
  }

  const report = {
    bucket,
    storedObjects: plan.storedObjects,
    referencedObjects: plan.referencedObjects,
    orphanObjects: orphanHashes.length,
    reclaimableBytes,
    withinGrace: plan.withinGrace,
    missingObjects: missing,
    deleted: 0,
    compactedRecordFiles: 0,
    trimmedRecordRows: 0,
  };

  // The record compaction (ADR-0090), for every acting path — reclaiming or
  // not, stale record rows accumulate (a deleted hash whose last referencing
  // snapshot was since forgotten) and cleanup is their one collector. Safe to
  // trim against `referencedHashes` because interlock #1 already held: every
  // snapshot read, so the union is complete. Runs only after interlock #2 —
  // a repository losing data is not the moment for housekeeping either.
  const compactRecords = async () => {
    const compaction = await compactDeletionRecords(
      bucket,
      plan.referencedHashes,
    );
    if (compaction.files > 0) {
      console.warn(
        compaction.rows > 0
          ? `Compacted the deletion record` +
              (compaction.trimmed > 0
                ? ` — dropped ${countOf(compaction.trimmed, "row")} no snapshot references`
                : ``) +
              `.`
          : `Removed the deletion record — no snapshot references anything it explained.`,
      );
    }
    report.compactedRecordFiles = compaction.files;
    report.trimmedRecordRows = compaction.trimmed;
  };

  // The counts report (stored/orphaned/reclaimable + the grace/missing tallies)
  // is the command's *result* — it renders to stdout via renderCleanup (ADR-0043),
  // so it isn't restated here. stderr carries only next-step guidance.
  if (dryRun) {
    console.warn(
      orphanHashes.length > 0
        ? `Dry run — nothing deleted. Re-run without --dry-run to reclaim ` +
            `(add --force when there's no terminal).`
        : `Dry run — no orphans to reclaim.`,
    );
    return report;
  }

  // Interlock #2 (act path only): missing objects mean the repo is already losing
  // data — refuse, so cleanup never compounds a loss. Fix with verify first.
  if (missing > 0) {
    throw new Error(
      `Refusing to delete: the repository is missing ` +
        `${countOf(missing, "referenced object")} — it is already losing data, ` +
        `so this is not the moment to reclaim.\n` +
        `Check them with:\n` +
        `  s3cab verify ${bucket}`,
    );
  }

  if (orphanHashes.length === 0) {
    await compactRecords();
    console.warn("Nothing to reclaim.");
    return report;
  }

  // Confirm on a TTY unless --force; a non-interactive run reached here only via
  // --force (the up-front gate refuses otherwise), so this is the y/N for a human.
  if (!force && isInteractive(process.stdin)) {
    const ok = await promptYesNo(
      `Delete ${countOf(orphanHashes.length, "orphaned object")} ` +
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

  await compactRecords();

  // What was reclaimed is the result (→ renderCleanup on stdout); stderr keeps the
  // one race the counts can't convey (docs/design/backup.md).
  console.warn("Don't run cleanup while a backup is running.");

  report.deleted = orphanHashes.length;
  return report;
}
