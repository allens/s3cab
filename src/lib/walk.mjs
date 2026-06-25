import { existsSync, readdirSync, realpathSync } from "node:fs";
import { join, posix, resolve, sep } from "node:path";
import { stderr } from "node:process";
import { compileExclude } from "./exclude.mjs";
import { secondsSince } from "./format.mjs";
import { readLines } from "./read-lines.mjs";

/**
 * @import { Dirent } from "node:fs"
 * @import { BackupSet } from "./sets.mjs"
 */

/**
 * One entry the walk skipped, carried back as data (not a formatted line) so
 * the walk stays ignorant of the snapshot grammar — `writeSnapshot` turns these
 * into `#EXCLUDED` rows. `fileType` is the dirent type (`File`/`Directory`/…);
 * `reason` is the matching exclude pattern, or why the entry was skipped (e.g.
 * an unsupported file type). Both are known from the `Dirent` — no extra `stat`.
 * @typedef {{ fileType: string, reason: string, path: string }} ExclusionRecord
 */

/** @typedef {{ files: string[], excluded: ExclusionRecord[], skipped: ExclusionRecord[] }} WalkResult */

/**
 * Walk a resolved backup set: every member directory, with the set's
 * `exclude.txt` patterns applied relative to each (docs/specs/backup.md). The shared
 * core behind both the `tree` and `snapshot` commands.
 * @param {BackupSet} set - Resolved backup set
 * @returns {WalkResult} The kept file paths and the records of what was skipped
 */
export function walkSet(set) {
  const excludePath = set.excludePath;
  const patterns = existsSync(excludePath) ? readLines(excludePath) : [];
  if (patterns.length) {
    console.warn("Using exclude file", `'${excludePath}'`);
  }
  return walkDirs(set.dirs, patterns);
}

/**
 * Recursively list the files in one or more directories, dropping anything an
 * exclude pattern matches (patterns apply relative to *each* directory). A
 * directory's contents are accumulated into one list — the same line format
 * works across roots because snapshot paths are absolute.
 * @param {string[]} dirs - Directories to walk
 * @param {string[]} patterns - Exclude glob patterns (guide/exclude.md)
 * @returns {WalkResult} The kept file paths and the records of what was skipped
 */
export function walkDirs(dirs, patterns) {
  const start = Temporal.Now.instant();

  /** @type {string[]} */
  const files = [];
  /** @type {ExclusionRecord[]} */
  const excluded = [];
  /** @type {ExclusionRecord[]} */
  const skipped = [];
  for (let dir of dirs) {
    dir = realpathSync.native(dir);
    console.warn("Finding files in", `'${dir}'`);

    const walkCallbackFn = createWalkCallbackFn(
      dir,
      patterns,
      excluded,
      skipped,
    );

    for (const path of walkFiles(dir, walkCallbackFn)) {
      if (files.length % 500 === 0) {
        stderr.write(`\rFound ${files.length} files...`);
      }
      files.push(path);
    }
  }

  stderr.write(secondsSince(start) + "\n");

  // A file reached by more than one root means the set's member directories
  // overlap (one nested under another) — name the offender so the user can fix
  // dirs.txt, rather than failing with a bare "duplicates" invariant.
  const seen = new Set();
  for (const path of files) {
    if (seen.has(path)) {
      throw new Error(
        `File found under more than one of the set's folders: ${path}\n` +
          `The set's folders overlap (one is nested under another). Edit the ` +
          `set's dirs.txt so its folders don't contain one another.`,
      );
    }
    seen.add(path);
  }

  return { files, excluded, skipped };
}

/**
 * Create a predicate function to exclude files based on patterns. Skipped
 * entries are pushed onto `excluded` as data; the walk no longer knows the
 * snapshot grammar (`writeSnapshot` formats them into `#EXCLUDED` rows).
 * @param {string} baseDir - Base directory
 * @param {string[]} patterns - Exclude patterns
 * @param {ExclusionRecord[]} excluded - Receives a record per pattern-matched entry
 * @param {ExclusionRecord[]} skipped - Receives a record per by-design unsupported entry
 * @returns {(dirent: Dirent) => string | null} walk callback function
 */
function createWalkCallbackFn(baseDir, patterns, excluded, skipped) {
  const matchers = patterns.map((pattern) => ({
    pattern,
    matcher: compileExclude(join(baseDir, pattern)),
  }));

  return (dirent) => {
    const path = resolve(dirent.parentPath, dirent.name);
    const fileType = getFileType(dirent);

    if (dirent.isFile() || dirent.isDirectory()) {
      let testString = path.split(sep).join(posix.sep);

      if (dirent.isDirectory()) {
        testString += posix.sep;
      }

      const match = matchers.find(({ matcher }) => matcher.test(testString));

      if (match) {
        excluded.push({ fileType, reason: match.pattern, path });
        return null;
      }
    } else {
      skipped.push({ fileType, reason: "Unsupported file type", path });
      return null;
    }

    return path;
  };
}

/**
 * Get the file type of a dirent.
 * @param {Dirent} dirent - Directory entry
 * @returns {string} File type
 */
function getFileType(dirent) {
  if (dirent.isFile()) {
    return "File";
  } else if (dirent.isDirectory()) {
    return "Directory";
  } else if (dirent.isSymbolicLink()) {
    return "SymbolicLink";
  } else if (dirent.isBlockDevice()) {
    return "BlockDevice";
  } else if (dirent.isCharacterDevice()) {
    return "CharacterDevice";
  } else if (dirent.isFIFO()) {
    return "FIFO";
  } else if (dirent.isSocket()) {
    return "Socket";
  }
  return "Unknown File Type";
}

/**
 * Recursively walk through a directory and yield file paths.
 * @param {string} dir - Directory to walk through
 * @param {(dirent: Dirent) => string | null} callbackFn - Callback function to process files
 * @yields {string} File paths
 * @returns {Generator<string>} Generator of file paths
 */
function* walkFiles(dir, callbackFn) {
  for (const dirent of readdirSync(dir, { withFileTypes: true })) {
    const { name } = dirent;

    const path = callbackFn(dirent);

    if (!path) {
      continue;
    }

    if (dirent.isDirectory()) {
      if (name === ".s3cab") {
        continue;
      }
      yield* walkFiles(path, callbackFn);
    } else {
      yield path;
    }
  }
}
