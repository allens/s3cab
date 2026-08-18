import { mkdir, writeFile } from "node:fs/promises";
import { hostname, userInfo } from "node:os";
import { join } from "node:path";
import { formatMoment } from "../lib/format.mjs";

import {
  deletionRecordMoment,
  formatDeletionRecord,
  writeDeletionRecord,
} from "../lib/deletion-record.mjs";
import {
  deletionRows,
  formatDeletePreviewFile,
  formatDeleteSummary,
  planDelete,
  unreadableDeleteMessage,
} from "../lib/delete.mjs";
import { requireArg } from "../lib/error.mjs";
import { s3cabDir } from "../lib/home.mjs";
import { deleteStoredObject } from "../lib/objects.mjs";
import { promptLine } from "../lib/prompt.mjs";
import { referencedObjects } from "../lib/remote.mjs";
import { listSets, readSet, validateBucketName } from "../lib/sets.mjs";
import { isInteractive } from "../lib/style.mjs";

// The **preview**: a transient decision aid, overwritten every run, in the
// s3cab root because it belongs to no set (the same lifecycle as forget's
// preview — docs/design/snapshot-deletion.md; the *kept* artifact here is the
// deletion record in the bucket, not a local file).
const PREVIEW_FILE = "delete-preview.txt";

/**
 * Remove named paths' content from the whole backed-up history — "I have no
 * use for `foo`; stop paying to back it up", applied retroactively
 * ([ADR-0064](../../docs/adr/0064-path-scoped-delete-deletion-record.md),
 * [ADR-0063](../../docs/adr/0063-forget-snapshots-delete-paths.md)).
 * **Snapshots are never rewritten**: the objects backing the named paths are
 * deleted and every snapshot file stays an accurate point-in-time record; a
 * repository-level **deletion record** (`deletions/<timestamp>.tsv`,
 * guide/format.md) marks the removal as deliberate, so `verify` can tell
 * expected-missing from corruption and `restore` skips gracefully.
 *
 * **Addressing is the bucket** (`--bucket`), joining `verify`/`cleanup` as a
 * repository-level command under the standard credential chain — a `--set`
 * would promise a boundary the command doesn't have, since deletion spans
 * every participating set. Paths are the bulk operand (ADR-0062).
 *
 * **Scope: participating sets.** Named paths resolve to content within the
 * sets attached on this machine that point at this bucket; an object is
 * deleted only when *every* reference to it, bucket-wide, sits inside that
 * selection — any reference from an unattached set protects it (the preview
 * names the keeper), so other users' restorability cannot be broken by
 * construction. **`--everywhere`** switches the protection off for the
 * matched hashes (the leaked-secret case): those exact objects are deleted
 * regardless of who else references them, with the affected sets named in
 * the summary and their paths written into the record.
 *
 * **Acts by default; `-n`/`--dry-run` previews; `-f`/`--force` skips the
 * prompt.** On a TTY the run is single-pass, like `cleanup`: one whole-bucket
 * snapshot scan → the summary + preview file → the strongest confirmation in
 * the tool (type the bucket name) → the deletes from the plan already in
 * memory. Non-interactive runs refuse without `--force` (clig: fail with
 * instructions, never block on a prompt) — stricter than `forget`,
 * deliberately, for the command that removes content live snapshots still
 * reference. `--force` skips only the confirmation, never the scan (the scan
 * *is* the computation of what to delete) and never the unreadable-snapshot
 * interlock.
 *
 * **Record-first ordering:** the record is written (conditional PUT — never an
 * overwrite; a name another run already took takes the next one, ADR-0087)
 * *before* any object is deleted, so a crash mid-run can never leave missing
 * objects the record cannot explain.
 *
 * Old muscle memory (`s3cab delete --set <set> <snapshot>`) fails loudly
 * twice over: `--set` is not an option here, and a snapshot name matches no
 * backed-up path.
 *
 * @typedef {Object} DeleteResult
 * @property {string} bucket - The repository bucket
 * @property {string[]} paths - The paths named for removal, as given
 * @property {string[]} sets - The participating sets (attached here, this bucket)
 * @property {boolean} everywhere - Whether outside references were overridden
 * @property {number} deletedObjects - Stored objects removed
 * @property {number} deletedFiles - Paths that lost their content
 * @property {number} deletedBytes - Bytes those objects held
 * @property {number} survivors - Matched files kept by outside references
 * @property {string} [record] - The deletion record's URI (only when something was deleted)
 * @property {boolean} deleted - False on a dry run, a declined confirmation, or nothing to delete
 *
 * @param {string[]} [paths] - The paths to remove from history — the bulk operand (at least one)
 * @param {{ bucket?: string, "dry-run"?: boolean, force?: boolean, everywhere?: boolean }} [options]
 * @returns {Promise<DeleteResult>}
 */
export async function deletePaths(paths = [], options = {}) {
  requireArg(options.bucket, "bucket");
  requireArg(paths.length, "path");
  const bucket = /** @type {string} */ (options.bucket);
  validateBucketName(bucket);
  const dryRun = Boolean(options["dry-run"]);
  const force = Boolean(options.force);
  const everywhere = Boolean(options.everywhere);

  // The non-interactive gate, up front — before the expensive scan, so a
  // misconfigured cron job fails in milliseconds with the fix, not minutes in.
  if (!dryRun && !force && !isInteractive(process.stdin)) {
    throw new Error(
      `Deleting backed-up content needs a confirmation, and there is no ` +
        `terminal to ask on.\n` +
        `Preview what would be deleted:\n` +
        `  s3cab delete --bucket ${bucket} --dry-run <path>...\n` +
        `Or state the intent explicitly and skip the prompt:\n` +
        `  s3cab delete --bucket ${bucket} --force <path>...`,
    );
  }

  // The participating sets: attached on this machine, pointing at this bucket
  // — the scope named paths resolve within. A set directory that won't read
  // (hand-edited, mid-deletion) is skipped: it can only *narrow* the scope,
  // the fail-safe direction (less is deleted, never more).
  /** @type {string[]} */
  const scopeSets = [];
  for (const name of listSets()) {
    try {
      if (readSet(name).bucket === bucket) {
        scopeSets.push(name);
      }
    } catch {
      // unreadable set dir — excluded from scope (fail-safe)
    }
  }
  if (scopeSets.length === 0) {
    throw new Error(
      `No backup sets on this machine use bucket '${bucket}', so there is ` +
        `nothing to resolve the named paths against — delete works through ` +
        `the sets attached here.\n` +
        `See this machine's sets:\n` +
        `  s3cab list\n` +
        `Attach one that lives in that bucket:\n` +
        `  s3cab reattach <set> --bucket ${bucket}`,
    );
  }

  // The whole-bucket snapshot scan — the operation's one expensive step, and
  // the only correct basis for "does anything else still reference this?"
  // (dedup is global, ADR-0013). Single-pass like cleanup: everything after
  // this — summary, confirmation, record, deletes — works off this scan.
  const referencedBySet = await referencedObjects(bucket);

  const plan = planDelete(referencedBySet, { paths, scopeSets, everywhere });

  // Interlock (both modes except dry-run, and --force does not lift it): an
  // unreadable snapshot's references are unknown, and an unknown reference is
  // exactly what must protect an object here — deleting past it destroys
  // live data, cleanup's own abort logic. A dry run may proceed to *show*
  // the caveated preview; acting may not.
  if (plan.unreadable.length > 0 && !dryRun) {
    throw new Error(unreadableDeleteMessage(plan.unreadable, bucket));
  }

  // Every named path must name something backed up — the loud error that
  // catches a typo, a never-backed-up path, and the old delete-a-snapshot
  // muscle memory alike, before anything is shown or removed.
  if (plan.unmatchedPaths.length > 0) {
    throw new Error(
      `${plan.unmatchedPaths.length === 1 ? "This path matches" : "These paths match"} ` +
        `no backed-up file in ${
          scopeSets.length === 1
            ? `set '${scopeSets[0]}'`
            : `sets ${scopeSets.map((s) => `'${s}'`).join(", ")}`
        }:\n` +
        plan.unmatchedPaths.map((p) => `  ${p}`).join("\n") +
        `\n` +
        `Paths must match files as the snapshots record them — copy one from:\n` +
        `  s3cab tree <set>`,
    );
  }

  // One clock read for the whole run: the record's name, its `generated:` line,
  // and the summary all agree by construction (ADR-0072).
  const moment = deletionRecordMoment();
  const record = formatDeletionRecord(
    {
      generated: formatMoment(moment),
      bucket,
      by: `${userInfo().username}@${hostname()}`,
      sets: scopeSets,
      paths,
      everywhere,
      totals: {
        files: plan.totalFiles,
        bytes: plan.totalBytes,
        objects: plan.deletable.length,
      },
    },
    deletionRows(plan),
  );

  // The preview lands before any prompt (forget's pattern): declining still
  // leaves the full list on disk to read, without paying for a second scan.
  const previewPath = join(s3cabDir(), PREVIEW_FILE);
  await mkdir(s3cabDir(), { recursive: true });
  await writeFile(previewPath, formatDeletePreviewFile(plan, record));

  // Pre-decision output goes to stdout here rather than through `render`
  // (ADR-0043), which only runs after the command returns — past the point of
  // no return.
  console.log(
    formatDeleteSummary(plan, {
      everywhere,
      reportPath: previewPath,
      bucket,
    }),
  );

  const result = {
    bucket,
    paths,
    sets: scopeSets,
    everywhere,
    deletedObjects: plan.deletable.length,
    deletedFiles: plan.totalFiles,
    deletedBytes: plan.totalBytes,
    survivors: plan.survivors.length,
    deleted: false,
  };

  if (dryRun) {
    console.warn(
      plan.deletable.length > 0
        ? `Dry run — nothing deleted. Re-run without --dry-run to delete.`
        : `Dry run — nothing to delete.`,
    );
    return result;
  }

  if (plan.deletable.length === 0) {
    // The summary above already said why nothing is deletable (survivors, or
    // no match), and the renderer prints the stdout result line — so there is
    // no stderr note to add here that wouldn't just duplicate it.
    return result;
  }

  // The strongest confirmation in the tool (ADR-0063/0064, clig's
  // severe-tier): type back the bucket name — the thing being irreversibly
  // changed. Anything else, including a stray Enter, cancels.
  if (!force && isInteractive(process.stdin)) {
    const answer = await promptLine(
      `\nThis permanently removes the content above from every backup in ` +
        `'${bucket}'.\nType the bucket name to proceed: `,
    );
    if (answer !== bucket) {
      console.warn("Cancelled — nothing was deleted.");
      return result;
    }
  }

  // Record first, then the deletes (never the other way around): a crash
  // between the two leaves an over-complete record — objects recorded deleted
  // that still exist, which verify reads as simply present — never missing
  // objects with no explanation.
  const recordUri = await writeDeletionRecord(bucket, moment.name, record);
  for (const { hash } of plan.deletable) {
    await deleteStoredObject(bucket, hash);
  }

  console.warn(
    `Deleted ${plan.deletable.length} object(s). Snapshots were not modified — ` +
      `verify and restore read the deletion record to tell deliberate ` +
      `removal from damage.\n` +
      `Record of this removal:\n  ${recordUri}`,
  );

  return { ...result, record: recordUri, deleted: true };
}
