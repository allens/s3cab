import { createWriteStream } from "node:fs";
import { mkdir, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { createZstdDecompress } from "node:zlib";
import { knownObjects, putObject, recordObjects } from "./objects.mjs";
import {
  createS3ReadStream,
  deleteObject,
  listObjects,
  putFile,
} from "./s3.mjs";
import {
  parseSnapshotStream,
  readSnapshot,
  snapshotNames,
} from "./snapshot-file.mjs";
import { isCorruptSnapshotError } from "./verify.mjs";

/** @import { SnapshotEntries, Snapshot } from "./snapshot-file.mjs" */
/** @import { ReferencedResult } from "./verify.mjs" */

// The remote half of an s3cab repository's fixed layout (docs/design/backup.md): a
// set's snapshots live under `snapshots/<set>/<name>.tsv.zst`, keyed by the set's
// name — its whole identity (ADR-0024). The other half is the content-addressed
// `objects/<sha256>` store, owned by objects.mjs. This module owns the
// `snapshots/` layout and the backup engine that composes both halves; s3.mjs
// stays the generic SDK boundary (so it never learns the layout, the same way
// objects.mjs owns OBJECTS_PREFIX for its half). The set name is canonical
// `[a-z0-9-]+` (validateSetName), so it is a safe key segment with no escaping.

const SNAPSHOTS_PREFIX = "snapshots/";

/**
 * The S3 key prefix holding one set's remote snapshots: `snapshots/<set>/`.
 * @param {string} set - The set's name (its whole identity, ADR-0024)
 * @returns {string}
 */
export const remoteSnapshotsPrefix = (set) => `${SNAPSHOTS_PREFIX}${set}/`;

/**
 * List a set's remote snapshot names (newest first) — the snapshots stored
 * under `snapshots/<set>/` in the bucket. The remote twin of
 * `listSnapshotNames`: it strips each snapshot key down to its bare file name
 * and runs the lot through `snapshotNames`, so a remote and a local listing
 * sort and filter identically. Returns `[]` for a set with no remote snapshots
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
 * Delete one of a set's remote snapshots — `snapshots/<set>/<name>.tsv.zst` — the
 * remote half of the `delete` retention primitive (docs/design/backup.md). It
 * removes **only** the snapshot object; the content it referenced stays under
 * `objects/` (reclaiming what nothing references any more is `cleanup`'s job), so
 * this never touches `objects/` and the objects cache stays true. Composes the
 * generic `deleteObject` over this module's key layout, so callers never spell
 * the key. On a versioned bucket `DeleteObject` writes a delete marker (soft
 * delete) rather than destroying history — the ransomware-safety model (ADR-0033).
 * @param {string} bucket - The repository's S3 bucket
 * @param {string} set - The set's name (its whole identity, ADR-0024)
 * @param {string} name - Snapshot name without extension, e.g. `2026-06-12T0915`
 * @returns {Promise<void>}
 */
export async function deleteRemoteSnapshot(bucket, set, name) {
  const uri = `s3://${bucket}/${remoteSnapshotsPrefix(set)}${name}.tsv.zst`;
  await deleteObject(uri);
}

/**
 * Read a set's latest remote snapshot into a lookup for diffing — where the
 * `backup`/`status` upload diff starts (docs/design/backup.md "How `backup` computes
 * the upload set", step 1). Lists the set's remote snapshots, reads the newest,
 * and returns its entries; a set with no remote snapshot yet (before its first
 * backup) yields an **empty lookup**, so every target hash becomes a candidate.
 *
 * Returns just the lookup the diff needs, not the whole `Snapshot`: the
 * empty-when-none rule and the `.entries` extraction then live here once instead
 * of being re-coded by each caller (`backup` and `status`, which must agree).
 * `restore`, which also needs the `#DIR` headers, calls `readRemoteSnapshot`
 * directly.
 * @param {string} bucket - The repository's S3 bucket
 * @param {string} set - The set's name (its whole identity, ADR-0024)
 * @returns {Promise<{ name: string | undefined, lookup: SnapshotEntries }>}
 *   `name` = the latest remote snapshot's name (undefined if never backed up);
 *   `lookup` = its entries (an empty Map for a first backup).
 */
export async function readLatestRemoteSnapshot(bucket, set) {
  const [name] = await listRemoteSnapshots(bucket, set);
  if (!name) {
    return { name: undefined, lookup: new Map() };
  }
  const snapshot = await readRemoteSnapshot(bucket, set, name);
  return { name, lookup: snapshot.entries };
}

/**
 * Read a set's remote snapshot by name, straight from S3 — the `.tsv.zst` object
 * is streamed through zstd and parsed in flight, no temp file (a remote snapshot file
 * is byte-identical to its local form, docs/design/backup.md). The `backup`/`status`
 * diff fetches the latest already-backed-up snapshot this way (taking `.entries`);
 * `restore` reads its chosen one the same way and uses the `#DIR` headers for
 * `--output` re-rooting — so this surfaces the whole `Snapshot`, not just
 * the lookup (a remote snapshot file is the one a recoverer finds alone).
 * @param {string} bucket - The repository's S3 bucket
 * @param {string} set - The set's name (its whole identity, ADR-0024)
 * @param {string} name - Snapshot name without extension, e.g. `2026-06-12T0915`
 * @returns {Promise<Snapshot>}
 */
export async function readRemoteSnapshot(bucket, set, name) {
  const uri = `s3://${bucket}/${remoteSnapshotsPrefix(set)}${name}.tsv.zst`;
  const input = createS3ReadStream(uri).pipe(createZstdDecompress());
  return parseSnapshotStream(input);
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
 * snapshot files with `zstdcat` + `cut`). The per-set grouping is what lets
 * `verify` report findings against the set they belong to.
 *
 * The `snapshots/` **LIST** is an ordinary request — a failure aborts. Reading
 * each snapshot body is where damage shows up: a decompress/parse failure
 * (`isCorruptSnapshotError`) is recorded as an **unreadable** finding under its
 * set and the run continues (dying on the first would hide the rest); any other
 * error — an operational S3/credential failure — is rethrown. Sizes are recorded
 * **per path** (first row seen wins for a given path), so a hash whose paths
 * disagree on size — a torn manifest — leaves `verifySet` to flag the exact
 * file(s) against storage, not an abstract conflict.
 *
 * The caller must invoke this **before** LISTing `objects/` (the ordering
 * invariant): in that order a backup finishing mid-run only adds unreferenced
 * objects (a benign orphan bump), where the reverse would report its
 * freshly-uploaded objects as missing (docs/design/backup.md).
 * @param {string} bucket - The repository's S3 bucket
 * @returns {Promise<Map<string, ReferencedResult>>} referenced enumeration per set name
 */
export async function referencedObjects(bucket) {
  // Group every snapshot key under `snapshots/` by its set — the path segment
  // after the prefix (`snapshots/<set>/<name>.tsv.zst`). The set name is a canonical
  // `[a-z0-9-]+` segment (ADR-0024), so this split is unambiguous.
  /** @type {Map<string, string[]>} */
  const filesBySet = new Map();
  for await (const { Key } of listObjects(
    `s3://${bucket}/${SNAPSHOTS_PREFIX}`,
  )) {
    if (!Key) {
      continue;
    }
    const rest = Key.slice(SNAPSHOTS_PREFIX.length);
    const slash = rest.indexOf("/");
    if (slash <= 0) {
      continue;
    } // the `snapshots/` folder marker, or a stray key
    const set = rest.slice(0, slash);
    const file = rest.slice(slash + 1);
    if (!file) {
      continue;
    } // a `snapshots/<set>/` folder marker
    let files = filesBySet.get(set);
    if (!files) {
      filesBySet.set(set, (files = []));
    }
    files.push(file);
  }

  /** @type {Map<string, ReferencedResult>} */
  const bySet = new Map();
  for (const [set, files] of filesBySet) {
    const names = snapshotNames(files); // valid snapshot names, newest first
    if (names.length === 0) {
      continue;
    } // a set folder with no real snapshots
    bySet.set(set, await readSetReferenced(bucket, set, names));
  }
  return bySet;
}

/**
 * Accumulate one set's referenced objects from its snapshot `names` — the
 * per-set inner loop of {@link referencedObjects}. An unreadable snapshot
 * (`isCorruptSnapshotError`) becomes a finding and the loop continues; any other
 * error is rethrown (aborts). Module-private: only `referencedObjects` calls it.
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
  let snapshotsChecked = 0;

  for (const name of names) {
    /** @type {Snapshot} */
    let snapshot;
    try {
      snapshot = await readRemoteSnapshot(bucket, set, name);
    } catch (error) {
      if (!isCorruptSnapshotError(error)) {
        throw error;
      }
      const reason = Error.isError(error) ? error.message : String(error);
      unreadable.push({ snapshot: name, reason });
      continue;
    }
    snapshotsChecked++;

    for (const [path, { hash, size }] of snapshot.entries) {
      let entry = referenced.get(hash);
      if (!entry) {
        entry = { paths: new Map() };
        referenced.set(hash, entry);
      }
      let ref = entry.paths.get(path);
      if (!ref) {
        ref = { size, snapshots: new Set() };
        entry.paths.set(path, ref);
      }
      ref.snapshots.add(name);
    }
  }

  return { referenced, snapshotsChecked, unreadable };
}

/**
 * Pull a set's remote snapshot manifests down into `snapshotDir` — the
 * adoption-time metadata sync
 * ([ADR-0027](../../docs/adr/0027-compare-local-only-adoption-syncs-manifests.md)).
 * Lists `snapshots/<set>/` and streams each `.tsv.zst` **verbatim** to a local
 * file (atomic temp + rename, like `getObject`), touching **no** `objects/`. A
 * remote manifest is byte-identical to its local form
 * ([ADR-0004](../../docs/adr/0004-tsv-snapshot-manifests.md)), so a raw copy is
 * correct and avoids needless decompress-then-recompress.
 *
 * This is what lets `compare`/`list`/`restore` stay local-only: `sets --inherit`
 * calls it so a fresh machine lands with full local history, instead of growing a
 * remote-reading variant of every browse command (ADR-0027). It streams
 * (bounded memory) and writes each file atomically, so a mid-pull failure leaves
 * no partial manifest behind — only fewer of them, in a fresh set the user can
 * delete and re-inherit.
 * @param {string} bucket - The repository's S3 bucket
 * @param {string} set - The set's name (its whole identity, ADR-0024)
 * @param {string} snapshotDir - The set's local snapshots dir to write into
 * @returns {Promise<number>} How many manifests were pulled
 */
export async function downloadRemoteSnapshots(bucket, set, snapshotDir) {
  const names = await listRemoteSnapshots(bucket, set);
  if (names.length === 0) {
    return 0;
  }

  await mkdir(snapshotDir, { recursive: true });
  const prefix = remoteSnapshotsPrefix(set);
  for (const name of names) {
    const uri = `s3://${bucket}/${prefix}${name}.tsv.zst`;
    const destPath = join(snapshotDir, `${name}.tsv.zst`);
    const tmpPath = join(snapshotDir, `.${name}.tsv.zst.s3cab-tmp`);
    try {
      await pipeline(createS3ReadStream(uri), createWriteStream(tmpPath));
      await rename(tmpPath, destPath);
    } catch (error) {
      // Never leave a partial temp file behind (best-effort).
      await unlink(tmpPath).catch(() => {});
      throw error;
    }
  }
  return names.length;
}

/**
 * The object hashes a backup would need to upload: those whose content
 * (SHA-256) is in the target snapshot but not in the latest already-backed-up
 * one. The pure set-difference the upload set starts from (docs/design/backup.md,
 * "How `backup` computes the upload set", step 2) — keyed on content, so a file
 * that merely moved or was renamed since the last backup is *not* re-uploaded
 * (design #1), and a hash under several paths counts once. For a set's first
 * backup, `remote` is empty and every hash is a candidate. The objects cache
 * and the conditional-PUT safety net (steps 3–4) narrow this further; this is
 * the diff alone.
 * @param {SnapshotEntries} target - The snapshot being backed up
 * @param {SnapshotEntries} remote - The latest remote snapshot (empty for a first backup)
 * @returns {Set<string>} Candidate object hashes to upload
 */
export function uploadCandidates(target, remote) {
  /** @type {Set<string>} */
  const have = new Set();
  for (const { hash } of remote.values()) {
    have.add(hash);
  }

  /** @type {Set<string>} */
  const candidates = new Set();
  for (const { hash } of target.values()) {
    if (!have.has(hash)) {
      candidates.add(hash);
    }
  }
  return candidates;
}

/**
 * Upload a local snapshot to the bucket: every object it references that isn't
 * already stored, then the snapshot **last** — the objects-first/snapshot-last
 * invariant that makes a snapshot's mere presence proof its objects exist
 * (docs/design/backup.md). The lower-level uploader `backup` composes after taking a
 * snapshot; it never hashes (the snapshot already carries every hash) and never
 * walks the filesystem.
 *
 * The upload set is `uploadCandidates` (target − the latest remote snapshot)
 * minus the per-bucket objects cache (unless `skipCache`), with the conditional
 * PUT (`noClobber`) as the safety net for anything the cache and latest
 * snapshot both missed — it silently no-ops objects already present. The
 * snapshot is uploaded no-clobber too, but here a name that already exists
 * remotely is an **error**, never an overwrite (snapshots are immutable,
 * docs/design/backup.md).
 * @param {object} args
 * @param {string} args.bucket - The repository's S3 bucket
 * @param {string} args.set - The set's name (its whole identity, ADR-0024)
 * @param {string} args.snapshotDir - Local dir holding the snapshot (`<name>.tsv.zst`)
 * @param {string} args.name - The snapshot name to upload, e.g. `2026-06-12T0915`
 * @param {boolean} [args.skipCache] - Skip the objects-cache lookup (still conditional-PUTs every candidate)
 * @returns {Promise<{ name: string, candidates: number, uploaded: number }>}
 *   `candidates` = objects considered for upload; `uploaded` = those actually
 *   transferred (the rest were no-ops the conditional PUT found already present).
 */
export async function uploadSnapshot({
  bucket,
  set,
  snapshotDir,
  name,
  skipCache = false,
}) {
  const { entries: target } = await readSnapshot(snapshotDir, name);

  const { lookup: remote } = await readLatestRemoteSnapshot(bucket, set);

  let candidates = uploadCandidates(target, remote);
  if (!skipCache) {
    const cached = knownObjects(bucket);
    candidates = new Set([...candidates].filter((hash) => !cached.has(hash)));
  }

  // A local path for each candidate hash (first path wins; identical content
  // under many names uploads once).
  /** @type {Map<string, string>} */
  const pathByHash = new Map();
  for (const [path, { hash }] of target) {
    if (candidates.has(hash) && !pathByHash.has(hash)) {
      pathByHash.set(hash, path);
    }
  }

  let uploaded = 0;
  /** @type {string[]} */
  const present = [];
  for (const hash of candidates) {
    const path = pathByHash.get(hash);
    if (!path) {
      continue;
    } // unreachable: every candidate came from `target`
    const didUpload = await putObject(bucket, hash, path);
    if (didUpload) {
      uploaded++;
    }
    present.push(hash); // exists now (uploaded, or the PUT found it) → cache it
  }
  // Record every object now known present so a later backup skips it. Done
  // before the snapshot: even if the snapshot PUT then fails, the cache stays
  // correct (its entries really do exist) — the staleness asymmetry only
  // forbids the reverse (cached but absent).
  recordObjects(bucket, present);

  // The snapshot, last. No-clobber, and a duplicate remote name is an error.
  const snapshotKey = `${remoteSnapshotsPrefix(set)}${name}.tsv.zst`;
  const snapshotPath = join(snapshotDir, `${name}.tsv.zst`);
  const wrote = await putFile(snapshotPath, `s3://${bucket}/${snapshotKey}`, {
    noClobber: true,
  });
  if (!wrote) {
    throw new Error(
      `Snapshot '${name}' is already backed up (s3://${bucket}/${snapshotKey}). ` +
        `Snapshots are immutable and never overwritten (docs/design/backup.md).`,
    );
  }

  return { name, candidates: candidates.size, uploaded };
}
