import {
  linkSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join, sep } from "node:path";

// Hostile file-tree builders (Windows-first, per the brief): each returns
// what it managed to create, so tests can skip what the host refuses (a file
// symlink without Developer Mode) instead of failing on environment.
//
// Creation uses the `\\?\` verbatim prefix where plain Win32 paths refuse
// (reserved device names, trailing dots/spaces) — NTFS stores such names
// fine; it is the Win32 path layer that mangles them, which is exactly the
// hazard these trees exercise: the walk meets names that ordinary tooling
// cannot have created but which are really on disk.

/**
 * The verbatim form of an absolute Windows path (no-op elsewhere — the
 * prefix is only prepended on win32).
 * @param {string} path
 * @returns {string}
 */
export const verbatim = (path) =>
  process.platform === "win32" ? `\\\\?\\${path}` : path;

/**
 * Create a file whose name only the verbatim layer can spell.
 * @param {string} dir - Existing directory (absolute)
 * @param {string} name
 * @param {Buffer | string} content
 * @returns {boolean} whether creation succeeded
 */
export function writeVerbatim(dir, name, content) {
  try {
    writeFileSync(verbatim(join(dir, name)), content);
    return true;
  } catch {
    return false;
  }
}

/**
 * A directory chain pushing the absolute path well past MAX_PATH (260).
 * @param {string} root - Existing directory (absolute)
 * @returns {string | null} the deep directory's path, or null if the host
 *   refused to create it
 */
export function deepDirectory(root) {
  const segment = "deep-path-segment-x";
  let dir = root;
  try {
    while (dir.length < 320) {
      dir = join(dir, segment);
      mkdirSync(verbatim(dir));
    }
    return dir;
  } catch {
    return null;
  }
}

/**
 * A junction (works without privileges on Windows) and, if the host allows,
 * a file symlink (needs Developer Mode or admin).
 * @param {string} dir - Existing directory (absolute)
 * @param {string} targetFile - Existing file to point the symlink at
 * @param {string} targetDir - Existing directory to point the junction at
 * @returns {{ junction: boolean, symlink: boolean }} what got created
 */
export function writeLinks(dir, targetFile, targetDir) {
  let junction = false;
  let symlink = false;
  try {
    symlinkSync(targetDir, join(dir, "junction-to-sibling"), "junction");
    junction = true;
  } catch {
    // host refused — reported, not fatal
  }
  try {
    symlinkSync(targetFile, join(dir, "symlink-to-file"), "file");
    symlink = true;
  } catch {
    // needs Developer Mode/admin on Windows — reported, not fatal
  }
  return { junction, symlink };
}

/**
 * Two directory entries, one file content — a hardlink pair.
 * @param {string} dir
 * @param {Buffer | string} content
 * @returns {boolean}
 */
export function writeHardlinkPair(dir, content) {
  try {
    writeFileSync(join(dir, "hardlink-a.txt"), content);
    linkSync(join(dir, "hardlink-a.txt"), join(dir, "hardlink-b.txt"));
    return true;
  } catch {
    return false;
  }
}

/**
 * Files with implausible modification times: before the epoch era backups
 * care about (1980) and in the future (2100).
 * @param {string} dir
 */
export function writeImplausibleTimestamps(dir) {
  writeFileSync(join(dir, "ancient.txt"), "written long ago");
  utimesSync(
    join(dir, "ancient.txt"),
    new Date("1980-01-02T00:00:00Z"),
    new Date("1980-01-02T00:00:00Z"),
  );
  writeFileSync(join(dir, "future.txt"), "written tomorrow");
  utimesSync(
    join(dir, "future.txt"),
    new Date("2100-01-01T00:00:00Z"),
    new Date("2100-01-01T00:00:00Z"),
  );
}

/**
 * Unicode normalisation neighbours: café spelled NFC (é = U+00E9) and NFD
 * (e + combining acute) — distinct names on NTFS and ext4, byte-distinct
 * everywhere. APFS folds normalisation the way NTFS folds case, so on macOS
 * the second write lands on the first file and the pair collapses to one.
 * @param {string} dir
 * @returns {boolean} whether the two spellings remained distinct files
 */
export function writeUnicodePair(dir) {
  writeFileSync(join(dir, "café.txt"), "nfc spelling");
  writeFileSync(join(dir, "café.txt"), "nfd spelling");
  return readFileSync(join(dir, "café.txt"), "utf8") === "nfc spelling";
}

/** `sep` re-export so tests can build native paths without importing path. */
export { sep };
