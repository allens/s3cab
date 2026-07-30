import { formatByteValue } from "./format.mjs";
import { getText, listObjects, putText } from "./s3.mjs";
import { snapshotMoment } from "./snapshot-file.mjs";

// The repository's **deletion record** — the `deletions/` half-page of the
// stored format (guide/format.md, ADR-0064). Each `delete` run writes one plain
// uncompressed TSV under `deletions/<timestamp>.tsv` (S3 has no atomic append,
// so one file per run avoids lost updates) listing every reference the deleted
// objects had. The record is what turns "deliberately gone" into a checkable
// repository fact: `verify` partitions missing objects into expected (in the
// record) vs unexplained, `restore` skips a recorded hash gracefully instead of
// failing, and `backup`/`cleanup` subtract recorded hashes from their
// baselines/interlocks. Like objects.mjs and remote.mjs, this module owns its
// prefix's layout end-to-end; s3.mjs stays the generic SDK boundary.

const DELETIONS_PREFIX = "deletions/";

/**
 * The S3 key of one deletion record: `deletions/<name>.tsv`. Plain uncompressed
 * TSV, unlike snapshots' `.tsv.zst` — a record is small, and it doubles as the
 * human-readable audit artifact, so direct readability beats a negligible size
 * win (guide/format.md).
 * @param {string} name - Record name without extension, e.g. `2026-07-19T1422`
 * @returns {string}
 */
export const deletionRecordKey = (name) => `${DELETIONS_PREFIX}${name}.tsv`;

/** @param {string} bucket @param {string} name */
const deletionRecordUri = (bucket, name) =>
  `s3://${bucket}/${deletionRecordKey(name)}`;

/**
 * "Now" as a deletion record's moment — the *same* minute-precision local name,
 * UTC instant and zone a snapshot gets (`snapshotMoment`), reused deliberately
 * so the format spec tells one story for both timestamped artifacts (ADR-0072).
 * Minute precision means a same-minute second run *collides*; like a same-minute
 * snapshot, that is a loud error, not an overwrite (`writeDeletionRecord`'s
 * conditional PUT).
 * @returns {{ name: string, instant: string, zone: string }}
 */
export const deletionRecordMoment = snapshotMoment;

/**
 * Write one deletion record — a conditional PUT (`IfNoneMatch: *`), so a
 * same-minute second run fails atomically instead of silently overwriting a
 * record of a destructive act that cannot be reconstructed. Under `S3CAB_DEBUG`
 * the condition is dropped (tests re-run within a minute).
 *
 * The caller writes the record **before deleting any object** (record-first):
 * a crash mid-delete must never leave missing objects the record cannot
 * explain — over-recording a delete that then didn't finish is the safe
 * direction (verify reads an intact repository as intact regardless).
 * @param {string} bucket - The repository's S3 bucket
 * @param {string} name - The record name (from {@link deletionRecordTimestamp})
 * @param {string} content - The record body (from `formatDeletionRecord`)
 * @returns {Promise<string>} The record's `s3://` URI
 */
export async function writeDeletionRecord(bucket, name, content) {
  const uri = deletionRecordUri(bucket, name);
  const wrote = await putText(uri, content, {
    noClobber: !process.env.S3CAB_DEBUG,
  });
  if (!wrote) {
    throw new Error(
      `A deletion record for this minute already exists (${uri}) — another ` +
        `delete finished within the last minute, and records are never ` +
        `overwritten.\n` +
        `Wait for the next minute, then re-run.`,
    );
  }
  return uri;
}

/**
 * A recorded deletion, as consumers use it: when the content was deleted (the
 * record's timestamp name) — the context `verify` and `restore` print with an
 * expected-missing finding.
 * @typedef {Object} RecordedDeletion
 * @property {string} deletedOn - The record's timestamp name, e.g. `2026-07-19T1422`
 */

/**
 * Read every deletion record in the bucket into one hash lookup — the
 * repository's complete "deliberately gone" set, for `verify`'s
 * expected/unexplained partition, `restore`'s graceful skip, and the
 * `backup`/`cleanup` subtractions. An empty `deletions/` (the common case —
 * most repositories never run `delete`) costs one LIST returning nothing.
 *
 * Parsing is deliberately lenient in the lenient direction only: `#` comments
 * and blank lines are skipped, and a row's first field must *look like* a
 * SHA-256 (64 hex chars) to count — a mangled row is ignored rather than
 * explaining away a missing object it never named. A hash recorded twice
 * (re-deleted after a re-backup) keeps the newest record's timestamp.
 * @param {string} bucket - The repository's S3 bucket
 * @returns {Promise<Map<string, RecordedDeletion>>} hash → its recorded deletion
 */
export async function readDeletionRecords(bucket) {
  /** @type {string[]} */
  const names = [];
  for await (const { Key } of listObjects(
    `s3://${bucket}/${DELETIONS_PREFIX}`,
  )) {
    const file = Key?.slice(DELETIONS_PREFIX.length);
    if (file && /^\d{4}-\d{2}-\d{2}T\d{4}\.tsv$/.test(file)) {
      names.push(file.slice(0, -".tsv".length));
    }
  }
  names.sort(); // oldest first, so a re-recorded hash keeps the newest timestamp

  /** @type {Map<string, RecordedDeletion>} */
  const deleted = new Map();
  for (const name of names) {
    const text = await getText(deletionRecordUri(bucket, name));
    if (text === undefined) {
      continue; // vanished between LIST and read — nothing to explain with
    }
    for (const line of text.split("\n")) {
      if (!line || line.startsWith("#")) {
        continue;
      }
      const hash = line.slice(0, line.indexOf("\t"));
      if (/^[0-9a-f]{64}$/.test(hash)) {
        deleted.set(hash, { deletedOn: name });
      }
    }
  }
  return deleted;
}

/**
 * The record file's body: a `#` comment header saying what the run was —
 * when, where, who, the scope, and the paths asked for — then one
 * `hash<TAB>path` row per reference the deleted objects had. **All**
 * references, not just the deleting machine's: under `--everywhere` other
 * sets' paths are removed too, and their `verify`/`restore` read this record
 * for the explanation, so their rows belong here. No per-row timestamp (the
 * record's name is the timestamp) and no per-row size (misleading under
 * dedup — the trustworthy totals live in the header, the same reasoning as
 * the forget report).
 * @param {object} context
 * @param {string} context.generated - The moment, as `formatMoment` writes it: the UTC instant, then this record's own name and zone
 * @param {string} context.bucket - The repository bucket
 * @param {string} context.by - Who ran it, `user@machine`
 * @param {string[]} context.sets - The sets in scope on that machine
 * @param {string[]} context.paths - The paths named on the command line
 * @param {boolean} context.everywhere - Whether the run was `--everywhere`
 * @param {{ files: number, bytes: number, objects: number }} context.totals
 * @param {{ hash: string, path: string }[]} rows - Every removed reference,
 *   one row per (hash, path)
 * @returns {string}
 */
export function formatDeletionRecord(context, rows) {
  const { generated, bucket, by, sets, paths, everywhere, totals } = context;
  const pathLines = paths.map(
    (p, i) => `#${i === 0 ? " paths:     " : "            "} ${p}`,
  );
  const header = [
    `# s3cab delete — content deliberately removed from this repository`,
    `# generated:  ${generated}`,
    `# bucket:     ${bucket}`,
    `# by:         ${by}`,
    `# sets:       ${sets.join(", ")}`,
    `# scope:      ${everywhere ? "everywhere (every reference, all sets)" : "the sets above only"}`,
    ...pathLines,
    `#`,
    `# ${files(totals.files)}, holding ${formatByteValue(totals.bytes)} across ` +
      `${totals.objects.toLocaleString("en")} stored object${totals.objects === 1 ? "" : "s"}.`,
    `#`,
    `# The objects backing the files below were deleted on purpose; snapshots`,
    `# still listing them cannot restore them. Tools reading this repository`,
    `# should treat these hashes as deliberately absent, not as damage.`,
    `#`,
    `# hash\tpath`,
  ];
  const body = rows.map(({ hash, path }) => `${hash}\t${path}`);
  return [...header, ...body, ``].join("\n");
}

/** @param {number} n */
const files = (n) => `${n.toLocaleString("en")} file${n === 1 ? "" : "s"}`;
