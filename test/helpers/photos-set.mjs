import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { bucket, filesAt, scale, sets, timeline } from "./story.mjs";
import { writeSnapshot } from "./write-snapshot.mjs";

/** @import { BackupResult } from "../../src/commands/backup.mjs" */
/** @import { RestoreResult } from "../../src/lib/restore.mjs" */

const CLI = fileURLToPath(new URL("../../src/s3cab.mjs", import.meta.url));

/**
 * A `photos` set over one folder of a temp home — `~/Pictures`, or the one
 * named — with a snapshot per entry of `snapshots` (name → files, paths
 * relative to the set's directory), and a way to run the CLI there. Paths are
 * written as the snapshot would hold them, so the report shortens them against
 * the home exactly as on a real machine.
 * @param {string} root
 * @param {Record<string, File[]>} snapshots
 * @param {string} [folder]
 */
export async function photosSet(root, snapshots, folder = "Pictures") {
  // Absolute, as `setup` writes it: the snapshot rows are absolute paths.
  const home = resolve(root, "home");
  const pictures = join(home, folder);
  const set = join(home, ".s3cab", "sets", "photos");
  mkdirSync(join(set, "snapshots"), { recursive: true });
  writeFileSync(join(set, "dirs.txt"), `${pictures}\n`);
  writeFileSync(join(set, "env"), "S3CAB_BUCKET=my-backups\n");
  for (const [name, files] of Object.entries(snapshots)) {
    await writeSnapshot(join(set, "snapshots"), name, files, pictures);
  }
  return {
    home,
    /** @param {...string} args */
    run: (...args) =>
      spawnSync(process.execPath, [CLI, ...args], {
        encoding: "utf8",
        // An exported S3CAB_HOME would beat HOME; undefined leaves it out.
        env: {
          ...process.env,
          HOME: home,
          USERPROFILE: home,
          S3CAB_HOME: undefined,
        },
      }),
  };
}

/**
 * A file of `size` bytes, its content fixed by `fill` — the same `fill` and
 * size is the same content, which is what makes a move or a duplicate.
 * @param {string} name
 * @param {string} fill
 * @param {number} size
 */
export const file = (name, fill, size) =>
  new File([new Uint8Array(size).fill(fill.charCodeAt(0))], name, {
    lastModified: Date.UTC(2025, 9, 1),
  });

/**
 * The story's `photos` set in a temp home, with its snapshots up to and
 * including `until`, and a way to run the CLI there.
 * @param {string} root
 * @param {string} until
 */
export const storySet = (root, until) =>
  photosSet(
    root,
    Object.fromEntries(
      timeline
        .filter(({ name }) => name <= until)
        .map(({ name }) => [
          name,
          [...filesAt(name)].map(
            ([path, { fill, size, mtime }]) =>
              new File([new Uint8Array(size).fill(fill.charCodeAt(0))], path, {
                lastModified: Date.parse(mtime),
              }),
          ),
        ]),
    ),
    sets.photos.folder,
  );

const { files, bytes, objects, scanMs, uploadMs } = scale.firstBackup;

/**
 * The README quick start's first backup of `photos`: the story's first.
 * @type {BackupResult}
 */
export const firstBackup = {
  set: "photos",
  bucket,
  snapshot: timeline[0]?.name ?? "",
  files,
  bytes,
  hashedFiles: files,
  hashedBytes: bytes,
  scanMs,
  candidates: objects,
  uploaded: objects,
  uploadedBytes: bytes,
  uploadMs,
  errors: [],
  excludeSuggestions: [],
  excludePath: "",
  comparison: null,
};

/**
 * A restore of `photos`, from the story's latest backup when restore.md is
 * read, empty unless `result` says otherwise.
 * @param {Partial<RestoreResult>} result
 * @returns {RestoreResult}
 */
export const restoreResult = (result) => ({
  set: "photos",
  bucket,
  snapshot: "20260612T0915",
  restored: [],
  skipped: [],
  collided: [],
  missing: [],
  corrupt: [],
  refused: [],
  blocked: [],
  clamped: [],
  coarseTimes: 0,
  invalid: [],
  deleted: [],
  unmatched: [],
  ...result,
});
