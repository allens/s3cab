import { existsSync, readdirSync, realpathSync } from "node:fs";
import { join, posix, resolve, sep } from "node:path";
import { stderr } from "node:process";
import { secondsSince } from "../lib/format.mjs";
import { readLines } from "../lib/read-lines.mjs";
import { resolveSet, setExcludePath } from "../lib/sets.mjs";
import { excludedLine } from "../lib/snapshot-file.mjs";

/**
 * @import { Writable } from "node:stream"
 * @import { Dirent } from "node:fs"
 * @import { BackupSet } from "../lib/sets.mjs"
 */

/** @typedef {{ write: (line: string) => unknown }} LineWriter */

/**
 * List the files a snapshot of `setName` would include — the `tree` command,
 * and the diagnostic answer to "exactly what is in this set". Resolves the set
 * (sole-set default, or an error listing the sets) and walks it.
 * @param {string} [setName] - Backup set to list (default: the only set)
 * @param {Writable} [writeStream]
 * @returns {Array<string>} Array of absolute file paths
 */
export function tree(setName, writeStream) {
  return walkSet(resolveSet(setName), writeStream);
}

/**
 * Walk a resolved backup set: every member directory, with the set's
 * `exclude.txt` patterns applied relative to each (specs/backup.md). The
 * shared core behind both `tree` and `snapshot`.
 * @param {BackupSet} set - Resolved backup set
 * @param {Writable} [writeStream]
 * @returns {Array<string>} Array of absolute file paths
 */
export function walkSet(set, writeStream) {
  const excludePath = setExcludePath(set.name);
  const patterns = existsSync(excludePath) ? readLines(excludePath) : [];
  if (patterns.length) {
    console.warn("Using exclude file", `'${excludePath}'`);
  }
  return walkDirs(set.dirs, patterns, writeStream);
}

/**
 * Recursively list the files in one or more directories, dropping anything an
 * exclude pattern matches (patterns apply relative to *each* directory). A
 * directory's contents are accumulated into one list — the same line format
 * works across roots because snapshot paths are absolute.
 * @param {string[]} dirs - Directories to walk
 * @param {string[]} patterns - Exclude glob patterns (doc/exclude.md)
 * @param {Writable} [writeStream] - Receives `#EXCLUDED` lines
 * @returns {Array<string>} Array of absolute file paths
 */
export function walkDirs(dirs, patterns, writeStream) {
  const start = Temporal.Now.instant();

  /** @type {string[]} */
  const files = [];
  for (let dir of dirs) {
    dir = realpathSync.native(dir);
    console.warn("Finding files in", `'${dir}'`);

    const walkCallbackFn = patterns.length
      ? createWalkCallbackFn(dir, patterns, writeStream)
      : undefined;

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

  return files;
}

/**
 * Create a predicate function to exclude files based on patterns.
 * @param {string} baseDir - Base directory
 * @param {string[]} patterns - Exclude patterns
 * @param {LineWriter} [snapshotWriteStream]
 * @returns {(dirent: Dirent) => string | null} walk callback function
 */
function createWalkCallbackFn(baseDir, patterns, snapshotWriteStream) {
  const matchers = patterns.map((pattern) => ({
    pattern,
    matcher: createMatcher(join(baseDir, pattern)),
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
        snapshotWriteStream?.write(excludedLine(fileType, match.pattern, path));
        return null;
      }
    } else {
      snapshotWriteStream?.write(
        excludedLine(fileType, "Unsupported file type", path),
      );
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
 * Create a RegExp matcher from a pattern.
 *
 * Users may write patterns with either separator (`/` everywhere; `\` also
 * works on Windows, where `join` above has already normalized it to the
 * platform separator). Everything — pattern here, tested path in the walk
 * callback — is converted to `/` before matching, because the per-segment
 * globs (`*`, `?`) need one canonical separator to define a segment.
 * @param {string} pattern - Pattern string
 * @returns {RegExp} RegExp matcher
 */
function createMatcher(pattern) {
  // @ts-ignore - RegExp.escape exists in Node 24+
  const regexPattern = RegExp.escape(
    posix.normalize(pattern.split(sep).join(posix.sep)),
  )
    // **/ matches zero or more segments
    .replace(/\\\*\\\*\\\//g, "(.*\\/)?")
    // * matches one or more chars in one segment
    .replace(/\\\*/g, "[^/]+")
    // ? matches one char
    .replace(/\\\?/g, "[^/]");

  return new RegExp(
    `^${regexPattern}$`,
    process.platform === "win32" ? "i" : "",
  );
}

/**
 * Recursively walk through a directory and yield file paths.
 * @param {string} dir - Directory to walk through
 * @param  {(dirent: Dirent) => string | null} [callbackFn] - Callback function to process files
 * @yields {string} File paths
 * @returns {Generator<string>} Generator of file paths
 */
function* walkFiles(dir, callbackFn) {
  for (const dirent of readdirSync(dir, { withFileTypes: true })) {
    const { parentPath, name } = dirent;

    const path = callbackFn ? callbackFn(dirent) : join(parentPath, name);

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
