import { deleteObject, getText, listObjects, putText } from "./s3.mjs";

// The repository's **deletion record** — the root-level `objects.deleted-<n>.tsv`
// files of the stored format (guide/format.md, ADR-0090). The record is a
// tombstone, not a ledger: its one job is to tell a reader that an absence is
// *deliberate* — `verify` partitions missing objects into expected vs
// unexplained, `restore` skips a recorded hash gracefully instead of failing,
// and `backup`/`cleanup` subtract recorded hashes from their
// baselines/interlocks. Rows carry hash/size/instant/user@machine and **no
// paths**: every reader already has the path in front of it (it reached the
// record through a snapshot), so after "this was deliberate" the useful facts
// are who and when. When and who live in the rows, not the filename, because
// compaction (below) destroys filenames.
//
// S3 has no atomic append, so each `delete` run writes a fresh file at the next
// free index — LIST, conditional PUT (`IfNoneMatch: *`), walk upward on a lost
// race (ADR-0087's mechanism, retained purely as a slot allocator). `cleanup`
// compacts: union every row, drop rows no snapshot anywhere references, write
// the merge to a *fresh* index, then delete the absorbed files — write-before-
// delete makes every crashed intermediate state correct, since a duplicated row
// is still just "deliberately gone". Like objects.mjs and remote.mjs, this
// module owns its keys' layout end-to-end; s3.mjs stays the generic SDK
// boundary.

// The record files sit at the bucket root, beside `objects/` — safe from that
// prefix's LIST because it carries its trailing slash.
const RECORD_PREFIX = "objects.deleted-";

/** @param {string} bucket @param {number} index */
const recordUri = (bucket, index) =>
  `s3://${bucket}/${RECORD_PREFIX}${index}.tsv`;

/** Matches a record file's key and captures its index. */
const RECORD_KEY = /^objects\.deleted-([1-9][0-9]*)\.tsv$/;

// How far past the next free index the allocator will walk before giving up.
// Not a contention limit — real contention is two or three concurrent runs —
// but a backstop, so a `putText` refusing for some reason other than the key
// existing can't spin against S3 forever.
const MAX_ALLOCATION_ATTEMPTS = 100;

/**
 * One deletion-record row: what was deleted, how big it was (the preflight
 * HEAD's ContentLength), when (full UTC instant), and by whom
 * (`user@machine`). The columns match a snapshot row's column *types*
 * positionally — col1 hash-or-`#TAG`, col2 size, col3 timestamp, col4 the
 * ragged textual end — so the format spec's four reading rules cover both
 * files (guide/format.md).
 * @typedef {Object} DeletionRow
 * @property {string} hash - The deleted object's SHA-256
 * @property {number} size - The object's stored size in bytes
 * @property {string} instant - When it was deleted, e.g. `2026-08-22T11:04:55.120Z`
 * @property {string} by - Who deleted it, `user@machine`
 */

/**
 * The record file's body: a `#DELETED` header row (col3 = when this file was
 * written, col4 = the one sentence a human reader needs), one row per deleted
 * object, and a bare `#END` trailer. The trailer carries no
 * `COMPLETE`/`PARTIAL`: a record is uncompressed and lands in one atomic PUT,
 * so `PARTIAL` cannot occur, and a status column with one possible value would
 * imply a distinction that does not exist (ADR-0090; the format spec already
 * admits a bare trailer). Rows sort by instant then hash, so a compacted
 * file reads chronologically.
 * @param {string} instant - When this file is being written (full UTC instant)
 * @param {DeletionRow[]} rows
 * @returns {string}
 */
export function formatDeletionRecord(instant, rows) {
  const header =
    `#DELETED\t\t${instant}\t` +
    `These objects were removed on purpose. Absence here is not damage.`;
  const body = [...rows]
    .sort(
      (a, b) =>
        a.instant.localeCompare(b.instant) || a.hash.localeCompare(b.hash),
    )
    .map(
      ({ hash, size, instant: when, by }) => `${hash}\t${size}\t${when}\t${by}`,
    );
  return [header, ...body, `#END`, ``].join("\n");
}

/**
 * Parse one record file's rows. Deliberately lenient in the lenient direction
 * only: `#` rows (header, trailer) and blank lines are skipped, and a row's
 * first field must *look like* a SHA-256 (64 hex chars) to count — a mangled
 * row is ignored rather than explaining away a missing object it never named.
 * A mangled size parses to 0 rather than dropping the row: the hash is intact,
 * and "deliberately gone" is the fact that must survive.
 * @param {string} text - A record file's body
 * @returns {DeletionRow[]}
 */
export function parseDeletionRecord(text) {
  /** @type {DeletionRow[]} */
  const rows = [];
  for (const line of text.split("\n")) {
    if (!line || line.startsWith("#")) {
      continue;
    }
    const [hash = "", size = "", instant = "", ...rest] = line.split("\t");
    if (/^[0-9a-f]{64}$/.test(hash)) {
      const bytes = Number(size);
      rows.push({
        hash,
        size: Number.isFinite(bytes) ? bytes : 0,
        instant,
        by: rest.join("\t"),
      });
    }
  }
  return rows;
}

/**
 * Every record file currently in the bucket, by index. One LIST on the
 * root-level prefix; keys that don't follow the record grammar (a console
 * folder marker, a stray hand-dropped file) are ignored.
 * @param {string} bucket
 * @returns {Promise<{ index: number, uri: string }[]>}
 */
async function listDeletionRecordFiles(bucket) {
  /** @type {{ index: number, uri: string }[]} */
  const files = [];
  for await (const { Key } of listObjects(`s3://${bucket}/${RECORD_PREFIX}`)) {
    const match = Key === undefined ? null : RECORD_KEY.exec(Key);
    if (match) {
      const index = Number(match[1]);
      files.push({ index, uri: recordUri(bucket, index) });
    }
  }
  return files;
}

/**
 * Write one deletion record at the next free index — always a conditional PUT
 * (`IfNoneMatch: *`), so a record of a destructive act that cannot be
 * reconstructed is never overwritten. Losing a race (another delete, or a
 * cleanup compaction, took the index between the LIST and the PUT) is **not**
 * an error: the run walks upward until a PUT lands, so both writers get
 * recorded. An index is a slot, not information — the when/who a reader wants
 * live in the rows.
 *
 * The caller writes the record **before deleting any object** (record-first):
 * a crash mid-delete must never leave missing objects the record cannot
 * explain — over-recording a delete that then didn't finish is the safe
 * direction (verify reads an intact repository as intact regardless).
 * @param {string} bucket - The repository's S3 bucket
 * @param {string} content - The record body (from {@link formatDeletionRecord})
 * @returns {Promise<string>} The record's `s3://` URI
 */
export async function writeDeletionRecord(bucket, content) {
  const files = await listDeletionRecordFiles(bucket);
  const next = Math.max(0, ...files.map((f) => f.index)) + 1;
  for (let i = next; i < next + MAX_ALLOCATION_ATTEMPTS; i++) {
    const uri = recordUri(bucket, i);
    const wrote = await putText(uri, content, { noClobber: true });
    if (wrote) {
      return uri;
    }
  }
  throw new Error(
    `Couldn't record this deletion: every index from ${next} to ` +
      `${next + MAX_ALLOCATION_ATTEMPTS - 1} of s3://${bucket}/${RECORD_PREFIX}*.tsv ` +
      `is already taken, which shouldn't happen.\n` +
      `Nothing was deleted — the record is written first, so your data is ` +
      `untouched. Check what is writing those keys, then re-run:\n` +
      `  aws s3 ls s3://${bucket}/`,
  );
}

/**
 * A recorded deletion, as consumers use it: when the content was deleted (the
 * row's UTC instant) — the context `verify` and `restore` print with an
 * expected-missing finding.
 * @typedef {Object} RecordedDeletion
 * @property {string} deletedOn - The row's instant, e.g. `2026-08-22T11:04:55.120Z`
 */

/**
 * Read every deletion record in the bucket into one hash lookup — the
 * repository's complete "deliberately gone" set, for `verify`'s
 * expected/unexplained partition, `restore`'s graceful skip, and the
 * `backup`/`cleanup` subtractions. A repository that never ran `delete` (the
 * common case) costs one LIST returning nothing. A hash recorded twice
 * (re-deleted after a re-backup) keeps the newest row's instant — compared on
 * the rows themselves, since a compacted file holds rows from many runs.
 * @param {string} bucket - The repository's S3 bucket
 * @returns {Promise<Map<string, RecordedDeletion>>} hash → its recorded deletion
 */
export async function readDeletionRecords(bucket) {
  /** @type {Map<string, RecordedDeletion>} */
  const deleted = new Map();
  for (const { uri } of await listDeletionRecordFiles(bucket)) {
    const text = await getText(uri);
    if (text === undefined) {
      continue; // vanished between LIST and read (a compaction) — its rows live on in the merge
    }
    for (const { hash, instant } of parseDeletionRecord(text)) {
      const known = deleted.get(hash);
      // UTC instants compare chronologically as strings.
      if (!known || known.deletedOn < instant) {
        deleted.set(hash, { deletedOn: instant });
      }
    }
  }
  return deleted;
}

/**
 * Compact the deletion record — `cleanup`'s half of the format (ADR-0090):
 * union every row across every record file, drop rows whose hash no snapshot
 * anywhere references, write the merge to a *fresh* index, then delete the
 * absorbed files. The steady state after any cleanup is a single file.
 *
 * **Trimming is safe** because every consumer reaches the record *through a
 * snapshot that references the hash* — verify computes referenced − stored,
 * restore is reading a snapshot when it hits the absence, cleanup subtracts
 * from its missing-object interlock, and backup trusts a baseline only while
 * it still exists remotely byte-identical, which makes the baseline itself a
 * live reference. So "no snapshot references H" ⟹ nothing can ever ask about
 * H ⟹ the row is dead. The caller must have proven `referenced` complete —
 * cleanup's unreadable-snapshot interlock aborts long before this runs, so an
 * unknown reference protects every row.
 *
 * Crash-safe by ordering, not by locking: the merge is written before any
 * absorbed file is deleted, so a crash can only leave rows duplicated across
 * files — and a duplicated row is still just "deliberately gone", collapsed by
 * the next compaction. Two concurrent compactions merge to two fresh files the
 * same way. A `delete` running concurrently writes to an index this run's LIST
 * never saw, so its record is never absorbed or deleted.
 * @param {string} bucket - The repository's S3 bucket
 * @param {Set<string>} referenced - Every hash any snapshot in the bucket
 *   references (`planCleanup`'s union) — rows outside it are dropped
 * @param {object} [options]
 * @param {string} [options.instant] - The merge file's header instant
 *   (defaults to now; injectable like `planCleanup`'s clock)
 * @returns {Promise<{ files: number, rows: number, trimmed: number }>} What
 *   compaction did: record `files` absorbed, `rows` kept, `trimmed` rows
 *   dropped. `files: 0` means the record was already compact (or absent).
 */
export async function compactDeletionRecords(
  bucket,
  referenced,
  { instant = new Date().toISOString() } = {},
) {
  const files = await listDeletionRecordFiles(bucket);
  /** @type {Map<string, DeletionRow>} identical rows collapse (a crashed merge) */
  const rows = new Map();
  let total = 0;
  /** @type {{ index: number, uri: string }[]} */
  const absorbed = [];
  for (const file of files) {
    const text = await getText(file.uri);
    if (text === undefined) {
      continue; // vanished since the LIST (a concurrent compaction absorbed it)
    }
    absorbed.push(file);
    for (const row of parseDeletionRecord(text)) {
      total++;
      rows.set(`${row.hash}\t${row.size}\t${row.instant}\t${row.by}`, row);
    }
  }

  const kept = [...rows.values()].filter((row) => referenced.has(row.hash));
  // Rows dropped because nothing references them — collapsed duplicates (a
  // crashed earlier merge) are dedup, not trimming, so they don't count here.
  const trimmed = rows.size - kept.length;

  // Already compact: one file, nothing trimmed, no duplicate rows — rewriting
  // it would churn an index for no change.
  if (absorbed.length === 1 && trimmed === 0 && total === rows.size) {
    return { files: 0, rows: kept.length, trimmed: 0 };
  }
  if (absorbed.length === 0) {
    return { files: 0, rows: 0, trimmed: 0 };
  }

  // Merge first, delete second — the order is the crash-safety. A merge with
  // no surviving rows writes nothing: a row nothing references needs no
  // tombstone, so the steady state there is no record file at all.
  if (kept.length > 0) {
    await writeDeletionRecord(bucket, formatDeletionRecord(instant, kept));
  }
  for (const { uri } of absorbed) {
    await deleteObject(uri);
  }
  return { files: absorbed.length, rows: kept.length, trimmed };
}
