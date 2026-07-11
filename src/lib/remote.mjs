import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { compose } from "node:stream";
import { createZstdDecompress } from "node:zlib";
import { writeFileAtomic } from "./atomic-file.mjs";
import { deleteObject, getStream, listObjects } from "./s3.mjs";
import { parseSnapshotStream, snapshotNames } from "./snapshot-file.mjs";
import { isCorruptSnapshotError } from "./verify.mjs";

/** @import { SnapshotEntries, Snapshot } from "./snapshot-file.mjs" */
/** @import { ReferencedResult } from "./verify.mjs" */

// The remote half of an s3cab repository's fixed layout (docs/design/backup.md): a
// set's snapshots live under `snapshots/<set>/<name>.tsv.zst`, keyed by the set's
// name — its whole identity (ADR-0024). The other half is the content-addressed
// `objects/<sha256>` store, owned by objects.mjs. This module owns the
// `snapshots/` layout — the store's read/manage side (list, read, download,
// delete, the referenced-union). The upload engine that composes both halves is
// upload.mjs, which imports this module's prefix so the layout stays spelled in
// one place; s3.mjs stays the generic SDK boundary (so it never learns the
// layout, the same way objects.mjs owns OBJECTS_PREFIX for its half). The set
// name is canonical `[a-z0-9-]+` (validateSetName), so it is a safe key segment
// with no escaping.

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
 * this never touches `objects/`. Composes the
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
 * Read a set's latest remote snapshot into a lookup for diffing — where
 * `status`'s "what would a backup upload" diff starts (docs/design/backup.md).
 * Lists the set's remote snapshots, reads the newest, and returns its entries; a
 * set with no remote snapshot yet (before its first backup) yields an **empty
 * lookup**, so every target hash becomes a candidate.
 *
 * Returns just the lookup the diff needs, not the whole `Snapshot`: the
 * empty-when-none rule and the `.entries` extraction live here once. `status`
 * uses it for its read-only remote comparison; `backup` itself diffs against the
 * **local** previous snapshot (single-owner model — see upload.mjs), not
 * this. `restore`, which also needs the `#DIR` headers, calls `readRemoteSnapshot`
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
  const body = await getStream(uri);
  // `compose` (not `body.pipe(decompress)`): the composed stream propagates a
  // body or decompress error to the reader in `parseSnapshotStream`, where a
  // raw `.pipe` would drop it and stall on a truncated download.
  return parseSnapshotStream(compose(body, createZstdDecompress()));
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
 * **per path** (a Set — every distinct size a snapshot row records for that path,
 * normally one), so a hash whose paths disagree — or a torn path recorded at two
 * sizes across snapshots — leaves `verifySet` to flag the exact file(s) against
 * storage, with no recorded size able to hide.
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
        ref = { sizes: new Set(), snapshots: new Set() };
        entry.paths.set(path, ref);
      }
      ref.sizes.add(size);
      ref.snapshots.add(name);
    }
  }

  return { referenced, snapshotsChecked, unreadable };
}

/**
 * Pull a set's remote snapshot files down into `snapshotDir` — the
 * inherit-time metadata sync
 * ([ADR-0027](../../docs/adr/0027-compare-local-only-adoption-syncs-manifests.md)).
 * Lists `snapshots/<set>/` and streams each `.tsv.zst` **verbatim** to a local
 * file (atomically, via `writeFileAtomic`), touching **no** `objects/`. A
 * remote snapshot file is byte-identical to its local form
 * ([ADR-0004](../../docs/adr/0004-tsv-snapshot-manifests.md)), so a raw copy is
 * correct and avoids needless decompress-then-recompress.
 *
 * This is what lets `compare`/`list`/`restore` stay local-only: `sets --inherit`
 * calls it so a fresh machine lands with full local history, instead of growing a
 * remote-reading variant of every browse command (ADR-0027). It streams
 * (bounded memory) and writes each file atomically, so a mid-pull failure leaves
 * no partial snapshot file behind — only fewer of them, in a fresh set the user can
 * delete and re-inherit.
 * @param {string} bucket - The repository's S3 bucket
 * @param {string} set - The set's name (its whole identity, ADR-0024)
 * @param {string} snapshotDir - The set's local snapshots dir to write into
 * @returns {Promise<number>} How many snapshot files were pulled
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
    await writeFileAtomic(destPath, await getStream(uri));
  }
  return names.length;
}
