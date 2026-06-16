import { createHash } from "node:crypto";
import {
  appendFileSync,
  createWriteStream,
  mkdirSync,
  readFileSync,
} from "node:fs";
import { rename, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createZstdDecompress } from "node:zlib";
import { isENOENT } from "./error.mjs";
import { assertPathSegment, s3cabDir } from "./home.mjs";
import { createS3ReadStream, listObjects, putFile } from "./s3.mjs";
import { isNamespace } from "./sets.mjs";
import {
  parseSnapshotStream,
  readSnapshot,
  snapshotNames,
} from "./snapshot-file.mjs";

/** @import { SnapshotLookup } from "./snapshot-file.mjs" */

// The remote half of an s3cab repository's fixed layout (specs/backup.md): a
// set's manifests live under `snapshots/<namespace>/<name>.tsv.zst`, where the
// namespace is the set's pinned `user@machine/set` identity. The other half is
// the content-addressed `objects/<sha256>` store (owned by objects.mjs/
// upload.mjs). This module owns the `snapshots/` layout and the operations over
// it that the backup engine composes; s3.mjs stays the generic SDK boundary
// (so it never learns the layout, the same way objects.mjs holds OBJECTS_PREFIX).

const SNAPSHOTS_PREFIX = "snapshots/";

/**
 * The S3 key prefix holding one set's remote manifests: `snapshots/<namespace>/`.
 * @param {string} namespace - The set's pinned `user@machine/set` identity
 * @returns {string}
 */
export const remoteSnapshotsPrefix = (namespace) =>
  `${SNAPSHOTS_PREFIX}${namespace}/`;

/**
 * List a set's remote snapshot names (newest first) — the manifests stored
 * under `snapshots/<namespace>/` in the bucket. The remote twin of
 * `listSnapshotNames`: it strips each manifest key down to its bare file name
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
    // Only real manifest objects, so a stray non-manifest key (a console-made
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
 * The latest remote snapshot name for a set, or undefined when it has none yet.
 * The manifest the `backup`/`status` diff starts from (specs/backup.md "How
 * `backup` computes the upload set", step 1).
 * @param {string} bucket - The repository's S3 bucket
 * @param {string} namespace - The set's pinned `user@machine/set` identity
 * @returns {Promise<string | undefined>}
 */
export async function latestRemoteSnapshot(bucket, namespace) {
  const [latest] = await listRemoteSnapshots(bucket, namespace);
  return latest;
}

/**
 * Read a set's remote manifest by name into a lookup, straight from S3 — the
 * `.tsv.zst` object is streamed through zstd and parsed in flight, no temp file
 * (a remote manifest is byte-identical to its local form, specs/backup.md). The
 * `backup`/`status` diff fetches the latest already-backed-up snapshot this
 * way; `restore` will read its chosen one the same way.
 *
 * Callers must have loaded the set's env (`loadEnv({ set })`) first, so the S3
 * client picks up the right bucket region/credentials/endpoint.
 * @param {string} bucket - The repository's S3 bucket
 * @param {string} namespace - The set's pinned `user@machine/set` identity
 * @param {string} name - Snapshot name without extension, e.g. `2026-06-12T0915`
 * @returns {Promise<SnapshotLookup>}
 */
export async function readRemoteSnapshot(bucket, namespace, name) {
  const uri = `s3://${bucket}/${remoteSnapshotsPrefix(namespace)}${name}.tsv.zst`;
  const input = createS3ReadStream(uri).pipe(createZstdDecompress());
  return parseSnapshotStream(input);
}

/**
 * Download one content-addressed object to a local path, verifying integrity.
 * The remote twin of `putFile` for the object store: stream `objects/<hash>`
 * while hashing it, assert the SHA-256 equals `hash` (the key *is* the content
 * hash, so a mismatch means the stored object is corrupt or wrong — silent data
 * loss is exactly what design #1 guards against), then atomically rename into
 * place. Bytes land in a sibling temp file first, so a crash or a failed
 * integrity check never leaves a half-written or unverified file at `destPath`.
 *
 * The caller owns *where* files go: `destPath`'s parent directory must already
 * exist (the temp file is a sibling, and the rename needs it), and setting the
 * restored mtime is the restore loop's job (it places objects, this fetches
 * their bytes). The `restore` command composes this.
 *
 * Callers must have loaded the set's env (`loadEnv({ set })`) first, so the S3
 * client picks up the right bucket region/credentials/endpoint.
 * @param {string} bucket - The repository's S3 bucket
 * @param {string} hash - The object's SHA-256, its key under `objects/`
 * @param {string} destPath - Where to write the verified object (parent must exist)
 * @returns {Promise<void>}
 */
export async function downloadObject(bucket, hash, destPath) {
  const uri = `s3://${bucket}/objects/${hash}`;
  const tmpPath = join(dirname(destPath), `.${basename(destPath)}.s3cab-tmp`);

  const hasher = createHash("sha256");
  const tap = new Transform({
    transform(chunk, _encoding, callback) {
      hasher.update(chunk);
      callback(null, chunk);
    },
  });

  try {
    await pipeline(createS3ReadStream(uri), tap, createWriteStream(tmpPath));
    const got = hasher.digest("hex");
    if (got !== hash) {
      throw new Error(
        `Integrity check failed for ${uri}: its content hashes to ${got}, ` +
          `not ${hash}. The stored object is corrupt or mismatched.`,
      );
    }
    await rename(tmpPath, destPath);
  } catch (error) {
    // Never leave the partial/unverified temp file behind (best-effort).
    await unlink(tmpPath).catch(() => {});
    throw error;
  }
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
 * @param {SnapshotLookup} target - The snapshot being backed up
 * @param {SnapshotLookup} remote - The latest remote snapshot (empty for a first backup)
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
 * The per-bucket objects cache file, `~/.s3cab/objects.<bucket>` — a local
 * hash-per-line list of objects already known to exist under the bucket's
 * `objects/`, in exactly the format `s3cab objects -f` writes (it *is* that
 * command's output put to work — composability, specs/backup.md). Sits beside
 * the per-bucket auth file `env.<bucket>` (auth.mjs). The bucket name is
 * interpolated into the filename, so it is guarded as a single path segment —
 * the same `assertPathSegment` guard `bucketEnvPath` uses.
 * @param {string} bucket
 * @returns {string}
 */
export const objectsCachePath = (bucket) =>
  join(s3cabDir(), `objects.${assertPathSegment(bucket, "bucket name")}`);

/**
 * Read the per-bucket objects cache into a set of hashes — the objects a prior
 * backup recorded as already present under `objects/`, so the next backup can
 * skip them without a per-object existence check (specs/backup.md, "How
 * `backup` computes the upload set", step 3). A missing or empty cache yields an
 * empty set: every candidate then falls through to the conditional-PUT safety
 * net, which is safe by design — a hash *missing* from the cache costs at most
 * one redundant no-op PUT, never a skipped upload (the staleness asymmetry the
 * design leans on).
 * @param {string} bucket
 * @returns {Set<string>} Hashes known to be in the bucket's object store
 */
export function readObjectsCache(bucket) {
  let text;
  try {
    text = readFileSync(objectsCachePath(bucket), "utf8");
  } catch (error) {
    if (isENOENT(error)) return new Set();
    throw error;
  }
  return new Set(
    text
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean),
  );
}

/**
 * Append hashes to the per-bucket objects cache, creating it (and `~/.s3cab`)
 * if absent — every object `backup` uploads is recorded here so a later backup
 * skips it (specs/backup.md step 3). Append-only and newline-terminated,
 * matching the `objects -f` format; duplicates are harmless (readObjectsCache
 * dedups via a Set), so this never has to read-modify-write.
 * @param {string} bucket
 * @param {Iterable<string>} hashes
 */
export function appendObjectsCache(bucket, hashes) {
  const text = [...hashes].map((hash) => hash + "\n").join("");
  if (!text) return;
  const path = objectsCachePath(bucket);
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, text);
}

/**
 * Upload a local snapshot to the bucket: every object it references that isn't
 * already stored, then the manifest **last** — the objects-first/manifest-last
 * invariant that makes a manifest's mere presence proof its objects exist
 * (specs/backup.md). The lower-level uploader `backup` composes after taking a
 * snapshot; it never hashes (the manifest already carries every hash) and never
 * walks the filesystem.
 *
 * The upload set is `uploadCandidates` (target − the latest remote manifest)
 * minus the per-bucket objects cache (unless `skipCache`), with the conditional
 * PUT (`noClobber`) as the safety net for anything the cache and latest
 * manifest both missed — it silently no-ops objects already present. The
 * manifest is uploaded no-clobber too, but here a name that already exists
 * remotely is an **error**, never an overwrite (manifests are immutable,
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
  const target = await readSnapshot(snapshotDir, name);

  const remoteName = await latestRemoteSnapshot(bucket, namespace);
  const remote = remoteName
    ? await readRemoteSnapshot(bucket, namespace, remoteName)
    : new Map();

  let candidates = uploadCandidates(target, remote);
  if (!skipCache) {
    const cached = readObjectsCache(bucket);
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
    const didUpload = await putFile(path, `s3://${bucket}/objects/${hash}`, {
      noClobber: true,
    });
    if (didUpload) uploaded++;
    present.push(hash); // exists now (uploaded, or the PUT found it) → cache it
  }
  // Record every object now known present so a later backup skips it. Done
  // before the manifest: even if the manifest PUT then fails, the cache stays
  // correct (its entries really do exist) — the staleness asymmetry only
  // forbids the reverse (cached but absent).
  appendObjectsCache(bucket, present);

  // The manifest, last. No-clobber, and a duplicate remote name is an error.
  const manifestKey = `${remoteSnapshotsPrefix(namespace)}${name}.tsv.zst`;
  const manifestPath = join(snapshotDir, `${name}.tsv.zst`);
  const wrote = await putFile(manifestPath, `s3://${bucket}/${manifestKey}`, {
    noClobber: true,
  });
  if (!wrote) {
    throw new Error(
      `Snapshot '${name}' is already backed up (s3://${bucket}/${manifestKey}). ` +
        `Manifests are immutable and never overwritten (specs/backup.md).`,
    );
  }

  return { name, candidates: candidates.size, uploaded };
}
