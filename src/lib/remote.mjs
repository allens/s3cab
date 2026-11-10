import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { writeFileAtomic } from "./atomic-file.mjs";
import {
  deleteObject,
  getBytes,
  getStream,
  isObjectNotFound,
  listObjects,
} from "./s3.mjs";
import {
  listSnapshotNames,
  parseCompressedSnapshotStream,
  snapshotFileName,
  snapshotNames,
} from "./snapshot-file.mjs";
import {
  addSnapshotReferences,
  isCorruptSnapshotError,
} from "./referenced.mjs";
import { parseSnapshotsKey } from "./set-marker.mjs";

/** @import { SnapshotEntries, Snapshot } from "./snapshot-file.mjs" */
/** @import { ReferencedResult } from "./referenced.mjs" */

// The remote half of an s3cab repository's fixed layout (docs/design/backup.md): a
// set's snapshots live under `snapshots/<set>/<name>.tsv.gz`, keyed by the set's
// name — its whole identity (ADR-0024). The other half is the content-addressed
// `objects/<sha256>` store, owned by objects.mjs. This module owns the
// `snapshots/` layout, bar each set's `<set>.info` marker (set-marker.mjs) —
// the store's read/manage side (list, read, download,
// delete, the referenced-union). The upload engine that composes both halves is
// upload.mjs, which addresses a snapshot through this module's
// `remoteSnapshotUri` so the layout stays spelled in one place; s3.mjs stays the
// generic SDK boundary (so it never learns the layout, the same way objects.mjs
// owns OBJECTS_PREFIX for its half). The set name is canonical `[a-z0-9-]+`
// (validateSetName), so it is a safe key segment with no escaping — and the
// URI parse below the seam is a plain string split (see s3.mjs's parseS3Uri),
// so even a future looser charset reaches the bucket verbatim rather than
// percent-encoded.

const SNAPSHOTS_PREFIX = "snapshots/";

/**
 * The S3 key prefix holding one set's remote snapshots: `snapshots/<set>/`.
 * Production callers address a whole snapshot with {@link remoteSnapshotUri}
 * rather than assembling keys; this stays exported for the listing loop and the
 * integration suites that assert on remote keys.
 * @param {string} set - The set's name (its whole identity, ADR-0024)
 * @returns {string}
 */
export const remoteSnapshotsPrefix = (set) => `${SNAPSHOTS_PREFIX}${set}/`;

/**
 * The `s3://bucket/snapshots/<set>/<name>.tsv.gz` URI of one remote snapshot —
 * this module's key layout composed with the snapshot writer's filename grammar
 * ({@link snapshotFileName}), so neither is spelled at a call site. The twin of
 * objects.mjs's `objectUri` for the `snapshots/` half; exported because upload.mjs
 * addresses the snapshot it PUTs.
 * @param {string} bucket - The repository's S3 bucket
 * @param {string} set - The set's name (its whole identity, ADR-0024)
 * @param {string} name - Snapshot name without extension, e.g. `20260612T0915`
 * @returns {string}
 */
export const remoteSnapshotUri = (bucket, set, name) =>
  `s3://${bucket}/${remoteSnapshotsPrefix(set)}${snapshotFileName(name)}`;

/**
 * List a set's remote snapshot names (newest first) — the snapshots stored
 * under `snapshots/<set>/` in the bucket. The remote twin of
 * `listSnapshotNames`: it strips the set's prefix from each key and runs the
 * lot through `snapshotNames`, so a remote and a local listing sort and filter
 * identically. Not a basename: the LIST is recursive, and a key in a folder
 * below the set's is not one of its snapshots, which `snapshotNames` can tell
 * only while the folder is still on it. Returns `[]` for a set with no remote snapshots
 * yet (e.g. before its first backup).
 * @param {string} bucket - The repository's S3 bucket
 * @param {string} set - The set's name (its whole identity, ADR-0024)
 * @returns {Promise<string[]>} Snapshot names, newest first
 */
export async function listRemoteSnapshots(bucket, set) {
  const prefix = remoteSnapshotsPrefix(set);
  const names = [];
  for await (const { Key } of listObjects(`s3://${bucket}/${prefix}`)) {
    if (Key) {
      names.push(Key.slice(prefix.length));
    }
  }
  return snapshotNames(names);
}

/**
 * Delete one of a set's remote snapshots — `snapshots/<set>/<name>.tsv.gz` — the
 * remote half of the `forget` retention primitive (docs/design/backup.md). It
 * removes **only** the snapshot object; the content it referenced stays under
 * `objects/` (reclaiming what nothing references any more is `cleanup`'s job), so
 * this never touches `objects/`. Composes the
 * generic `deleteObject` over this module's key layout, so callers never spell
 * the key. On a versioned bucket `DeleteObject` writes a delete marker (soft
 * delete) rather than destroying history — the ransomware-safety model (ADR-0033).
 * @param {string} bucket - The repository's S3 bucket
 * @param {string} set - The set's name (its whole identity, ADR-0024)
 * @param {string} name - Snapshot name without extension, e.g. `20260612T0915`
 * @returns {Promise<void>}
 */
export async function deleteRemoteSnapshot(bucket, set, name) {
  await deleteObject(remoteSnapshotUri(bucket, set, name));
}

/**
 * Read a set's latest remote snapshot into a lookup for diffing — where
 * `status`'s "what would a backup upload" diff starts (docs/design/backup.md).
 * Lists the set's remote snapshots, reads the newest, and returns its entries
 * with the listing; a set with no remote snapshot yet (before its first
 * backup) yields an **empty lookup**, so every target hash becomes a candidate.
 *
 * Returns the lookup the diff needs, not the whole `Snapshot`: the
 * empty-when-none rule and the `.entries` extraction live here once. The
 * listing and the newest one's bytes come back with it because `status`
 * answers two more questions of the same reads — which snapshot is the
 * bucket's latest, and whether the local latest is the bucket's copy byte for
 * byte (ADR-0084: a name alone can be another machine's). `backup` itself diffs
 * against the **local** previous snapshot (single-owner model — see upload.mjs),
 * not this. `restore`, which also needs the `@SET DIR` rows, calls
 * `readRemoteSnapshot` directly.
 * @param {string} bucket - The repository's S3 bucket
 * @param {string} set - The set's name (its whole identity, ADR-0024)
 * @returns {Promise<{ names: string[], lookup: SnapshotEntries, bytes?: Uint8Array }>}
 *   `names` = the set's remote snapshot names, newest first (empty if never
 *   backed up); `lookup` = the newest one's entries (an empty Map for a first
 *   backup); `bytes` = the newest one's file as stored.
 */
export async function readLatestRemoteSnapshot(bucket, set) {
  const names = await listRemoteSnapshots(bucket, set);
  const [name] = names;
  if (!name) {
    return { names, lookup: new Map() };
  }
  const bytes = await getBytes(remoteSnapshotUri(bucket, set, name));
  if (bytes === undefined) {
    throw new Error(
      `Snapshot '${set}/${name}' left the bucket while it was being read. Run the command again.`,
    );
  }
  const snapshot = await parseCompressedSnapshotStream(Readable.from([bytes]));
  return { names, lookup: snapshot.entries, bytes };
}

/**
 * Whether the remote copy of a snapshot is **byte-identical** to the local file
 * of the same name — `"identical"`, `"different"`, or `"absent"`. The identity
 * check both trust decisions rest on (ADR-0084): a snapshot *name* is
 * minute-resolution local wall clock, so two machines sharing a set can mint the
 * same name for different content — existence under the name proves nothing
 * about *whose* snapshot is up there. Bytes settle it exactly: a remote snapshot
 * file is byte-identical to its local form by design (ADR-0004,
 * `downloadRemoteSnapshots` relies on the same fact in the other direction), so
 * equality means "this very snapshot". Compared as bytes, not ETags — an ETag is
 * only a content hash for single-part uploads on real S3, and s3cab promises
 * S3-*compatible* stores (ADR-0002). Manifests are small (gzip-compressed TSV),
 * so buffering one is nothing.
 * @param {string} bucket - The repository's S3 bucket
 * @param {string} set - The set's name (its whole identity, ADR-0024)
 * @param {string} name - Snapshot name without extension, e.g. `20260612T0915`
 * @param {string} snapshotDir - Local dir holding the snapshot (`<name>.tsv.gz`)
 * @returns {Promise<"identical" | "different" | "absent">}
 */
export async function matchRemoteSnapshot(bucket, set, name, snapshotDir) {
  const remote = await getBytes(remoteSnapshotUri(bucket, set, name));
  if (remote === undefined) {
    return "absent";
  }
  // Read after the fetch: both callers hold a local file (a read baseline, a
  // just-PUT manifest), so a missing one is a real fault and may throw.
  const local = await readFile(join(snapshotDir, snapshotFileName(name)));
  return local.equals(remote) ? "identical" : "different";
}

/**
 * Read a set's remote snapshot by name, straight from S3 — the `.tsv.gz` object
 * is streamed through gunzip and parsed in flight, no temp file (a remote snapshot file
 * is byte-identical to its local form, docs/design/backup.md). `status`'s diff
 * fetches the latest already-backed-up snapshot this way (taking `.entries`);
 * `restore` reads its chosen one the same way and uses the `@SET DIR` rows for
 * `--output` re-rooting — so this surfaces the whole `Snapshot`, not just
 * the lookup (a remote snapshot file is the one a recoverer finds alone).
 * @param {string} bucket - The repository's S3 bucket
 * @param {string} set - The set's name (its whole identity, ADR-0024)
 * @param {string} name - Snapshot name without extension, e.g. `20260612T0915`
 * @returns {Promise<Snapshot>}
 */
export async function readRemoteSnapshot(bucket, set, name) {
  const body = await getStream(remoteSnapshotUri(bucket, set, name));
  // Terminal-sink pipeline (see parseCompressedSnapshotStream): a mid-download
  // body error rejects instead of stalling the parser, and the body is fully
  // consumed before teardown, so the live S3 request is never aborted (#171).
  return parseCompressedSnapshotStream(body);
}

/**
 * Enumerate a **bucket's** referenced objects, grouped by set — for each set
 * with snapshots under `snapshots/`, the union of object hashes across its
 * snapshots, each carrying every path that references it, that path's recorded
 * size and the snapshot(s) it appears in. `verify`'s first input (its other is
 * the bucket's stored objects). The operand is the **bucket**, symmetric with
 * `cleanup`
 * ([ADR-0042](../../docs/adr/0042-verify-bucket-operand.md)): one repository is
 * checked in one run under one credential. A lib function with no plumbing
 * command of its own (hand recovery already reads the hashes straight out of the
 * snapshot files with `gunzip -c` + `cut`). The per-set grouping is what lets
 * `verify` report findings against the set they belong to.
 *
 * The `snapshots/` **LIST** is an ordinary request — a failure aborts. Reading
 * each snapshot body is where damage shows up: a decompress/parse failure
 * (`isCorruptSnapshotError`) is recorded as an **unreadable** finding under its
 * set and the run continues (dying on the first would hide the rest); any other
 * error — an operational S3/credential failure — is rethrown. Sizes are recorded
 * **per path** (a Set — every distinct size a snapshot row records for that path,
 * normally one), so a hash whose paths disagree — or a torn path recorded at two
 * sizes across snapshots — leaves `verifySet` to flag the exact file(s) against
 * storage, with no recorded size able to hide.
 *
 * Any caller that will also LIST `objects/` must read this **first** (the
 * ordering invariant): in that order a backup finishing mid-run only adds
 * unreferenced objects (a benign orphan bump), where the reverse would report
 * its freshly-uploaded objects as missing (docs/design/backup.md). The
 * whole-bucket commands don't call this directly — `scanBucket`
 * (bucket-scan.mjs) does, and fixes that order in its body; it stays exported
 * for `forget`, whose unrestorable check needs the snapshot half alone.
 * @param {string} bucket - The repository's S3 bucket
 * @returns {Promise<Map<string, ReferencedResult>>} referenced enumeration per set name
 */
export async function referencedObjects(bucket) {
  const filesBySet = await listSnapshotFiles(bucket);
  return readReferencedObjects(bucket, filesBySet);
}

/**
 * A `snapshots/` listing: folder name → the files in it, each with the LIST's
 * `ETag` — the bytes' identity, which is what tells a snapshot republished
 * under a name a `forget` freed from the one the listing saw
 * ([ADR-0112](../../docs/adr/0112-bucket-locks.md) step 4) — or `undefined`
 * where the store lists none, which `readNewSnapshots` reads as changed. A set
 * whose `<set>.info` marker or folder is listed is present even with no files,
 * so a set whose snapshots are all gone is still a set to report on, not an
 * absence. A folder whose name isn't a set's (`isSetName`) is listed too, for
 * `cleanup` alone: a snapshot copied into `snapshots/photos_2025/` by hand
 * still references what it references, and nothing else reports on it.
 * @typedef {Map<string, Map<string, string | undefined>>} SnapshotListing
 */

/**
 * One LIST of `snapshots/`, grouped by folder. Markers and set folders are read
 * by set-marker.mjs's `parseSnapshotsKey`, so a stray `.info` — `Photos.info`,
 * `notes.old.info` — registers nothing; a folder under any other name is kept
 * as itself (`SnapshotListing`). Under a folder every key is kept, valid
 * snapshot name or not: the listing is what a later one is compared against
 * (`readNewSnapshots`), and a filter applied to both sides changes nothing.
 * @param {string} bucket - The repository's S3 bucket
 * @returns {Promise<SnapshotListing>}
 */
export async function listSnapshotFiles(bucket) {
  /** @type {SnapshotListing} */
  const filesBySet = new Map();
  for await (const { Key = "", ETag } of listObjects(
    `s3://${bucket}/${SNAPSHOTS_PREFIX}`,
  )) {
    const entry =
      parseSnapshotsKey(Key) ??
      /^snapshots\/(?<set>[^/]+)\/(?<file>.*)$/s.exec(Key)?.groups;
    if (!entry?.set) {
      continue;
    }
    // The set exists whether or not its folder has anything in it: its
    // marker, or the folder itself, registers it.
    const files = filesBySet.getOrInsertComputed(entry.set, () => new Map());
    if (entry.file) {
      files.set(entry.file, ETag);
    }
  }
  return filesBySet;
}

/**
 * Read the snapshots a `listSnapshotFiles` listing names, set by set — the
 * enumeration `referencedObjects` documents, from a listing already in hand.
 * A set the listing names with no snapshot to read is enumerated all the same,
 * with `snapshotsChecked` 0: `verify` reports it, rather than passing a set it
 * never looked at.
 * @param {string} bucket - The repository's S3 bucket
 * @param {SnapshotListing} filesBySet - The listing (`listSnapshotFiles`)
 * @returns {Promise<Map<string, ReferencedResult>>} referenced enumeration per set name
 */
export async function readReferencedObjects(bucket, filesBySet) {
  /** @type {Map<string, ReferencedResult>} */
  const bySet = new Map();
  for (const [set, files] of filesBySet) {
    const names = snapshotNames([...files.keys()]); // valid snapshot names, newest first
    bySet.set(set, await readSetReferenced(bucket, set, names));
  }
  return bySet;
}

/**
 * The snapshots that appeared since an earlier listing — a delete's top-up
 * ([ADR-0112](../../docs/adr/0112-bucket-locks.md)): a backup that finished
 * between a cleanup's scan and its delete lock published a snapshot the scan
 * never read, whose objects would otherwise be deleted as orphans. LISTs
 * `snapshots/` again and reads every key `known` lacks — or holds under a
 * different `ETag`: a `forget` and a backup in the same minute republish a
 * name the scan read with other bytes under it, and by key alone that
 * snapshot's objects would go. A key the store lists with no ETag, on either
 * side, is read again: with nothing to compare, the key alone would decide,
 * silently. Grouped by set like `referencedObjects`. A key that vanished
 * since is not here: it was forgotten, and its references with it.
 * @param {string} bucket - The repository's S3 bucket
 * @param {SnapshotListing} known - The earlier listing (`listSnapshotFiles`)
 * @returns {Promise<Map<string, ReferencedResult>>} the new snapshots' references, per set name
 */
export async function readNewSnapshots(bucket, known) {
  const current = await listSnapshotFiles(bucket);
  /** @type {SnapshotListing} */
  const added = new Map();
  for (const [set, files] of current) {
    const seen = known.get(set);
    const fresh = new Map(
      [...files].filter(
        ([file, etag]) => etag === undefined || seen?.get(file) !== etag,
      ),
    );
    if (fresh.size > 0) {
      added.set(set, fresh);
    }
  }
  return readReferencedObjects(bucket, added);
}

/**
 * Accumulate one set's referenced objects from its snapshot `names` — the
 * per-set inner loop of {@link referencedObjects}. Three ways a snapshot read can
 * fail, handled distinctly: a snapshot that vanished between the bucket LIST and
 * this read (`isObjectNotFound`) is silently skipped — it's genuinely gone (S3 is
 * strongly consistent), not unreadable, so a concurrent delete/cleanup on the
 * shared bucket mustn't abort the scan; a damaged snapshot
 * (`isCorruptSnapshotError`) becomes an `unreadable` finding and the loop
 * continues; any other error (network/auth) is rethrown (aborts). Module-private:
 * only `readReferencedObjects` calls it.
 * @param {string} bucket - The repository's S3 bucket
 * @param {string} set - The set's name (its whole identity, ADR-0024)
 * @param {string[]} names - The set's snapshot names, newest first
 * @returns {Promise<ReferencedResult>}
 */
async function readSetReferenced(bucket, set, names) {
  /** @type {ReferencedResult["referenced"]} */
  const referenced = new Map();
  /** @type {ReferencedResult["unreadable"]} */
  const unreadable = [];
  /** @type {ReferencedResult["invalid"]} */
  const invalid = [];
  /** @type {ReferencedResult["starts"]} */
  const starts = new Map();
  let snapshotsChecked = 0;

  for (const name of names) {
    /** @type {Snapshot} */
    let snapshot;
    try {
      snapshot = await readRemoteSnapshot(bucket, set, name);
    } catch (error) {
      if (isObjectNotFound(error)) {
        // Vanished between the bucket LIST and this read — a concurrent
        // delete/cleanup (s3cab is multi-machine, ADR-0013/0014) or an external
        // removal. S3 is strongly consistent, so it's genuinely gone: its
        // references no longer exist, so drop it rather than flag it unreadable
        // (it isn't) or abort. Under S3CAB_DEBUG leave a breadcrumb — this scan
        // feeds cleanup's GC, so a trail helps if deletions ever look wrong.
        if (process.env.S3CAB_DEBUG) {
          console.warn(
            `snapshot ${set}/${name} vanished during scan (concurrent delete?)`,
          );
        }
        continue;
      }
      if (!isCorruptSnapshotError(error)) {
        throw error;
      }
      const reason = Error.isError(error) ? error.message : String(error);
      unreadable.push({ snapshot: name, reason });
      continue;
    }
    snapshotsChecked++;
    addSnapshotReferences(referenced, name, snapshot.entries);
    starts.set(name, snapshot.instant);
    for (const [path, reason] of snapshot.refused) {
      invalid.push({ snapshot: name, path, reason });
    }
  }

  return { referenced, snapshotsChecked, unreadable, invalid, starts };
}

/**
 * Pull down the set's remote snapshot files that `snapshotDir` lacks — the
 * metadata sync behind `reattach` and `takeover`
 * ([ADR-0027](../../docs/adr/0027-compare-local-only-adoption-syncs-manifests.md)).
 * Lists `snapshots/<set>/` and streams each missing `.tsv.gz` **verbatim** to a
 * local file (atomically, via `writeFileAtomic`), touching **no** `objects/`. A
 * remote snapshot file is byte-identical to its local form
 * ([ADR-0004](../../docs/adr/0004-tsv-snapshot-manifests.md)), so a raw copy is
 * correct and avoids needless decompress-then-recompress, and a name already
 * here is already this file.
 *
 * This is what lets `compare`/`list`/`restore` stay local-only: a machine lands
 * with full local history, instead of growing a remote-reading variant of every
 * browse command (ADR-0027). It streams (bounded memory) and writes each file
 * atomically, so a mid-pull failure leaves no partial snapshot file behind —
 * only fewer of them, which the next refresh fetches.
 * @param {string} bucket - The repository's S3 bucket
 * @param {string} set - The set's name (its whole identity, ADR-0024)
 * @param {string} snapshotDir - The set's local snapshots dir to write into
 * @returns {Promise<number>} How many snapshot files were pulled
 */
export async function downloadRemoteSnapshots(bucket, set, snapshotDir) {
  const local = new Set(listSnapshotNames(snapshotDir));
  const remote = await listRemoteSnapshots(bucket, set);
  const names = remote.filter((name) => !local.has(name));
  if (names.length === 0) {
    return 0;
  }

  await mkdir(snapshotDir, { recursive: true });
  for (const name of names) {
    const uri = remoteSnapshotUri(bucket, set, name);
    const destPath = join(snapshotDir, snapshotFileName(name));
    await writeFileAtomic(destPath, await getStream(uri));
  }
  return names.length;
}
