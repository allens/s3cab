import { scanBucket } from "../lib/bucket-scan.mjs";
import {
  invalidRowSnapshots,
  invalidRowsError,
  planCleanup,
  reclaim,
  unreadableSnapshotsError,
} from "../lib/cleanup.mjs";
import { requireArg } from "../lib/error.mjs";
import { countOf, formatByteValue } from "../lib/format.mjs";
import { promptYesNo } from "../lib/prompt.mjs";
import { isInteractive, shellCommand } from "../lib/style.mjs";

/**
 * Reclaim storage held by orphaned objects — `objects/<hash>` entries no snapshot
 * references any more, the residue of deleted snapshots and crashed backups
 * (docs/design/backup.md). `cleanup`'s the deliberately-heavy, deliberately-rare
 * orphan deleter; the everyday commands never delete. The **read-only twin of
 * `verify`**: both start from the same bucket scan (`scanBucket` — the bucket's
 * *referenced* union across every set, its *stored* objects, and the deletion
 * record, read in the one order that is safe under a concurrent backup), and
 * orphans are simply the opposite set-difference — `stored − referenced` where
 * `verify` computes `referenced − stored`.
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
 * also follows, here with the gentler y/N tier: cleanup removes only orphans,
 * never content a live snapshot references. Three damage interlocks
 * (docs/design/backup.md): an **unreadable snapshot, or one with a refused
 * row, aborts both modes** (its references are unknown, so the orphan numbers
 * would be lies — triage with `verify` first; ADR-0101), and **missing
 * objects make the act path refuse** (the repository is already losing data;
 * don't compound it), as does a **damaged deletion record** (compacting it
 * would lose rows, ADR-0101).
 *
 * The scan and the plan run with no lock, so the preview costs a running
 * backup nothing; the deletes are `reclaim`'s (lib/cleanup.mjs), under the
 * delete lock ([ADR-0112](../../docs/adr/0112-bucket-locks.md)): it refuses
 * while a backup or upload is running (`--wait` waits instead), and once the
 * lock is held it reads any snapshot a backup published since the scan, so
 * that backup's objects come off the orphan list before anything is deleted.
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
 * @property {number} orphanObjects - Deletable orphans (unreferenced)
 * @property {number} reclaimableBytes - Bytes those orphans hold
 * @property {number} missingObjects - Referenced objects absent from the store (an integrity fault)
 * @property {number} deleted - How many were actually removed (0 on a dry run or a declined confirmation)
 * @property {number} compactedRecordFiles - Deletion-record files merged away (0 = the record was already compact, or the run didn't act)
 * @property {number} trimmedRecordRows - Deletion-record rows dropped because no snapshot references their hash
 *
 * @param {string} [bucket] - The repository's S3 bucket to clean up (required)
 * @param {{ "dry-run"?: boolean, force?: boolean, wait?: boolean }} [options] - acts by default; `-n`/`--dry-run` previews, `-f`/`--force` skips the prompt (and is required non-interactively), `--wait` waits for running uploads
 * @returns {Promise<CleanupResult>}
 */
export async function cleanup(bucket, options = {}) {
  requireArg(bucket, "bucket");
  const dryRun = Boolean(options["dry-run"]);
  const force = Boolean(options.force);
  const wait = Boolean(options.wait);

  // The non-interactive gate, up front — before the expensive scan, so a
  // misconfigured cron job fails in milliseconds with the fix, not minutes in.
  // Acting deletes objects; with no terminal to confirm on, the intent must be
  // explicit (--force). Mirrors delete (ADR-0064's destructive-command pattern).
  if (!dryRun && !force && !isInteractive(process.stdin)) {
    throw new Error(
      `Reclaiming storage deletes objects, and there is no terminal to ` +
        `confirm on.\n\n` +
        `Preview what would be reclaimed:\n` +
        `  ${shellCommand(`s3cab cleanup ${bucket} --dry-run`)}\n\n` +
        `Or reclaim without a prompt:\n` +
        `  ${shellCommand(`s3cab cleanup ${bucket} --force`)}`,
    );
  }

  // Snapshots, then the objects LIST, then the deletion record — the scan owns
  // that order (lib/bucket-scan.mjs), so a backup finishing mid-run only adds
  // unreferenced objects (which the top-up under the lock re-checks), never
  // makes a referenced object look missing. The record is what keeps a
  // referenced hash a `delete` explained (ADR-0064) out of interlock #2 —
  // without it, the first `delete` would make the act path refuse forever.
  const { snapshotFiles, referencedBySet, stored, deleted, invalidRecords } =
    await scanBucket(bucket);

  // The whole diff — orphans, the delete-list, and the missing/damaged/
  // unreadable tallies — is one pure computation over the two enumerations
  // (planCleanup, cleanup.mjs; the read-only twin of verifySet). Everything
  // below is the command's job: turn the plan's data into aborts, warnings, a
  // prompt, and the deletes.
  const plan = planCleanup(referencedBySet, stored, { deleted });
  const { orphanHashes, missing, damaged, reclaimableBytes } = plan;

  // Interlock #1 (both modes) and its twin: the same two checks `reclaim`
  // repeats for the snapshots its top-up reads.
  if (plan.unreadable.length > 0) {
    throw unreadableSnapshotsError(bucket, plan.unreadable);
  }
  const invalid = invalidRowSnapshots(referencedBySet);
  if (invalid.length > 0) {
    throw invalidRowsError(bucket, invalid);
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
    missingObjects: missing,
    deleted: 0,
    compactedRecordFiles: 0,
    trimmedRecordRows: 0,
  };

  // The counts report (stored/orphaned/reclaimable + the missing tally) is the
  // command's *result* — it renders to stdout via renderCleanup (ADR-0043), so
  // it isn't restated here. stderr carries only next-step guidance.
  if (dryRun) {
    console.warn(
      orphanHashes.length > 0
        ? `Dry run — nothing deleted. Re-run without --dry-run to reclaim ` +
            `(add --force when there's no terminal).`
        : `Dry run — no orphans to reclaim.`,
    );
    return report;
  }

  // Interlock #3 (act path only): compaction keeps only the rows it can parse
  // and then deletes the original, so a damaged record file would lose its
  // other rows for good (ADR-0101). One that vanished mid-read lost nothing,
  // but this run can't see its rows, so it can't trim against them either.
  // Checked before #2: a record file this run couldn't read leaves its deleted
  // hashes in `missing`, so #2 would call a deliberate delete lost data.
  const damagedRecords = invalidRecords.filter(({ vanished }) => !vanished);
  if (damagedRecords.length > 0) {
    throw new Error(
      `Can't clean up safely: the deletion record is damaged, and cleaning ` +
        `up would lose what it records.\n` +
        damagedRecords
          .map(({ uri, reason }) => `  ${uri} (${reason})`)
          .join("\n") +
        `\n\nFix what each one names, then re-run. The record's format is ` +
        `explained at https://s3cab.plantegral.com/guide/format`,
    );
  }
  if (invalidRecords.length > 0) {
    throw new Error(
      `Can't clean up right now: the deletion record changed while this run ` +
        `read it, most likely because another cleanup is compacting it.\n` +
        invalidRecords.map(({ uri }) => `  ${uri}`).join("\n") +
        `\n\nRe-run once that one has finished:\n` +
        `  ${shellCommand(`s3cab cleanup ${bucket}`)}`,
    );
  }

  // Interlock #2 (act path only): missing objects mean the repo is already losing
  // data — refuse, so cleanup never compounds a loss. Fix with verify first.
  if (missing > 0) {
    throw new Error(
      `Refusing to delete: the repository is missing ` +
        `${countOf(missing, "referenced object")} — it is already losing data, ` +
        `so this is not the moment to reclaim.\n\n` +
        `Check them with:\n` +
        `  ${shellCommand(`s3cab verify ${bucket}`)}`,
    );
  }

  // Confirm on a TTY unless --force; a non-interactive run reached here only via
  // --force (the up-front gate refuses otherwise), so this is the y/N for a human.
  // Nothing to reclaim needs no asking: the run still acts, since the record
  // compaction is housekeeping (above), and that is done under the lock too.
  if (orphanHashes.length > 0 && !force && isInteractive(process.stdin)) {
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

  const {
    deleted: removed,
    reclaimedBytes,
    referencedObjects,
    compaction,
  } = await reclaim(bucket, { plan, snapshotFiles, stored }, { wait });

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

  // The top-up's doing, said once: the scan's count was shown before the
  // prompt, so a smaller number deleted needs explaining.
  const kept = orphanHashes.length - removed;
  if (kept > 0) {
    console.warn(
      `Kept ${countOf(kept, "object")} the scan had counted as orphaned: a ` +
        `backup that finished meanwhile references ${kept === 1 ? "it" : "them"}.`,
    );
  }
  if (removed === 0) {
    console.warn("Nothing to reclaim.");
  }

  // What was reclaimed is the result (→ renderCleanup on stdout): the counts
  // after the top-up, not the scan's the prompt showed.
  report.deleted = removed;
  report.orphanObjects = removed;
  report.referencedObjects = referencedObjects;
  report.reclaimableBytes = reclaimedBytes;
  return report;
}
