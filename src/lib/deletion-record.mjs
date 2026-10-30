import { showControlChars } from "./format.mjs";
import {
  deleteObject,
  getStream,
  isObjectNotFound,
  listObjects,
  putText,
} from "./s3.mjs";
import {
  formatLine,
  HEADING,
  isInstant,
  openingRows,
  parseS3cabFile,
  TERMINATOR,
} from "./snapshot-file.mjs";
import { shellCommand } from "./style.mjs";

// The repository's **deletion record** — the root-level `objects.deleted-<n>.tsv`
// files of the stored format (guide/format.md, ADR-0090). The record is a
// tombstone, not a ledger: its one job is to tell a reader that an absence is
// *deliberate* — `verify` partitions missing objects into expected vs
// unexplained, `restore` skips a recorded hash gracefully instead of failing,
// and `backup`/`cleanup` subtract recorded hashes from their
// baselines/interlocks. Its `#deleted` rows carry hash/size/instant/user@machine
// in the snapshot's five columns (ADR-0102) and **no paths**: every reader
// already has the path in front of it (it reached the record through a
// snapshot), so after "this was deliberate" the useful facts are who and when.
// When and who live in the rows, not the filename, because compaction (below)
// destroys filenames.
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

const DELETED = "#deleted";

/**
 * One `#deleted` row: what was deleted, how big it was (the preflight HEAD's
 * ContentLength), when (full UTC instant), and by whom (`user@machine`) — in
 * the columns a snapshot's `-` row puts its hash, size, time and path.
 * @typedef {Object} DeletionRow
 * @property {string} hash - The deleted object's SHA-256
 * @property {number} size - The object's stored size in bytes
 * @property {string} instant - When it was deleted, e.g. `2026-08-22T11:04:55.120Z`
 * @property {string} by - Who deleted it, `user@machine`
 */

/**
 * The record file's body (ADR-0102): the heading and the rows every s3cab file
 * opens with, one `#deleted` row per object, and the closing `.` (ADR-0106)
 * — no finish instant, since each row has its own. Rows sort by instant then
 * hash, so a compacted file reads chronologically.
 * @param {DeletionRow[]} rows
 * @returns {string}
 */
export function formatDeletionRecord(rows) {
  const body = [...rows]
    .sort(
      (a, b) =>
        a.instant.localeCompare(b.instant) || a.hash.localeCompare(b.hash),
    )
    .map(({ hash, size, instant, by }) =>
      formatLine(DELETED, hash, size, instant, showControlChars(by)),
    );
  return HEADING + openingRows() + body.join("") + `${TERMINATOR}\n`;
}

/**
 * Parse one record file (ADR-0101): its well-formed `#deleted` rows, and why
 * the file can't be trusted whole, if it can't. The file is invalid for any
 * fault {@link parseS3cabFile} finds, or when a row was refused: a reader
 * can't know what it lost. A malformed row is refused — its object counts as
 * not deleted, the safe direction, since a damaged record must never make
 * missing content look intentional. Every other `@` or `#` row is skipped
 * (ADR-0103).
 * @param {AsyncIterable<Uint8Array>} input - A record file's bytes
 * @returns {Promise<{ rows: DeletionRow[], invalid?: string }>} `invalid` is the reason, for a file that isn't valid
 */
export async function parseDeletionRecord(input) {
  /** @type {DeletionRow[]} */
  const rows = [];
  /** @type {string | undefined} */
  let malformed;
  const fault = await parseS3cabFile(
    input,
    ([type, hash, size, instant, by], line) => {
      if (type !== DELETED) {
        return;
      }
      if (
        /^[0-9a-f]{64}$/.test(hash) &&
        /^[0-9]+$/.test(size) &&
        isInstant(instant)
      ) {
        rows.push({ hash, size: Number(size), instant, by });
      } else {
        malformed ??= `a #deleted row is malformed: ${line}`;
      }
    },
  );
  return { rows, invalid: fault ?? malformed };
}

/**
 * A record file's bytes, or `undefined` once a compaction has absorbed it.
 * Not `getText`: its decoding turns bytes that aren't UTF-8 into U+FFFD, and
 * the reader must see them (ADR-0101).
 * @param {string} uri
 * @returns {Promise<AsyncIterable<Uint8Array> | undefined>}
 */
async function getRecord(uri) {
  try {
    return await getStream(uri);
  } catch (error) {
    if (isObjectNotFound(error)) {
      return undefined;
    }
    throw error;
  }
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
      `untouched.\n\n` +
      `Check what is writing those keys, then re-run:\n` +
      `  ${shellCommand(`aws s3 ls s3://${bucket}/`)}`,
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
 * expected/unexplained partition, `restore`'s graceful skip, the
 * `backup`/`status`/`cleanup` subtractions, and `forget`'s preview. A repository that never ran `delete` (the
 * common case) costs one LIST returning nothing. A hash recorded twice
 * (re-deleted after a re-backup) keeps the newest row's instant — compared on
 * the rows themselves, since a compacted file holds rows from many runs.
 *
 * `invalid` names each record file that isn't valid (ADR-0101): its
 * well-formed rows still count, but the record as a whole can't be trusted to
 * be complete, so `backup` won't let a baseline vouch for what's stored and
 * `cleanup` won't compact.
 * @param {string} bucket - The repository's S3 bucket
 * @returns {Promise<{ deleted: Map<string, RecordedDeletion>, invalid: InvalidRecord[] }>} hash → its recorded deletion, and the files that aren't valid
 */
export async function readDeletionRecords(bucket) {
  /** @type {Map<string, RecordedDeletion>} */
  const deleted = new Map();
  /** @type {InvalidRecord[]} */
  const invalid = [];
  for (const { uri } of await listDeletionRecordFiles(bucket)) {
    const body = await getRecord(uri);
    if (body === undefined) {
      // A compaction absorbed it after the LIST, into a merge the LIST never
      // saw, so its rows are missing here. Invalid, so no baseline vouches for
      // a hash it may have listed; restore reads only `deleted`, where a
      // missing row reads as damage, the safe direction.
      invalid.push({
        uri,
        reason: "it was removed while this run read the record",
        vanished: true,
      });
      continue;
    }
    const record = await parseDeletionRecord(body);
    if (record.invalid) {
      invalid.push({ uri, reason: record.invalid });
    }
    for (const { hash, instant } of record.rows) {
      const known = deleted.get(hash);
      // UTC instants compare chronologically as strings.
      if (!known || known.deletedOn < instant) {
        deleted.set(hash, { deletedOn: instant });
      }
    }
  }
  return { deleted, invalid };
}

/**
 * A deletion record file that isn't valid, and why. `vanished`: listed, then
 * gone by the read, so nothing in it is damaged.
 * @typedef {{ uri: string, reason: string, vanished?: boolean }} InvalidRecord
 */

/**
 * Compact the deletion record — `cleanup`'s half of the format (ADR-0090):
 * union every row across every record file, drop rows whose hash no snapshot
 * anywhere references, write the merge to a *fresh* index, then delete the
 * absorbed files. The steady state after any cleanup is a single file.
 *
 * **Trimming is safe** because every consumer reaches the record *through a
 * snapshot that references the hash* — verify computes referenced − stored,
 * restore is reading a snapshot when it hits the absence, cleanup subtracts
 * from its missing-object interlock, backup trusts a baseline only while
 * it still exists remotely byte-identical, which makes the baseline itself a
 * live reference, and status reads the latest remote snapshot, live by
 * definition. So "no snapshot references H" ⟹ nothing can ever ask about
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
 * @returns {Promise<{ files: number, rows: number, trimmed: number }>} What
 *   compaction did: record `files` absorbed, `rows` kept, `trimmed` rows
 *   dropped. `files: 0` means the record was already compact (or absent).
 */
export async function compactDeletionRecords(bucket, referenced) {
  const files = await listDeletionRecordFiles(bucket);
  /** @type {Map<string, DeletionRow>} identical rows collapse (a crashed merge) */
  const rows = new Map();
  let total = 0;
  /** @type {{ index: number, uri: string }[]} */
  const absorbed = [];
  for (const file of files) {
    const body = await getRecord(file.uri);
    if (body === undefined) {
      continue; // vanished since the LIST (a concurrent compaction absorbed it)
    }
    const record = await parseDeletionRecord(body);
    // The merge keeps only the rows it parsed, then deletes the original, so a
    // refused row would be lost for good (ADR-0101). `cleanup` refuses before
    // this; this read is later, so it checks again.
    if (record.invalid) {
      throw new Error(
        `Not compacting: ${file.uri} isn't valid (${record.invalid})`,
      );
    }
    absorbed.push(file);
    for (const row of record.rows) {
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
    await writeDeletionRecord(bucket, formatDeletionRecord(kept));
  }
  for (const { uri } of absorbed) {
    await deleteObject(uri);
  }
  return { files: absorbed.length, rows: kept.length, trimmed };
}
