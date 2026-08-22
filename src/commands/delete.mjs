import { readFile } from "node:fs/promises";
import { hostname, userInfo } from "node:os";
import { collectHashes, EMPTY_FILE_HASH } from "../lib/delete.mjs";
import {
  formatDeletionRecord,
  writeDeletionRecord,
} from "../lib/deletion-record.mjs";
import { isENOENT, requireArg } from "../lib/error.mjs";
import { countOf, formatByteValue } from "../lib/format.mjs";
import { deleteStoredObject, storedObjectSize } from "../lib/objects.mjs";
import { promptLine } from "../lib/prompt.mjs";
import { validateBucketName } from "../lib/sets.mjs";
import { isInteractive } from "../lib/style.mjs";

/**
 * Delete stored objects by content hash, from every backup, permanently —
 * the destructive half of the `find`/`delete` pair
 * ([ADR-0089](../../docs/adr/0089-hash-operand-delete.md)): the read-only
 * search decides *what* (and writes a reviewable file), this destroys it. An
 * irreversible bucket-wide delete must not take a fuzzy operand, so the
 * operand is the exact identity of the thing destroyed — hashes, positional
 * or via `--from-file` (`find`'s output, or any file with hashes in column
 * one). No piping: a file means a human could review and edit the rows.
 *
 * Removal is repository-wide by construction: dedup stores one copy of
 * identical content for every path, set and machine that backed it up, so
 * snapshots anywhere may be left listing content that is deliberately gone.
 * **Snapshots are never rewritten**; a repository-level **deletion record**
 * (`objects.deleted-<n>.tsv`,
 * [ADR-0090](../../docs/adr/0090-deletion-record-format-compaction.md)) marks
 * the removal as deliberate, so `verify` can tell expected-missing from
 * corruption and `restore` skips gracefully.
 *
 * **Preflight `HeadObject` per hash** before anything is deleted: hashes the
 * bucket does not hold are reported and skipped, not fatal (a hash pasted
 * from the wrong bucket, a stale `find` file, something already deleted), and
 * `ContentLength` fills the record's size column and gives the prompt a real
 * figure. The empty-file hash is refused outright — it backs every zero-byte
 * file in the repository, so deleting it is never what anyone means.
 *
 * **Acts by default; `-n`/`--dry-run` previews; `-f`/`--force` skips the
 * prompt.** On a TTY the confirmation is the strongest in the tool (type the
 * bucket name — ADR-0064's tier, unchanged: the operand got safer, the
 * consequence did not); non-interactive runs refuse without `--force`.
 * **Record-first ordering:** the record is written (conditional PUT at the
 * next free index — never an overwrite) *before* any object is deleted, so a
 * crash mid-run can never leave missing objects the record cannot explain.
 *
 * @typedef {Object} DeleteResult
 * @property {string} bucket - The repository bucket
 * @property {number} deletedObjects - Stored objects to remove (removed, when `deleted`)
 * @property {number} deletedBytes - Bytes those objects held
 * @property {string[]} missing - Named hashes the bucket doesn't hold (skipped)
 * @property {string} [record] - The deletion record's URI (only when something was deleted)
 * @property {boolean} deleted - False on a dry run, a declined confirmation, or nothing to delete
 *
 * @param {string[]} [hashes] - Content hashes of the objects to delete — the bulk operand
 * @param {{ bucket?: string, "from-file"?: string, "dry-run"?: boolean, force?: boolean }} [options]
 * @returns {Promise<DeleteResult>}
 */
export async function deleteHashes(hashes = [], options = {}) {
  requireArg(options.bucket, "bucket");
  const bucket = /** @type {string} */ (options.bucket);
  validateBucketName(bucket);
  const fromFile = options["from-file"];
  requireArg(hashes.length > 0 || fromFile, "hash");
  const dryRun = Boolean(options["dry-run"]);
  const force = Boolean(options.force);

  /** @type {string | undefined} */
  let fileText;
  if (fromFile !== undefined) {
    try {
      fileText = await readFile(fromFile, "utf8");
    } catch (error) {
      if (!isENOENT(error)) {
        throw error;
      }
      throw new Error(
        `Can't read the hash list — there is no file '${fromFile}' ` +
          `(--from-file).\n` +
          `Write one with the search command, review it, then re-run:\n` +
          `  s3cab find <pattern> > ${fromFile}`,
        { cause: error },
      );
    }
  }

  const collected = collectHashes(hashes, fileText);
  // Anything that is not a SHA-256 — a path, a snapshot name, old muscle
  // memory — errors loudly before anything is shown or removed. Exactness is
  // the operand's whole safety story (ADR-0089), so there is no guessing.
  if (collected.rejected.length > 0) {
    throw new Error(
      `delete takes content hashes (64 hex characters), and ` +
        `${collected.rejected.length === 1 ? "this isn't one" : "these aren't"}:\n` +
        collected.rejected.map((entry) => `  ${entry}`).join("\n") +
        `\n` +
        `Find the hashes backing a file or directory with:\n` +
        `  s3cab find <pattern>`,
    );
  }
  if (collected.hashes.length === 0) {
    throw new Error(
      `No hashes to delete — '${fromFile}' has none in column one.\n` +
        `Write a fresh list with:\n` +
        `  s3cab find <pattern> > ${fromFile}`,
    );
  }
  if (collected.hashes.includes(EMPTY_FILE_HASH)) {
    throw new Error(
      `Refusing to delete ${EMPTY_FILE_HASH.slice(0, 12)}… — that is the ` +
        `empty file's hash (the SHA-256 of zero bytes), the one object ` +
        `backing every zero-byte file in the repository.\n` +
        `Remove it from the list and re-run.`,
    );
  }

  // The non-interactive gate, up front — before any S3 traffic, so a
  // misconfigured cron job fails in milliseconds with the fix.
  if (!dryRun && !force && !isInteractive(process.stdin)) {
    throw new Error(
      `Deleting backed-up content needs a confirmation, and there is no ` +
        `terminal to ask on.\n` +
        `Preview what would be deleted:\n` +
        `  s3cab delete --bucket ${bucket} --dry-run <hash>...\n` +
        `Or state the intent explicitly and skip the prompt:\n` +
        `  s3cab delete --bucket ${bucket} --force <hash>...`,
    );
  }

  // Preflight: one HEAD per hash. Missing ones are reported and skipped, not
  // fatal — and the sizes that come back are the record's size column and the
  // prompt's real figure.
  /** @type {{ hash: string, size: number }[]} */
  const found = [];
  /** @type {string[]} */
  const missing = [];
  for (const hash of collected.hashes) {
    const size = await storedObjectSize(bucket, hash);
    if (size === undefined) {
      missing.push(hash);
    } else {
      found.push({ hash, size });
    }
  }
  const totalBytes = found.reduce((total, { size }) => total + size, 0);

  if (missing.length > 0) {
    console.warn(
      `Skipping ${countOf(missing.length, "hash")} not stored in ` +
        `'${bucket}' (already deleted, or from another bucket):\n` +
        missing.map((hash) => `  ${hash}`).join("\n"),
    );
  }

  // Pre-decision output goes to stdout here rather than through `render`
  // (ADR-0043), which only runs after the command returns — past the point of
  // no return.
  console.log(
    found.length === 0
      ? `Nothing to delete: none of the named hashes are stored in '${bucket}'.`
      : `Deleting ${countOf(found.length, "object")} ` +
          `(${formatByteValue(totalBytes)}) from every backup in '${bucket}'.`,
  );

  const result = {
    bucket,
    deletedObjects: found.length,
    deletedBytes: totalBytes,
    missing,
    deleted: false,
  };

  if (dryRun) {
    console.warn(
      found.length > 0
        ? `Dry run — nothing deleted. Re-run without --dry-run to delete.`
        : `Dry run — nothing to delete.`,
    );
    return result;
  }

  if (found.length === 0) {
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
  // objects with no explanation. One clock read and one identity for the run,
  // so every row agrees by construction.
  const instant = new Date().toISOString();
  const by = `${userInfo().username}@${hostname()}`;
  const recordUri = await writeDeletionRecord(
    bucket,
    formatDeletionRecord(
      instant,
      found.map(({ hash, size }) => ({ hash, size, instant, by })),
    ),
  );
  for (const { hash } of found) {
    await deleteStoredObject(bucket, hash);
  }

  // No headline: `renderDelete` states the count and that snapshots stand, on
  // stdout. What is left is the one thing the result can't carry — where the
  // record went, and why it exists.
  console.warn(
    `Record of this removal — verify and restore read it to tell deliberate ` +
      `removal from damage:\n  ${recordUri}`,
  );

  return { ...result, record: recordUri, deleted: true };
}
