import { join } from "node:path";
import { createZstdDecompress } from "node:zlib";
import { knownObjects, putObject, recordObjects } from "./objects.mjs";
import { createS3ReadStream, listObjects, putFile } from "./s3.mjs";
import { isNamespace } from "./sets.mjs";
import {
  parseSnapshotStream,
  readSnapshot,
  snapshotNames,
} from "./snapshot-file.mjs";

/** @import { SnapshotEntries, Snapshot } from "./snapshot-file.mjs" */

// The remote half of an s3cab repository's fixed layout (specs/backup.md): a
// set's snapshots live under `snapshots/<namespace>/<name>.tsv.zst`, where the
// namespace is the set's pinned `user@machine/set` identity. The other half is
// the content-addressed `objects/<sha256>` store, owned by objects.mjs. This
// module owns the `snapshots/` layout and the backup engine that composes both
// halves; s3.mjs stays the generic SDK boundary (so it never learns the layout,
// the same way objects.mjs owns OBJECTS_PREFIX for its half).

const SNAPSHOTS_PREFIX = "snapshots/";

/**
 * The S3 key prefix holding one set's remote snapshots: `snapshots/<namespace>/`.
 * @param {string} namespace - The set's pinned `user@machine/set` identity
 * @returns {string}
 */
export const remoteSnapshotsPrefix = (namespace) =>
  `${SNAPSHOTS_PREFIX}${namespace}/`;

/**
 * List a set's remote snapshot names (newest first) — the snapshots stored
 * under `snapshots/<namespace>/` in the bucket. The remote twin of
 * `listSnapshotNames`: it strips each snapshot key down to its bare file name
 * and runs the lot through `snapshotNames`, so a remote and a local listing
 * sort and filter identically. Returns `[]` for a set with no remote snapshots
 * yet (e.g. before its first backup).
 *
 * Callers must have loaded the set's env (`loadEnv({ set })`) first, so the S3
 * client picks up the right bucket region/credentials/endpoint.
 * @param {string} bucket - The repository's S3 bucket
 * @param {string} namespace - The set's pinned `user@machine/set` identity
 * @returns {Promise<string[]>} Snapshot names, newest first
 */
export async function listRemoteSnapshots(bucket, namespace) {
  const prefix = remoteSnapshotsPrefix(namespace);
  const names = [];
  for await (const { Key } of listObjects(`s3://${bucket}/${prefix}`)) {
    if (Key) names.push(Key.slice(prefix.length));
  }
  return snapshotNames(names);
}

/**
 * List the distinct backup-set namespaces present in a bucket — the
 * `user@machine/set` prefixes under `snapshots/`. The discovery aid behind
 * `setup --from` on a fresh machine, where the user won't recall the exact
 * pinned identity; also what an adoption's "namespace not found" error offers as
 * the available choices. Sorted, deduplicated.
 *
 * Callers must have loaded the bucket's env (`loadEnv({ bucket })`) first.
 * @param {string} bucket - The repository's S3 bucket
 * @returns {Promise<string[]>} Distinct namespaces, sorted
 */
export async function listRemoteNamespaces(bucket) {
  /** @type {Set<string>} */
  const namespaces = new Set();
  for await (const { Key } of listObjects(
    `s3://${bucket}/${SNAPSHOTS_PREFIX}`,
  )) {
    // Only real snapshot objects, so a stray non-snapshot key (a console-made
    // `snapshots/foo/` folder marker, say) can't surface as a bogus adoption
    // target. Key = snapshots/<user>@<machine>/<set>/<name>.tsv.zst — the
    // namespace is everything between the prefix and the final segment, and it
    // must match the canonical `user@machine/set` shape (a key at some other
    // depth would otherwise yield an invalid target `validateNamespace` rejects).
    if (!Key?.endsWith(".tsv.zst")) continue;
    const rest = Key.slice(SNAPSHOTS_PREFIX.length);
    const cut = rest.lastIndexOf("/");
    if (cut === -1) continue;
    const namespace = rest.slice(0, cut);
    if (isNamespace(namespace)) namespaces.add(namespace);
  }
  return [...namespaces].sort();
}

/**
 * Read a set's latest remote snapshot into a lookup for diffing — where the
 * `backup`/`status` upload diff starts (specs/backup.md "How `backup` computes
 * the upload set", step 1). Lists the set's remote snapshots, reads the newest,
 * and returns its entries; a set with no remote snapshot yet (before its first
 * backup) yields an **empty lookup**, so every target hash becomes a candidate.
 *
 * Returns just the lookup the diff needs, not the whole `Snapshot`: the
 * empty-when-none rule and the `.entries` extraction then live here once instead
 * of being re-coded by each caller (`backup` and `status`, which must agree).
 * `restore`, which also needs the `#DIR` headers, calls `readRemoteSnapshot`
 * directly.
 *
 * Callers must have loaded the set's env (`loadEnv({ set })`) first, so the S3
 * client picks up the right bucket region/credentials/endpoint.
 * @param {string} bucket - The repository's S3 bucket
 * @param {string} namespace - The set's pinned `user@machine/set` identity
 * @returns {Promise<{ name: string | undefined, lookup: SnapshotEntries }>}
 *   `name` = the latest remote snapshot's name (undefined if never backed up);
 *   `lookup` = its entries (an empty Map for a first backup).
 */
export async function readLatestRemoteSnapshot(bucket, namespace) {
  const [name] = await listRemoteSnapshots(bucket, namespace);
  if (!name) return { name: undefined, lookup: new Map() };
  const snapshot = await readRemoteSnapshot(bucket, namespace, name);
  return { name, lookup: snapshot.entries };
}

/**
 * Read a set's remote snapshot by name, straight from S3 — the `.tsv.zst` object
 * is streamed through zstd and parsed in flight, no temp file (a remote snapshot file
 * is byte-identical to its local form, specs/backup.md). The `backup`/`status`
 * diff fetches the latest already-backed-up snapshot this way (taking `.entries`);
 * `restore` reads its chosen one the same way and uses the `#DIR` headers for
 * `--output` re-rooting — so this surfaces the whole `Snapshot`, not just
 * the lookup (a remote snapshot file is the one a recoverer finds alone).
 *
 * Callers must have loaded the set's env (`loadEnv({ set })`) first, so the S3
 * client picks up the right bucket region/credentials/endpoint.
 * @param {string} bucket - The repository's S3 bucket
 * @param {string} namespace - The set's pinned `user@machine/set` identity
 * @param {string} name - Snapshot name without extension, e.g. `2026-06-12T0915`
 * @returns {Promise<Snapshot>}
 */
export async function readRemoteSnapshot(bucket, namespace, name) {
  const uri = `s3://${bucket}/${remoteSnapshotsPrefix(namespace)}${name}.tsv.zst`;
  const input = createS3ReadStream(uri).pipe(createZstdDecompress());
  return parseSnapshotStream(input);
}

/**
 * The object hashes a backup would need to upload: those whose content
 * (SHA-256) is in the target snapshot but not in the latest already-backed-up
 * one. The pure set-difference the upload set starts from (specs/backup.md,
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
  for (const { hash } of remote.values()) have.add(hash);

  /** @type {Set<string>} */
  const candidates = new Set();
  for (const { hash } of target.values()) {
    if (!have.has(hash)) candidates.add(hash);
  }
  return candidates;
}

/**
 * Upload a local snapshot to the bucket: every object it references that isn't
 * already stored, then the snapshot **last** — the objects-first/snapshot-last
 * invariant that makes a snapshot's mere presence proof its objects exist
 * (specs/backup.md). The lower-level uploader `backup` composes after taking a
 * snapshot; it never hashes (the snapshot already carries every hash) and never
 * walks the filesystem.
 *
 * The upload set is `uploadCandidates` (target − the latest remote snapshot)
 * minus the per-bucket objects cache (unless `skipCache`), with the conditional
 * PUT (`noClobber`) as the safety net for anything the cache and latest
 * snapshot both missed — it silently no-ops objects already present. The
 * snapshot is uploaded no-clobber too, but here a name that already exists
 * remotely is an **error**, never an overwrite (snapshots are immutable,
 * specs/backup.md).
 *
 * Callers must have loaded the set's env (`loadEnv({ set })`) first, so the S3
 * client picks up the right bucket region/credentials/endpoint.
 * @param {object} args
 * @param {string} args.bucket - The repository's S3 bucket
 * @param {string} args.namespace - The set's pinned `user@machine/set` identity
 * @param {string} args.snapshotDir - Local dir holding the snapshot (`<name>.tsv.zst`)
 * @param {string} args.name - The snapshot name to upload, e.g. `2026-06-12T0915`
 * @param {boolean} [args.skipCache] - Skip the objects-cache lookup (still conditional-PUTs every candidate)
 * @returns {Promise<{ name: string, candidates: number, uploaded: number }>}
 *   `candidates` = objects considered for upload; `uploaded` = those actually
 *   transferred (the rest were no-ops the conditional PUT found already present).
 */
export async function uploadSnapshot({
  bucket,
  namespace,
  snapshotDir,
  name,
  skipCache = false,
}) {
  const { entries: target } = await readSnapshot(snapshotDir, name);

  const { lookup: remote } = await readLatestRemoteSnapshot(bucket, namespace);

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
    if (!path) continue; // unreachable: every candidate came from `target`
    const didUpload = await putObject(bucket, hash, path);
    if (didUpload) uploaded++;
    present.push(hash); // exists now (uploaded, or the PUT found it) → cache it
  }
  // Record every object now known present so a later backup skips it. Done
  // before the snapshot: even if the snapshot PUT then fails, the cache stays
  // correct (its entries really do exist) — the staleness asymmetry only
  // forbids the reverse (cached but absent).
  recordObjects(bucket, present);

  // The snapshot, last. No-clobber, and a duplicate remote name is an error.
  const snapshotKey = `${remoteSnapshotsPrefix(namespace)}${name}.tsv.zst`;
  const snapshotPath = join(snapshotDir, `${name}.tsv.zst`);
  const wrote = await putFile(snapshotPath, `s3://${bucket}/${snapshotKey}`, {
    noClobber: true,
  });
  if (!wrote) {
    throw new Error(
      `Snapshot '${name}' is already backed up (s3://${bucket}/${snapshotKey}). ` +
        `Snapshots are immutable and never overwritten (specs/backup.md).`,
    );
  }

  return { name, candidates: candidates.size, uploaded };
}
