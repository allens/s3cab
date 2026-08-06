import {
  existsSync,
  lstatSync,
  readdirSync,
  realpathSync,
  statSync,
} from "node:fs";
import { isAbsolute, join, posix, resolve, sep } from "node:path";
import { stderr } from "node:process";
import { compileExclude } from "./exclude.mjs";
import { formatCount, plural, secondsSince } from "./format.mjs";
import { tildeify } from "./home.mjs";
import { countedPass } from "./progress.mjs";
import { readLines } from "./read-lines.mjs";

/**
 * @import { Dirent, Stats } from "node:fs"
 * @import { BackupSet } from "./sets.mjs"
 */

/**
 * One entry the walk skipped, carried back as data (not a formatted line) so
 * the walk stays ignorant of the snapshot grammar — `writeSnapshot` turns these
 * into `#EXCLUDED` rows. `fileType` is the dirent type (`File`/`Directory`/…);
 * `reason` is the matching exclude pattern, or why the entry was skipped (e.g.
 * an unsupported file type). Both come from the `Dirent` the walk already has —
 * no `stat` per file, and none at all on a filesystem that reports entry types
 * (the exception is `resolveFileType`'s fallback for one that doesn't).
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
    const before = files.length;
    // Which directory, its running count, and its final tally are all one line
    // — the announce used to be its own `console.warn` above a separate counter,
    // so the naming of the directory scrolled away from the number it belonged
    // to. Everything about how that line is drawn (the bare first paint, the
    // clock, the TTY gate, the closing newline) lives in lib/progress.mjs; this
    // supplies only what it says and where the count comes from. The `using` is
    // scoped to the loop *body*, so every directory's line closes before the
    // next one opens — and the duplicate-path throw below closes it *without* a
    // tally, since that directory never finished.
    using progress = countedPass(
      stderr,
      `Finding files in '${tildeify(dir)}'…`,
      // This directory's files, not the set-wide total, so the figure belongs
      // to the line it sits on.
      () => files.length - before,
    );

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
    }

    // This directory finished, so its line settles on the true total rather than
    // whatever the last redraw showed. Nothing is drawn from here: the loop no
    // longer touches the line at all, which is the point — it used to redraw
    // from inside this loop, and the count froze whenever the walk did.
    progress.done();
  }

  // After the walk, so one failure names every offender, never truncated
  // (ADR-0010). ADR-0030 shape: the user's goal first, then the exact fix.
  if (unrepresentable.length) {
    const count =
      unrepresentable.length === 1
        ? "This file can't"
        : `These ${formatCount(unrepresentable.length)} files can't`;
    throw new Error(
      `${count} be backed up, because the name contains a tab or a line ending:\n` +
        unrepresentable.map((p) => `  ${showControlChars(p)}`).join("\n") +
        `\nA snapshot is a table with one line per file and a tab between ` +
        `columns, so a name using either can't be written into it. ` +
        `Rename them, or leave them out by adding a pattern to the set's ` +
        `exclude file:\n` +
        `  odd*name.jpg`,
    );
  }

  // What the walk left out, said out loud. These are recorded as `#SKIPPED` rows
  // in the snapshot, but that is a file you have to decompress to read — so until
  // now a symlinked folder, or a whole subtree the filesystem couldn't classify,
  // simply wasn't in the backup and nothing ever said so. A backup quietly
  // holding less than you think is the failure this tool can least afford, and
  // it is the same reasoning that makes a missing member directory abort
  // outright (ADR-0054); this one only *reports*, because skipping these types
  // is by design rather than a fault to fix.
  //
  // Grouped by type and counted, not listed: the type is the whole explanation
  // (a symlink is expected, a socket is noise, a thousand of either is a set
  // that wants an exclude pattern), and one line beats thousands. The counts and
  // the paths both remain in the snapshot for anyone who wants them.
  if (skipped.length) {
    /** @type {Map<string, number>} */
    const byType = new Map();
    for (const { fileType } of skipped) {
      byType.set(fileType, (byType.get(fileType) ?? 0) + 1);
    }
    const kinds = [...byType]
      .map(
        ([fileType, count]) =>
          `${formatCount(count)} ${plural(count, spaced(fileType))}`,
      )
      .join(", ");
    console.warn(
      `Skipped ${formatCount(skipped.length)} ` +
        `${plural(skipped.length, "item")} that can't be backed up: ${kinds}`,
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
 * @returns {(path: string, fileType: string) => boolean} walk callback function
 */
function createWalkCallbackFn(baseDir, patterns, excluded, skipped) {
  const matchers = patterns.map((pattern) => ({
    pattern,
    matcher: compileExclude(join(baseDir, pattern)),
  }));

  // Takes the resolved type rather than the `Dirent` it came from: `walkFiles`
  // has already paid for it (possibly with an `lstat`), and asking the dirent
  // again here would read the *unresolved* answer — the bug `resolveFileType`
  // exists to fix.
  return (path, fileType) => {
    if (fileType === "File" || fileType === "Directory") {
      let testString = path.split(sep).join(posix.sep);

      if (fileType === "Directory") {
        testString += posix.sep;
      }

      const match = matchers.find(({ matcher }) => matcher.test(testString));

      if (match) {
        excluded.push({ fileType, reason: match.pattern, path });
        return false;
      }
    } else {
      skipped.push({ fileType, reason: "Unsupported file type", path });
      return false;
    }

    return true;
  };
}

/**
 * The type `readdir` reports for an entry it could not classify — every one of
 * the seven predicates below answers `false`, so `getFileType` falls through to
 * this. It is a real answer from some filesystems, not a corrupt one: the type
 * simply doesn't travel with the directory entry there (see `resolveFileType`).
 */
const UNKNOWN = "Unknown File Type";

/**
 * `SymbolicLink` → `Symbolic Link`: a stored type token, spaced for reading.
 *
 * **Display only** — the snapshot's `dirent_type` column keeps the unspaced
 * token, because that is the format's grammar (guide/format.md) and not ours to
 * restyle. The two diverge on purpose: one is a field, the other is a sentence.
 * Without this the notice mixed conventions in a single line — `1 SymbolicLink,
 * 1 Unknown File Type` — since only some of the tokens are camel-cased.
 *
 * Casing is left alone. Lowercasing would read more naturally for most of them
 * but would mangle `FIFO`, and every skippable type is a regular noun, so
 * `plural` can pluralize the result as-is (`Directory`, the one irregular, is
 * kept by the walk and so never reaches here).
 * @param {string} fileType
 * @returns {string}
 */
const spaced = (fileType) => fileType.replace(/(?<=[a-z])(?=[A-Z])/g, " ");

/**
 * Get the file type of a directory entry or a stat.
 *
 * Takes either because a `Dirent` and a `Stats` answer the same seven questions
 * — which is what lets `resolveFileType` fall back from one to the other without
 * a second way of naming a type.
 * @param {Dirent | Stats} dirent - Directory entry, or the stat of one
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
  return UNKNOWN;
}

/**
 * The entry's type, falling back to one `lstat` when `readdir` didn't supply it.
 *
 * Most filesystems carry the type in the directory entry itself, which is why
 * the walk can classify tens of thousands of files without touching one — NTFS,
 * APFS, ext4, btrfs and modern XFS all do. Some do not: NFS reports unknown for
 * entries whose attributes the client hasn't cached (mounted `nordirplus`, a
 * server without READDIRPLUS, or a directory large enough that the client backs
 * off), as do FUSE filesystems whose author left the field unset. There the
 * whole set would otherwise go missing — silently, which is the failure a backup
 * tool least affords: an unclassified *file* was recorded as an unsupported type
 * and left out, and an unclassified *directory* was never descended into at all,
 * taking its entire subtree with it.
 *
 * So: one `lstat`, and **only** for an entry `readdir` couldn't classify. On
 * every filesystem in the first list that is zero calls, which is what keeps
 * this off the hot path — the per-file `stat` pass CLAUDE.md warns against would
 * cost the walk roughly an order of magnitude on Windows. The type is resolved
 * **once** per entry and handed to both consumers (the exclude callback and the
 * recursion test below), because resolving it separately for each is precisely
 * the double-`lstat` that turns a rare fallback into that pass.
 *
 * `lstat`, not `stat`, so a symlink stays a symlink: following one here would
 * both change what the walk skips and open the door to cycles. An entry that
 * can't be stat-ed either (it vanished mid-walk, or is unreadable) keeps the
 * unknown type and is recorded as skipped — the walk's existing answer for
 * "can't back this up", and one that names the path rather than dying on it.
 * @param {Dirent} dirent - Directory entry
 * @param {string} path - Its resolved absolute path
 * @returns {string} File type
 */
function resolveFileType(dirent, path) {
  const fileType = getFileType(dirent);
  if (fileType !== UNKNOWN) {
    return fileType;
  }
  try {
    return getFileType(lstatSync(path));
  } catch {
    return UNKNOWN;
  }
}

/**
 * Recursively walk through a directory and yield file paths.
 *
 * The entry's type is resolved here, once, and passed down — see
 * `resolveFileType` for why it cannot be re-derived per consumer.
 * @param {string} dir - Directory to walk through
 * @param {(path: string, fileType: string) => boolean} callbackFn - Whether to keep the entry
 * @yields {string} File paths
 * @returns {Generator<string>} Generator of file paths
 */
function* walkFiles(dir, callbackFn) {
  for (const dirent of readdirSync(dir, { withFileTypes: true })) {
    const path = resolve(dirent.parentPath, dirent.name);
    const fileType = resolveFileType(dirent, path);

    if (!callbackFn(path, fileType)) {
      continue;
    }

    if (fileType === "Directory") {
      if (dirent.name === ".s3cab") {
        continue;
      }
      yield* walkFiles(path, callbackFn);
    } else {
      yield path;
    }
  }
}
