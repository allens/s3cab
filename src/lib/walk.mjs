import { existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import { join, posix, resolve, sep } from "node:path";
import { stderr } from "node:process";
import { compileExclude } from "./exclude.mjs";
import { formatCount, secondsSince } from "./format.mjs";
import { tildeify } from "./home.mjs";
import { createProgress } from "./progress.mjs";
import { readLines } from "./read-lines.mjs";
import { isInteractive } from "./style.mjs";

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
 * `exclude.txt` patterns applied relative to each (docs/design/backup.md). The shared
 * core behind both the `tree` and `snapshot` commands.
 * @param {BackupSet} set - Resolved backup set
 * @returns {WalkResult} The kept file paths and the records of what was skipped
 */
export function walkSet(set) {
  assertWalkableDirs(set);
  return walkDirs(set.dirs, readExcludePatterns(set.excludePath));
}

/**
 * Read a set's `exclude.txt` into a list of glob patterns (empty when the file is
 * absent), announcing the file on stderr when it holds any. The shared front of
 * both walk entry points — `walkSet` (whole set) and `upload --dir` (one subtree
 * seeded into the store) — so a seed honours exactly the excludes a backup would.
 * @param {string} excludePath - Path to the set's `exclude.txt`
 * @returns {string[]} The exclude glob patterns (guide/exclude.md)
 */
export function readExcludePatterns(excludePath) {
  const patterns = existsSync(excludePath) ? readLines(excludePath) : [];
  if (patterns.length) {
    console.warn("Using exclude file", `'${tildeify(excludePath)}'`);
  }
  return patterns;
}

/**
 * Guard that every member directory is present and really a directory before the
 * walk starts. `dirs.txt` is a hand-edited public file, so a line can point at a
 * deleted or renamed folder, a typo, or an unplugged drive; without this the walk
 * dies mid-run on a raw `ENOENT` at the first bad path. A backup must never
 * *silently* skip a directory the user means to keep, so a missing directory
 * **aborts the whole run** rather than backing up a quietly smaller set
 * ([ADR-0054](../../docs/adr/0054-missing-member-dir-aborts.md)) — the failure is
 * loud and lists every offender at once, and the fix is to reconnect the drive or
 * edit `dirs.txt`. An empty `dirs.txt` is the degenerate case (nothing to back up).
 * @param {BackupSet} set
 */
function assertWalkableDirs(set) {
  if (set.dirs.length === 0) {
    throw new Error(
      `Backup set '${set.name}' has no directories to back up.\n` +
        `Add one absolute path per line to:\n` +
        `  ${set.dirsPath}`,
    );
  }
  const unavailable = set.dirs.filter((dir) => {
    try {
      return !statSync(dir).isDirectory();
    } catch {
      return true; // missing (ENOENT) or otherwise unreadable → unavailable
    }
  });
  if (unavailable.length) {
    throw new Error(
      `These directories in backup set '${set.name}' aren't available:\n` +
        unavailable.map((dir) => `  ${dir}`).join("\n") +
        `\nA backup won't run while a listed directory can't be reached — it may be ` +
        `missing (an unplugged drive, a deleted or renamed folder) or unreadable. ` +
        `Reconnect the drive, or edit the set's directory list:\n` +
        `  ${set.dirsPath}`,
    );
  }
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
  // Every path kept so far, across *all* roots — a file reached twice means the
  // set's member directories overlap (one nested under another). Checked as each
  // file arrives so an overlapping set fails at the first duplicate, not after a
  // full walk (minutes, on a big set).
  /** @type {Set<string>} */
  const seen = new Set();
  /** @type {ExclusionRecord[]} */
  const excluded = [];
  /** @type {ExclusionRecord[]} */
  const skipped = [];

  for (let dir of dirs) {
    dir = realpathSync.native(dir);
    const dirStart = Temporal.Now.instant();
    const before = files.length;
    // Which directory, its running count, and its final tally are all one line,
    // redrawn in place — the announce used to be its own `console.warn` above a
    // separate counter, so the naming of the directory scrolled away from the
    // number it belonged to. In-place animation is terminal only (the TTY gate
    // and the closing newline live in lib/progress.mjs); off a terminal the
    // redraws stay silent and only each directory's closing line is logged, so a
    // redirected log holds no carriage returns. The `using` is scoped to the loop
    // *body*, so every directory's line is closed before the next one opens.
    const label = `Finding files in '${tildeify(dir)}'…`;
    using progress = createProgress(stderr);

    const walkCallbackFn = createWalkCallbackFn(
      dir,
      patterns,
      excluded,
      skipped,
    );

    for (const path of walkFiles(dir, walkCallbackFn)) {
      if (seen.has(path)) {
        // Name the offender so the user can fix dirs.txt, rather than failing
        // with a bare "duplicates" invariant.
        throw new Error(
          `File found under more than one of the set's directories: ${path}\n` +
            `The set's directories overlap (one is nested under another). Edit the ` +
            `set's dirs.txt so its directories don't contain one another.`,
        );
      }
      seen.add(path);
      files.push(path);
      // Redraw every 500 files (after the push, so the count reflects files
      // actually found — never a misleading "0" first line).
      if (files.length % 500 === 0) {
        progress.update(`${label} ${formatCount(files.length - before)}`);
      }
    }

    // This directory's true total (not the last multiple of 500) with its own
    // elapsed time: redrawn in place on a terminal, or logged as one clean line
    // otherwise. Always drawn, so a directory too small to trigger a single
    // redraw still gets its line.
    const summary = `${label} ${formatCount(files.length - before)} in ${secondsSince(dirStart)}`;
    if (isInteractive(stderr)) {
      progress.update(summary);
    } else {
      console.warn(summary);
    }
  }

  // The set's total, only when there is more than one member directory to add
  // up — for a single directory it would just restate the line above it.
  if (dirs.length > 1) {
    console.warn(
      `Found ${formatCount(files.length)} files in ${secondsSince(start)}`,
    );
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
