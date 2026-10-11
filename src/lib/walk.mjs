import {
  existsSync,
  lstatSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  statSync,
} from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { stderr } from "node:process";
import { isENOENT } from "./error.mjs";
import { compileExcludePatterns } from "./exclude.mjs";
import { formatCount, secondsSince, showControlChars } from "./format.mjs";
import { tildeify } from "./home.mjs";
import { pathMatcher } from "./path-match.mjs";
import { shellCommand } from "./style.mjs";
import { countedPass } from "./progress.mjs";
import { readLines } from "./read-lines.mjs";

/**
 * @import { Dirent, Stats } from "node:fs"
 * @import { BackupSet } from "./sets.mjs"
 */

/**
 * One entry an exclude pattern dropped, carried back as data (not a formatted
 * line) so the walk stays ignorant of the snapshot grammar — `writeSnapshot`
 * turns these into `#excluded` rows. `isDir` is what the pattern was tested
 * against: a directory, or a link whose target is one (ADR-0099).
 * @typedef {{ pattern: string, path: string, isDir: boolean }} ExclusionRecord
 */

/**
 * A link the walk recorded and did not follow
 * ([ADR-0099](../../docs/adr/0099-links-recorded-never-followed.md)): its
 * target as written, and whether that target is a folder.
 * @typedef {{ path: string, target: string, isDir: boolean }} LinkRecord
 */

/**
 * An entry the walk couldn't check, with the error's message — an `#error` row,
 * the same shape as a file that couldn't be hashed.
 * @typedef {{ path: string, reason: string }} WalkError
 */

/** @typedef {{ files: string[], excluded: ExclusionRecord[], links: LinkRecord[], errors: WalkError[] }} WalkResult */

/**
 * Characters a snapshot row cannot hold: the field separator, and the two that
 * end a line ([ADR-0073](../../docs/adr/0073-refuse-tab-newline-paths.md)). The
 * TSV deliberately has no escaping — that plainness is the point of
 * [ADR-0004](../../docs/adr/0004-tsv-snapshot-manifests.md) — so such a name, or
 * a link target, is refused rather than encoded; an excluded one is spelled out
 * (ADR-0100). A carriage return counts with the line feed: the
 * snapshot parser reads lines with `crlfDelay: Infinity`, which strips a
 * trailing one, so the path would come back *changed* — worse than refused.
 * Windows forbids all three (it excludes characters 1-31), so this can only ever
 * fire on Linux or macOS.
 */
export const UNREPRESENTABLE_IN_TSV = /[\t\n\r]/;

/**
 * Walk a resolved backup set: every member directory, with the set's
 * `exclude.txt` patterns applied relative to each (docs/design/backup.md). The shared
 * core behind both the `tree` and `snapshot` commands.
 * @param {BackupSet} set - Resolved backup set
 * @returns {WalkResult & { patterns: string[] }} What the walk found, and the exclude patterns it applied (a snapshot's `#SET EXCLUDE` rows)
 */
export function walkSet(set) {
  assertWalkableDirs(set);
  const patterns = readExcludePatterns(set.excludePath);
  return { ...walkDirs(set.dirs, patterns), patterns };
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
  // ADR-0100. After `readLines`' trim, so a CRLF file's line endings never get here.
  const unusable = patterns.filter((pattern) => /[\t\r]/.test(pattern));
  if (unusable.length) {
    const these =
      unusable.length === 1
        ? "this pattern contains"
        : "these patterns contain";
    throw new Error(
      `Can't use the set's exclude file, because ${these} a tab or a carriage ` +
        `return (${tildeify(excludePath)}):\n` +
        unusable.map((pattern) => `  ${showControlChars(pattern)}`).join("\n") +
        `\nWrite * in place of the character, which still matches it:\n` +
        unusable
          .map((pattern) => `  ${pattern.replaceAll(/[\t\r]+/g, "*")}`)
          .join("\n"),
    );
  }
  if (patterns.length) {
    console.warn("Using exclude file", `'${tildeify(excludePath)}'`);
  }
  return patterns;
}

/**
 * Whether the path is a directory that is there right now — false for a missing
 * one (ENOENT), an unreadable one, and a file. The two questions the walk asks
 * about a root before it trusts anything it says about it: which directories are
 * unavailable, and whether an unresolvable path has earned the word "folder".
 * @param {string} path
 * @returns {boolean}
 */
function isDirectory(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
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
        `up on a different kind of computer reads this way too.\n\n` +
        `Edit the list:\n` +
        `  ${set.dirsPath}\n\n` +
        `Or, to get files back from a backup made elsewhere:\n` +
        `  ${shellCommand(`s3cab restore --set ${set.name} --output <folder>`)}`,
    );
  }

  const unavailable = set.dirs.filter((dir) => !isDirectory(dir));
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
 * Canonicalize one walk root — the low-frequency capture point CLAUDE.md reserves
 * `realpathSync.native` for (once per root, never per entry), so every file below
 * it is keyed on one stable path.
 *
 * Exported for `snapshot`, which records these same canonical roots as the
 * snapshot's `#SET DIR` rows rather than the raw `dirs.txt` text — so the header
 * and the rows beneath it are spelled the same way (guide/format.md, "Path
 * casing"). It re-resolves rather than the walk handing its roots back: this is
 * one call per member directory, against a walk that stats tens of thousands of
 * files, and `WalkResult` stays what it says it is — the entries encountered,
 * not a record of how the input was read.
 *
 * It can fail on a directory that is plainly *there*: measured 2026-08-11 against
 * an unlocked OneDrive Personal Vault, where `lstat`/`stat` report a directory and
 * `readdir` lists it, but the junction targets a volume GUID with no mount point so
 * `GetFinalPathNameByHandle` — and only that, not Node's JS `realpathSync` — gives
 * `ENOENT` (proposals/filesystem-edge-cases.md). Nothing about it is vault-specific:
 * any path the OS won't canonicalize lands here, and without this it came out as a
 * raw `ENOENT` naming no goal and no fix.
 *
 * A root that is genuinely *missing* — or that isn't a directory at all — keeps its
 * raw `ENOENT`. Both entry points refuse either long before this
 * (`assertWalkableDirs` for a set, `upload`'s `--dir needs a folder that exists`),
 * so re-explaining it here would be a message for a path that can't arrive; and the
 * shaped message below calls the path a folder, so it only fires once `isDirectory`
 * says it is one. What it does *not* claim is that the directory lists: the vault
 * does, but proving it means a `readdir` of a tree that could hold a hundred
 * thousand entries, to add a clause the user doesn't need.
 * @param {string} dir - A member directory, absolute and already checked reachable
 * @returns {string} Its canonical path
 */
export function resolveWalkRoot(dir) {
  try {
    return realpathSync.native(dir);
  } catch (error) {
    if (!isENOENT(error) || !isDirectory(dir)) {
      throw error;
    }
    throw new Error(
      `Can't back up '${dir}': the folder is there, but this computer ` +
        `won't say where it really is (resolving the path reports "no such file ` +
        `or directory").\n` +
        `Every file goes into a backup under its folder's resolved location, so a ` +
        `folder that won't resolve can't be backed up. This is usually a link into ` +
        `storage with no ordinary path of its own — a protected vault, or a drive ` +
        `with no letter or mount point.\n\n` +
        `Back up a folder that has an ordinary path instead. To see which folders a ` +
        `set backs up, and the file that lists them:\n` +
        `  ${shellCommand("s3cab list <set>")}`,
      { cause: error },
    );
  }
}

/**
 * Recursively list the files in one or more directories, dropping anything an
 * exclude pattern matches (patterns apply relative to *each* directory). A
 * directory's contents are accumulated into one list — the same line format
 * works across roots because snapshot paths are absolute.
 *
 * Every root is resolved before the first is walked, because a link under any
 * of them is judged against all of them (ADR-0099).
 * @param {string[]} dirs - Directories to walk
 * @param {string[]} patterns - Exclude glob patterns (guide/exclude.md)
 * @returns {WalkResult} What the walk found
 */
export function walkDirs(dirs, patterns) {
  const start = Temporal.Now.instant();
  const roots = dirs.map(resolveWalkRoot);

  /** @type {string[]} */
  const files = [];
  // Every path kept so far, across *all* roots — a file reached twice means the
  // set's member directories overlap (one nested under another). Checked as each
  // file arrives so an overlapping set fails at the first duplicate, not after a
  // full walk (minutes, on a big set).
  /** @type {Set<string>} */
  const seen = new Set();
  /** @type {Found} */
  const found = {
    excluded: [],
    links: [],
    errors: [],
    leadOut: [],
    unrepresentable: [],
    // No matcher means a root of `/`, which everything is under.
    inBackup: pathMatcher(roots) ?? (() => true),
  };

  for (const dir of roots) {
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

    const visit = createWalkCallbackFn(dir, patterns, found);
    // The walk is synchronous end to end, so the line's timer never fires
    // during it (ADR-0093): the clock is ticked from here instead. Per entry
    // *visited*, not per file kept — the callback sees every entry, excluded and
    // unsupported ones included, so a subtree the walk keeps nothing from still
    // moves the line, and that subtree is the stall `countedPass` exists for.
    /** @type {typeof visit} */
    const walkCallbackFn = (path, fileType) => {
      progress.tick();
      return visit(path, fileType);
    };

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
      // callback drops excluded entries and other types before yielding — so a
      // pattern in exclude.txt keeps its match from ever being refused, which is
      // what makes exclude.txt the escape hatch (ADR-0073).
      if (UNREPRESENTABLE_IN_TSV.test(path)) {
        found.unrepresentable.push(showControlChars(path));
      }
      files.push(path);
    }

    // This directory finished, so its line settles on the true total rather than
    // whatever the last redraw showed. Nothing is drawn from this loop: it used
    // to redraw per kept file, and the count froze whenever the walk went a
    // while without keeping one.
    progress.done();
  }

  // After the walk, so one failure names every offender, never truncated
  // (ADR-0010). ADR-0030 shape: the user's goal first, then the exact fix.
  const { unrepresentable, leadOut } = found;
  if (unrepresentable.length) {
    const count =
      unrepresentable.length === 1
        ? "This file can't"
        : `These ${formatCount(unrepresentable.length)} files can't`;
    throw new Error(
      `${count} be backed up, because the name, or a link's target, contains a ` +
        `tab or a line ending:\n` +
        unrepresentable.map((p) => `  ${p}`).join("\n") +
        `\nA snapshot is a table with one line per file and a tab between ` +
        `columns, so a name using either can't be written into it. ` +
        `Rename them, or leave them out by adding a pattern to the set's ` +
        `exclude file:\n` +
        `  odd*name.jpg`,
    );
  }

  // Listed one per line, never grouped: a grouped count of links is how an
  // unlocked Personal Vault's whole tree once went unnoticed (ADR-0099).
  if (leadOut.length) {
    const these =
      leadOut.length === 1
        ? "This link leads"
        : `These ${formatCount(leadOut.length)} links lead`;
    console.warn(
      `${these} outside the backup, so only the link is saved, not what it leads to:\n` +
        leadOut
          .map(
            ({ link, resolved }) =>
              `  ${link.path} → ${link.target}` +
              (resolved ? "" : "  (can't tell where it leads)"),
          )
          .join("\n") +
        `\nTo back up what a link leads to, add that folder to the set. To see ` +
        `which folders a set backs up, and the file that lists them:\n` +
        `  ${shellCommand("s3cab list <set>")}`,
    );
  }

  // The set's total, only when there is more than one member directory to add
  // up — for a single directory it would just restate the line above it.
  if (dirs.length > 1) {
    console.warn(
      `Found ${formatCount(files.length)} files in ${secondsSince(start)}`,
    );
  }

  const { excluded, links, errors } = found;
  return { files, excluded, links, errors };
}

/**
 * What the walk callback records as it goes, beyond the files it keeps.
 * @typedef {Object} Found
 * @property {ExclusionRecord[]} excluded
 * @property {LinkRecord[]} links
 * @property {WalkError[]} errors
 * @property {{ link: LinkRecord, resolved: boolean }[]} leadOut - Links whose target is outside every member directory, or can't be resolved
 * @property {string[]} unrepresentable - Entries the snapshot TSV cannot hold (ADR-0073), spelled out for the error. Collected rather than thrown on sight: the one person who ever hits this is the one whose script made hundreds of them, and fixing those an error at a time would be its own ordeal — the same reasoning as `assertWalkableDirs` listing every offender
 * @property {(path: string) => boolean} inBackup - Whether a canonical path is in or under a member directory
 */

/**
 * Create the walk callback: whether to keep an entry (a file to back up, or a
 * directory to descend into), recording everything else into `found` as data —
 * the walk doesn't know the snapshot grammar (`writeSnapshot` writes the rows).
 *
 * Takes the resolved type rather than the `Dirent` it came from: `walkFiles` has
 * already paid for it (possibly with an `lstat`), and asking the dirent again
 * here would read the *unresolved* answer — the bug `resolveFileType` exists to
 * fix.
 * @param {string} baseDir - Base directory
 * @param {string[]} patterns - Exclude patterns
 * @param {Found} found - Receives what isn't kept
 * @returns {(path: string, fileType: string | Error) => boolean} walk callback function
 */
function createWalkCallbackFn(baseDir, patterns, found) {
  const excludedBy = compileExcludePatterns(baseDir, patterns);

  return (path, fileType) => {
    if (Error.isError(fileType)) {
      // Vanished between listing and checking: there is nothing to record.
      if (!isENOENT(fileType)) {
        found.errors.push({ path, reason: fileType.message });
      }
      return false;
    }
    if (fileType === LINK) {
      recordLink(path, excludedBy, found);
      return false;
    }
    // A pipe, socket or device holds nothing to back up, and gets no row.
    if (fileType !== FILE && fileType !== DIRECTORY) {
      return false;
    }
    const isDir = fileType === DIRECTORY;
    const pattern = excludedBy(path, isDir);
    if (pattern) {
      found.excluded.push({ pattern, path, isDir });
      return false;
    }
    return true;
  };
}

/**
 * Why `stat` fails on a link that leads nowhere: its target is missing, or a
 * path through it isn't a folder, or the chain loops. Such a link loses
 * nothing, so it is recorded without a warning (ADR-0099).
 */
const BROKEN = new Set(["ENOENT", "ENOTDIR", "ELOOP"]);

/**
 * Record one link, never following it
 * ([ADR-0099](../../docs/adr/0099-links-recorded-never-followed.md)): a `link`
 * row, an `#excluded` one when a pattern matches, and a place in the warning
 * when its target is a file or folder outside every member directory or can't
 * be resolved.
 *
 * **`stat` before `realpath`, deliberately.** `realpathSync.native` throws
 * `ENOENT` both for a junction whose target is missing and for an unlocked
 * OneDrive Personal Vault, whose target is there but can't be canonicalized
 * (measured). Only `stat` tells the two apart, and reading both as "missing"
 * would drop the vault silently.
 * @param {string} path - The link's own path
 * @param {(path: string, isDir: boolean) => string | undefined} excludedBy
 * @param {Found} found
 */
function recordLink(path, excludedBy, found) {
  /** @type {string} */
  let target;
  try {
    target = readlinkSync(path);
  } catch (error) {
    if (!isENOENT(error)) {
      found.errors.push({
        path,
        reason: Error.isError(error) ? error.message : String(error),
      });
    }
    return;
  }

  /** @type {Stats | undefined} */
  let stats;
  let broken = false;
  try {
    stats = statSync(path);
  } catch (error) {
    broken = BROKEN.has(
      String(/** @type {NodeJS.ErrnoException} */ (error).code),
    );
  }

  const isDir = Boolean(stats?.isDirectory());
  const pattern = excludedBy(path, isDir);
  if (pattern) {
    found.excluded.push({ pattern, path, isDir });
    return;
  }
  // After the exclude check, which is the way past the refusal (ADR-0100).
  if (
    UNREPRESENTABLE_IN_TSV.test(path) ||
    UNREPRESENTABLE_IN_TSV.test(target)
  ) {
    found.unrepresentable.push(
      `${showControlChars(path)} → ${showControlChars(target)}`,
    );
    return;
  }

  const link = { path, target, isDir };
  found.links.push(link);
  if (broken) {
    return;
  }
  if (!stats) {
    found.leadOut.push({ link, resolved: false });
  } else if (stats.isFile() || isDir) {
    try {
      if (!found.inBackup(realpathSync.native(path))) {
        found.leadOut.push({ link, resolved: true });
      }
    } catch {
      found.leadOut.push({ link, resolved: false });
    }
  }
}

const FILE = "File";
const DIRECTORY = "Directory";
const LINK = "Link";
const OTHER = "Other";
/**
 * The type `readdir` reports for an entry it could not classify. It is a real
 * answer from some filesystems, not a corrupt one: the type simply doesn't
 * travel with the directory entry there (see `resolveFileType`).
 */
const UNKNOWN = "Unknown";

/**
 * Get the file type of a directory entry or a stat. Takes either because a
 * `Dirent` and a `Stats` answer the same questions — which is what lets
 * `resolveFileType` fall back from one to the other.
 * @param {Dirent | Stats} entry - Directory entry, or the stat of one
 * @returns {string} File type
 */
function getFileType(entry) {
  if (entry.isFile()) {
    return FILE;
  } else if (entry.isDirectory()) {
    return DIRECTORY;
  } else if (entry.isSymbolicLink()) {
    return LINK;
  } else if (
    entry.isBlockDevice() ||
    entry.isCharacterDevice() ||
    entry.isFIFO() ||
    entry.isSocket()
  ) {
    return OTHER;
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
 * tool least affords: an unclassified *directory* would never be descended into,
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
 * `lstat`, not `stat`, so a link stays a link: following one here would both
 * change what the walk records and open the door to cycles. An entry that can't
 * be stat-ed comes back as the error, for the callback to judge (ADR-0099:
 * vanished is no row, anything else an `#error`).
 * @param {Dirent} dirent - Directory entry
 * @param {string} path - Its resolved absolute path
 * @returns {string | Error} File type, or why it couldn't be checked
 */
function resolveFileType(dirent, path) {
  const fileType = getFileType(dirent);
  if (fileType !== UNKNOWN) {
    return fileType;
  }
  try {
    return getFileType(lstatSync(path));
  } catch (error) {
    return Error.isError(error) ? error : new Error(String(error));
  }
}

/**
 * Recursively walk through a directory and yield file paths. A folder that
 * can't be listed throws, stopping the walk (ADR-0098).
 *
 * The entry's type is resolved here, once, and passed down — see
 * `resolveFileType` for why it cannot be re-derived per consumer.
 * @param {string} dir - Directory to walk through
 * @param {(path: string, fileType: string | Error) => boolean} callbackFn - Whether to keep the entry
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

    if (fileType === DIRECTORY) {
      if (dirent.name === ".s3cab") {
        continue;
      }
      yield* walkFiles(path, callbackFn);
    } else {
      yield path;
    }
  }
}
