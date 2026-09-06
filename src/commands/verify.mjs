import { scanBucket } from "../lib/bucket-scan.mjs";
import { requireArg } from "../lib/error.mjs";
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
 * plus any `unreadableSnapshots`. Missing is **partitioned by the deletion
 * record** (ADR-0064): a hash the record explains is reported as
 * `expectedMissing` with its deletion date — context, not a finding, so it
 * never affects the exit code and `verify || alert` stays meaningful after a
 * deliberate `delete`. Both are computed from one bucket scan (`scanBucket`)
 * with zero extra requests: the bucket's *referenced* objects per set, its
 * *stored* objects (one `objects/` LIST) and the deletion record — read in
 * that order, which is the scan's safety property, not this command's
 * (lib/bucket-scan.mjs).
 *
 * **No side effects — read-only:** verify runs on List+Get credentials alone; it
 * never writes to the bucket and keeps no local state. **Exit 1** when any set
 * has findings (via `process.exitCode`, so the report still prints); a clean run
 * returns 0.
 *
 * **Orphans are not verify's concern.** Objects no snapshot references
 * (`stored − referenced`) are a *reclamation* matter, never an integrity one —
 * they can't threaten restorability — so they moved to `cleanup`'s
 * non-destructive mode, where the unreadable-snapshot caveat is a real safety
 * gate rather than an advisory flag (ADR-0042,
 * [docs/design/backup.md](../../docs/design/backup.md)). verify's result
 * is therefore just `{ bucket, sets }`.
 *
 * @param {string} [bucket] - The repository's S3 bucket to check
 * @returns {Promise<{ bucket: string, sets: SetReport[] }>}
 *   Per-set reports (the flat per-path `problems` list plus any unreadable
 *   snapshots), sorted by set name.
 */
export async function verify(bucket) {
  requireArg(bucket, "bucket");

  // Snapshots, then the objects LIST, then the deletion record — the scan owns
  // that order (lib/bucket-scan.mjs), so a backup or a `delete` landing mid-run
  // can only bump the orphan count, never fake a missing object.
  const { referencedBySet, stored, deleted } = await scanBucket(bucket);

  const reports = [...referencedBySet]
    .map(([set, referenced]) => verifySet(set, referenced, stored, deleted))
    .sort((a, b) => a.set.localeCompare(b.set));

  // Any finding in any set → exit 1 (ADR-0042). Set process.exitCode rather than
  // throw, so the report still prints to stdout (the entry point renders a
  // returned result even when the exit code is nonzero).
  if (reports.some(setHasFindings)) {
    process.exitCode = 1;
  }

  return { bucket, sets: reports };
}
