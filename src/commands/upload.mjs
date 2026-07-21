import assert from "node:assert";
import { statSync } from "node:fs";
import { loadSet } from "../lib/env.mjs";
import { MissingArgError, ParseArgsError } from "../lib/error.mjs";
import { objectKey, putObject } from "../lib/objects.mjs";
import { uploadDir, uploadSnapshot } from "../lib/upload.mjs";
import { prop } from "./prop.mjs";

/**
 * Get objects into a repository's content-addressed store — the plumbing counterpart
 * of the snapshot-driven `backup` porcelain (ADR-0044). One command, three granularities,
 * chosen by mutually-exclusive target flags (never a second positional, cli-design pass):
 *
 * - **Single object** — `upload <set> --file <path>` (or `upload --bucket <b> --file <path>`):
 *   hash the file, one conditional PUT into `objects/<sha256>`. No `LIST`, no baseline.
 *   The set form resolves the set's bucket *and* env layer (`loadSet`, ADR-0022); the
 *   `--bucket` form is the raw escape hatch — one object into a bucket that isn't one of
 *   your sets, on ambient / user-env credentials only (no set layer). `--force` overwrites
 *   an already-stored object (the repair hatch: s3cab trusts the hash on write and verifies
 *   only on read, so this is how a known-good copy replaces a corrupt/truncated one).
 *
 * - **A snapshot's objects** — `upload <set> --snapshot <name>`: upload every object the
 *   snapshot references, then the snapshot file **last** (the objects-first/snapshot-last
 *   invariant, owned here so `backup` merely composes). `--since <baseline>` skips objects
 *   already in that baseline snapshot — trusted only after `uploadSnapshot` confirms the
 *   baseline still exists remotely, else it LISTs instead (the baseline-trust check,
 *   proposals/bugs.md); with no `--since`, snapshot mode `LIST`s the store once.
 *   `upload` performs **no** snapshot lookup — not "latest" nor "previous"; resolving which
 *   snapshot to upload or diff against is `backup`'s (porcelain) job. `--force`/`--bucket` are
 *   rejected here (force must never touch the immutable snapshot file; a snapshot always needs a set).
 *
 * - **A folder's objects** — `upload <set> --dir <path>`: walk the subtree (applying the
 *   set's excludes), hash each file, conditional-PUT each object — **no snapshot written**.
 *   The "seed my priority folders before the initial backup" primitive (docs/design/backup.md):
 *   the objects land now and the first full `backup` dedups against them for free. Objects-only
 *   by design (writing a manifest is `snapshot`'s job), so the seeded objects are unreferenced
 *   until a backup names them — the safe orphan direction. Always needs a set (its excludes come
 *   from the set), so `--bucket`/`--force`/`--since` are rejected. The seeding loop lives in
 *   `uploadDir`; `upload` only validates and dispatches.
 *
 * (The snapshot-aware *hashing* skip — reusing a stored hash for a file unchanged since a
 * snapshot — is `snapshot`-time machinery via `prop`'s `lookup`, not `upload`'s concern; the
 * old `--if-modified-from` TODO here was resolved into the `--since` baseline above, ADR-0044.)
 *
 * @typedef {Object} FileUploadResult
 * @property {"file"} mode - Single-object upload
 * @property {string} hash - The file's SHA-256 (its content address)
 * @property {number} size - The file's size in bytes
 * @property {string} key - The object-store key it maps to (`objects/<sha256>`)
 * @property {boolean} uploaded - True when transferred; false when the object was already stored
 *
 * @typedef {Object} SnapshotUploadResult
 * @property {"snapshot"} mode - Whole-snapshot upload
 * @property {string} set - The set whose snapshot went up
 * @property {string} snapshot - The snapshot name that was uploaded
 * @property {number} candidates - Objects considered for upload (not in the baseline)
 * @property {number} uploaded - Those actually transferred (the rest were already stored)
 *
 * @typedef {Object} DirUploadResult
 * @property {"dir"} mode - Folder-seed upload (objects only, no snapshot)
 * @property {string} set - The set whose store was seeded
 * @property {string} dir - The folder that was walked and seeded
 * @property {number} candidates - Distinct objects walked
 * @property {number} uploaded - Those actually transferred (the rest were already stored)
 *
 * @typedef {FileUploadResult | SnapshotUploadResult | DirUploadResult} UploadResult
 *
 * @param {string} [setName] - The backup set to upload into (required unless `--bucket`
 *   is given; no sole-set default — plumbing names its target explicitly, ADR-0044 §2)
 * @param {object} [options]
 * @param {string} [options.file] - Upload this single file as one object
 * @param {string} [options.snapshot] - Upload this snapshot's objects, then its snapshot file
 * @param {string} [options.dir] - Seed the set's store from this folder (objects only, no snapshot)
 * @param {string} [options.bucket] - Raw bucket for a `--file` upload with no set (ambient creds)
 * @param {string} [options.since] - Baseline snapshot to skip against (snapshot mode only)
 * @param {boolean} [options.force] - Re-upload even if the object already exists (`--file` only)
 * @returns {Promise<UploadResult>}
 */
export async function upload(setName, options = {}) {
  const { file, snapshot: snapshotName, dir, bucket, since, force } = options;

  // ── Fail-fast validation (ADR-0044 §7, ADR-0011): flag conflicts before any
  // work. These are usage errors (ParseArgsError → exit 2, prints the synopsis),
  // matching how `auth`/`setup` reject conflicting/missing options. ──────────
  // Exactly one target: an explicit `<set>` xor the raw `--bucket` hatch. Unlike
  // the porcelain (`backup`, which defaults to the sole set), this plumbing never
  // guesses its target — explicitness is the contract (ADR-0044 §2, ADR-0023).
  if (bucket && setName) {
    throw new ParseArgsError(
      "Pass either a set or --bucket, not both — a set already carries its bucket.",
    );
  }
  if (!bucket && !setName) {
    throw new MissingArgError("set");
  }
  // The three modes are mutually exclusive (ADR-0044 §2). Without this, the
  // `if (file)` / `if (dir)` branches below would win in order and silently
  // ignore the others' flags — uploading the wrong thing rather than failing fast.
  if ([file, snapshotName, dir].filter(Boolean).length > 1) {
    throw new ParseArgsError(
      "Pass one of --file, --snapshot, or --dir — they are different upload modes.",
    );
  }
  if (bucket && !file) {
    throw new ParseArgsError(
      "--bucket uploads a single file into a raw bucket — add --file <path>.",
    );
  }
  if (force && !file) {
    throw new ParseArgsError("--force applies only to --file uploads.");
  }
  if (since && !snapshotName) {
    throw new ParseArgsError("--since applies only to --snapshot uploads.");
  }
  // A target flag is the whole point — no mode selected is nothing to do.
  // (After the `bucket && !file` check above, so `--bucket` alone keeps its more
  // specific "add --file" message.)
  if (!file && !snapshotName && !dir) {
    throw new ParseArgsError(
      "Specify what to upload: --file <path>, --snapshot <name>, or --dir <path>.",
    );
  }

  // ── Single-object mode ──────────────────────────────────────────────────
  if (file) {
    // Raw bucket → ambient/user-env credentials, no set layer. Otherwise the set
    // supplies the bucket and applies its env layer (loadSet, ADR-0022).
    const targetBucket = bucket ?? loadSet(setName).bucket;

    // prop() does the file validation (rejects non-regular files) and the
    // streaming SHA-256; reuse it rather than re-deriving either here (#6).
    const { hash, size } = await prop(file);
    const uploaded = await putObject(targetBucket, hash, file, { force });
    return { mode: "file", hash, size, key: objectKey(hash), uploaded };
  }

  // ── Folder-seed mode ──────────────────────────────────────────────────────
  if (dir) {
    // A folder that isn't a usable directory (a typo, an unplugged drive, an
    // unreadable path) is a usage error — fail fast naming it, not a raw
    // ENOENT/EACCES from the walk below. One stat, so any failure (missing,
    // unreadable, or vanished between check and use) routes into the guard.
    let isDir;
    try {
      isDir = statSync(dir).isDirectory();
    } catch {
      isDir = false;
    }
    if (!isDir) {
      throw new ParseArgsError(`--dir needs a folder that exists: ${dir}`);
    }
    // Always a set — the excludes that shape the seed come from it (no --bucket).
    const set = loadSet(setName);
    const { candidates, uploaded } = await uploadDir({
      bucket: set.bucket,
      dir,
      excludePath: set.excludePath,
    });
    return { mode: "dir", set: set.name, dir, candidates, uploaded };
  }

  // ── Snapshot mode ─────────────────────────────────────────────────────────
  // The only mode left: the fail-fast block rejected "none", and `--file`/`--dir`
  // returned. The assert pins that invariant (and narrows the type) — it can only
  // fire if a future edit weakens the guard above.
  assert(snapshotName, "upload: snapshot mode reached without a snapshot name");
  const set = loadSet(setName);
  // uploadSnapshot reads the target first, so a missing --snapshot fails fast
  // with a clear "Snapshot '<name>' not found" before any scan/upload (ADR-0044 §7).
  const { candidates, uploaded } = await uploadSnapshot({
    bucket: set.bucket,
    set: set.name,
    snapshotDir: set.snapshotsDir,
    name: snapshotName,
    since,
  });
  return {
    mode: "snapshot",
    set: set.name,
    snapshot: snapshotName,
    candidates,
    uploaded,
  };
}
