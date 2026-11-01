import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { writeSnapshot } from "./write-snapshot.mjs";

/** @import { BackupResult } from "../../src/commands/backup.mjs" */
/** @import { RestoreResult } from "../../src/lib/restore.mjs" */

const CLI = fileURLToPath(new URL("../../src/s3cab.mjs", import.meta.url));

/**
 * A `photos` set over `~/Pictures` in a temp home, with a snapshot per entry of
 * `snapshots` (name → files, paths relative to the set's directory), and a way
 * to run the CLI there. Paths are written as the snapshot would hold them, so
 * the report shortens them against the home exactly as on a real machine.
 * @param {string} root
 * @param {Record<string, File[]>} snapshots
 */
export async function photosSet(root, snapshots) {
  // Absolute, as `setup` writes it: the snapshot rows are absolute paths.
  const home = resolve(root, "home");
  const pictures = join(home, "Pictures");
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
 * The README quick start's first backup of `photos` to `my-backups`.
 * @type {BackupResult}
 */
export const firstBackup = {
  set: "photos",
  bucket: "my-backups",
  snapshot: "20251112T0915",
  files: 1_312,
  bytes: 4_200_000_000,
  hashedFiles: 1_312,
  hashedBytes: 4_200_000_000,
  scanMs: 161_000,
  candidates: 1_240,
  uploaded: 1_240,
  uploadedBytes: 4_200_000_000,
  uploadMs: 368_000,
  errors: [],
  excludeSuggestions: [],
  excludePath: "",
  comparison: null,
};

/**
 * A restore of `photos` from `my-backups`, empty unless `result` says
 * otherwise.
 * @param {Partial<RestoreResult>} result
 * @returns {RestoreResult}
 */
export const restoreResult = (result) => ({
  set: "photos",
  bucket: "my-backups",
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
