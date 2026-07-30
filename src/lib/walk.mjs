import { existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, posix, resolve, sep } from "node:path";
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
 * Characters a snapshot row cannot hold: the field separator, and the two that
 * end a line ([ADR-0073](../../docs/adr/0073-refuse-tab-newline-paths.md)). The
 * TSV deliberately has no escaping — that plainness is the point of
 * [ADR-0004](../../docs/adr/0004-tsv-snapshot-manifests.md) — so such a name is
 * refused rather than encoded. A carriage return counts with the line feed: the
 * snapshot parser reads lines with `crlfDelay: Infinity`, which strips a
 * trailing one, so the path would come back *changed* — worse than refused.
 * Windows forbids all three (it excludes characters 1-31), so this can only ever
 * fire on Linux or macOS.
 */
const UNREPRESENTABLE_IN_TSV = /[\t\n\r]/;

/**
 * Render a path's control characters visibly, so an error can name a file whose
 * name would otherwise mangle the message it appears in — a raw line break would
 * split one entry across two lines of the list. Display only: nothing written to
 * a snapshot passes through here, because such a path never reaches one.
 * @param {string} path
 */
const showControlChars = (path) =>
  path
    .replaceAll("\t", "<TAB>")
    .replaceAll("\r", "<CR>")
    .replaceAll("\n", "<NL>");

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
 *
 * Entries must be **absolute on this platform**, checked first because it is the
 * sharper diagnosis of the same symptom
 * ([ADR-0071](../../docs/adr/0071-snapshot-paths-absolute-native.md)).
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

  // One test, two causes, and they cannot be told apart without guessing at path
  // shapes — so the message states the fact and offers both. A *relative* entry
  // is refused outright: it would make the set's contents depend on the working
  // directory s3cab happened to be run from, which is no way to run a backup. A
  // *foreign absolute* entry is a set adopted from another OS, where `dirs.txt`
  // arrives verbatim and `C:\Users\me\Photos` is not an unplugged drive.
  // Same `isAbsolute` test `restore` applies to snapshot paths, with the same
  // one-way limit: Windows treats a leading `/` as rooted, so a POSIX `dirs.txt`
  // read on Windows falls through to "aren't available" below — still loud, and
  // still pointing at the file to edit.
  const notHere = set.dirs.filter((dir) => !isAbsolute(dir));
  if (notHere.length) {
    throw new Error(
      `These entries in backup set '${set.name}' aren't full paths to folders on this computer:\n` +
        notHere.map((dir) => `  ${dir}`).join("\n") +
        `\nEach line has to be a full path — a partial one would change what gets ` +
        `backed up depending on which folder you ran s3cab from. A set first set ` +
        `up on a different kind of computer reads this way too. Edit the list:\n` +
        `  ${set.dirsPath}\n` +
        `Or, to get files back from a backup made elsewhere:\n` +
        `  s3cab restore --set ${set.name} --output <folder>`,
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
  // Paths the snapshot TSV cannot hold (ADR-0073). Collected rather than thrown
  // on sight: the one person who ever hits this is the one whose script made
  // hundreds of them, and fixing those an error at a time would be its own
  // ordeal — the same reasoning as `assertWalkableDirs` listing every offender.
  /** @type {string[]} */
  const unrepresentable = [];

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
    // Paint the label before walking a single entry. Folding the announce into
    // the progress line otherwise costs the immediate feedback the old separate
    // `console.warn` gave: with the first redraw 500 files away, a slow or cold
    // directory would sit blank and look hung. Bare label, no count — a "0"
    // would be worse than nothing. A no-op off a terminal, where each
    // directory's closing line is the whole story.
    progress.update(label);

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
      // Only a path that would otherwise be *kept* reaches this loop — the walk
      // callback drops excluded entries and unsupported types before yielding —
      // so a pattern in exclude.txt keeps its match from ever being refused,
      // which is what makes exclude.txt the escape hatch (ADR-0073).
      if (UNREPRESENTABLE_IN_TSV.test(path)) {
        unrepresentable.push(path);
      }
      files.push(path);
      // Redraw every 500 files *of this directory* (after the push, so the count
      // reflects files actually found). Bound once: gating on the set-wide
      // `files.length` while displaying the per-directory delta made the cadence
      // depend on where the previous directory happened to stop — a second
      // directory following a first of 111 files redrew at 389, then 889.
      const found = files.length - before;
      if (found % 500 === 0) {
        progress.update(`${label} ${formatCount(found)}`);
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

  // After the walk, so one failure names every offender, never truncated
  // (ADR-0010). ADR-0030 shape: the user's goal first, then the exact fix.
  if (unrepresentable.length) {
    const count =
      unrepresentable.length === 1
        ? "This file can't"
        : `These ${formatCount(unrepresentable.length)} files can't`;
    throw new Error(
      `${count} be backed up, because the name contains a tab or a line break:\n` +
        unrepresentable.map((p) => `  ${showControlChars(p)}`).join("\n") +
        `\nA snapshot is a table with one line per file and a tab between ` +
        `columns, so a name using either character can't be written into it. ` +
        `Rename them, or leave them out by adding a pattern to the set's ` +
        `exclude file:\n` +
        `  odd*name.jpg`,
    );
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
