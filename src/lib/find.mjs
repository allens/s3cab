import { posix, sep } from "node:path";
import { stderr } from "node:process";

import { ValidationError, errorText } from "./error.mjs";
import { globSource, isWindowsPath } from "./path-match.mjs";
import { countedPass } from "./progress.mjs";
import { isCorruptSnapshotError } from "./referenced.mjs";
import { listSnapshotNames, readSnapshot } from "./snapshot-file.mjs";

/** @import { BackupSet } from "./sets.mjs" */
/** @import { Snapshot } from "./snapshot-file.mjs" */

// Searching local snapshot history for a path, and reporting the *objects* that
// back it — the read-only half of removing a file from a backup
// ([ADR-0088](../../docs/adr/0088-find-matches-like-posix-find.md)).
//
// Two things here are worth knowing before reading the code.
//
// **Matching follows POSIX `find`, not `exclude`.** The token grammar is shared
// (`globSource`); the anchoring is not. An exclude pattern describes a whole
// absolute path because it prunes a subtree; a find pattern names a file, so a
// pattern with no separator matches the *basename* and one with a separator
// floats over the path. The ADR argues it; `compileFindPattern` implements it.
//
// **The scan is two passes over the same snapshots, deliberately.** Pass 1 finds
// the paths and their hashes — a handful. Pass 2 asks the reverse question of
// exactly those hashes: what *else* do they back? Answering both in one pass
// would mean holding a hash→paths map for every row in history (tens of millions
// on a long-lived set); two passes stay bounded by the tiny hash set, at the cost
// of decompressing each snapshot twice. Pass 2 is skipped entirely when pass 1
// found nothing.

/**
 * One snapshot path, prepared once for matching against every pattern.
 * @typedef {Object} Candidate
 * @property {string} path - Separators normalized to `/` (Windows paths only)
 * @property {string} base - Its last segment
 * @property {boolean} windows - Windows-shaped, so matching folds case
 */

/**
 * One compiled pattern: the text the user typed (kept for the report) and the
 * test it compiled to.
 * @typedef {Object} FindMatcher
 * @property {string} pattern
 * @property {(candidate: Candidate) => boolean} test
 */

/**
 * A run of consecutive snapshots in one set that all record this path at this
 * hash. `count === 1` means `first === last` — one snapshot, not a range.
 * @typedef {Object} FindSpan
 * @property {string} set
 * @property {string} first - Oldest snapshot in the run
 * @property {string} last - Newest snapshot in the run
 * @property {number} count
 */

/**
 * One object (content hash) found under a matched path: what it weighs, when the
 * file was last modified, which snapshots record it, and what *else* it backs.
 * @typedef {Object} FindObject
 * @property {string} hash
 * @property {number} size
 * @property {string} mtime - As the newest snapshot recording it stored it
 * @property {FindSpan[]} spans - Oldest first, and set by set in search order
 * @property {string[]} alsoBacks - Other paths this content is stored under, sorted
 */

/**
 * One matched path and the objects stored under it — more than one when the file
 * changed content over the history searched.
 * @typedef {Object} FindFile
 * @property {string} path
 * @property {FindObject[]} objects - Newest version first
 */

/**
 * A set that was searched, named in the report so the output says what "not
 * found" was not found in — and which bucket a hash would be deleted from.
 * @typedef {Object} SearchedSet
 * @property {string} name
 * @property {string} bucket
 * @property {number} snapshots
 */

/**
 * A snapshot that would not read. A finding, not a fatal error: the rest of
 * history is still worth searching, and the report says what went unsearched
 * rather than quietly returning less (the same stance `verify` takes, ADR-0074).
 * @typedef {Object} UnreadableSnapshot
 * @property {string} set
 * @property {string} snapshot
 * @property {string} reason
 */

/**
 * @typedef {Object} FindResult
 * @property {string[]} patterns - As the user typed them
 * @property {SearchedSet[]} searched
 * @property {FindFile[]} files - Sorted by path
 * @property {UnreadableSnapshot[]} unreadable
 */

/**
 * Compile one find pattern into a matcher.
 *
 * The anchoring, which is the whole difference from `compileExclude`
 * ([ADR-0088](../../docs/adr/0088-find-matches-like-posix-find.md)):
 *
 * - **No separator** → match the **basename**. `junkfile.dat` finds that file
 *   wherever it lived; `*.jpg` finds every JPEG.
 * - **A separator** → match the **full path, floating**: an implicit `**` on the
 *   front, so `secretsdir/secret1` finds `C:\Users\me\secretsdir\secret1` without
 *   the user typing the part of the path they don't remember.
 * - **A trailing separator** → everything *beneath* that directory. Snapshots
 *   have no directory rows, so this is the only way to name a subtree, and it
 *   matches paths — never the directory itself.
 *
 * **Separators in the *pattern* key on `process.platform`; case in the *path*
 * keys on the path's shape.** They are different questions with different right
 * answers: the pattern was typed at this machine's shell, so a Windows user
 * typing `secretsdir\secret1` means a separator; the path came out of a snapshot
 * that may have been taken on another OS entirely, so only its own shape can say
 * whether its case matters (`isWindowsPath`). The consequence is a POSIX
 * filename containing a literal backslash can't be named by a pattern — a wart
 * worth the two rules being independently correct.
 * @param {string} pattern - As the user typed it
 * @returns {FindMatcher}
 * @throws {ValidationError} On a pattern with nothing in it to match
 */
export function compileFindPattern(pattern) {
  const slashed = pattern.split(sep).join(posix.sep);
  const directory = slashed.endsWith(posix.sep);
  const body = directory ? slashed.slice(0, -1) : slashed;

  if (body === "") {
    throw new ValidationError(
      `There's nothing to search for in the pattern '${pattern}'. Give a file ` +
        `name, a path fragment, or a directory to search beneath:\n\n` +
        `    s3cab find secrets/`,
    );
  }

  // A separator anywhere — including the trailing one just stripped — switches
  // from basename matching to a floating whole-path match.
  const normalized = posix.normalize(body);
  const wholePath = directory || normalized.includes(posix.sep);
  const source = globSource(normalized);
  const anchored = wholePath
    ? `^(?:.*/)?${source}${directory ? "/.*" : ""}$`
    : `^${source}$`;

  // Two compilations of one source, chosen per path rather than per run: a
  // machine can hold snapshots from both kinds of filesystem, so the fold is a
  // property of the path being tested, not of this process.
  const sensitive = new RegExp(anchored);
  const folded = new RegExp(anchored, "i");

  return {
    pattern,
    test: (candidate) =>
      (candidate.windows ? folded : sensitive).test(
        wholePath ? candidate.path : candidate.base,
      ),
  };
}

/**
 * Derive the two forms a snapshot path is matched in. Called once per row of
 * every snapshot in history, so it does the least it can: the basename is cut
 * from the original string (no allocation), and the `/`-separated form is built
 * only for a Windows path, since a POSIX one already is one.
 *
 * Which separators count is again the path's own shape — on POSIX a backslash is
 * an ordinary character in a filename, and cutting the basename at one would
 * name a file that doesn't exist.
 * @param {string} path - An absolute path, as a snapshot records it
 * @returns {Candidate}
 */
export function prepare(path) {
  const windows = isWindowsPath(path);
  const cut = windows
    ? Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"))
    : path.lastIndexOf("/");
  return {
    path: windows ? path.replaceAll("\\", posix.sep) : path,
    base: path.slice(cut + 1),
    windows,
  };
}

/**
 * Collapse one path+hash's snapshot occurrences into spans: a run of
 * *consecutive* snapshots becomes one entry, so a file nobody touched for five
 * years reads as a range rather than 900 identical lines. A gap — the file
 * absent, or at different content, in an intervening snapshot — breaks the run,
 * which is the point: the ranges are then a true history of when the content was
 * there.
 *
 * `all` turns collapsing off, yielding one span per snapshot. That is a change to
 * the **data**, not to how it is rendered, so `--json` needs no flag saying which
 * form it got — the spans describe themselves.
 * @param {string} setName
 * @param {number[]} indices - Snapshot positions, oldest first
 * @param {string[]} names - The set's snapshot names, oldest first
 * @param {boolean} all - One span per snapshot instead of one per run
 * @returns {FindSpan[]}
 */
function collapse(setName, indices, names, all) {
  /** @type {FindSpan[]} */
  const spans = [];
  let previousIndex = -1;
  for (const index of indices) {
    const name = names[index] ?? "";
    const previous = spans.at(-1);
    if (!all && previous && index === previousIndex + 1) {
      previous.last = name;
      previous.count++;
    } else {
      spans.push({ set: setName, first: name, last: name, count: 1 });
    }
    previousIndex = index;
  }
  return spans;
}

/**
 * Read one snapshot, treating damage as a finding rather than an error. A
 * corrupt local snapshot must not abort a search across the other 900 — but it
 * must not vanish either, because an unsearched snapshot could be the one
 * holding the file. Anything that is *not* snapshot damage (a permissions
 * failure, a disk error) is rethrown and ends the run.
 * @param {BackupSet} set
 * @param {string} name
 * @param {Map<string, UnreadableSnapshot>} unreadable - Recorded into, keyed `<set>/<snapshot>`
 * @returns {Promise<Snapshot | undefined>}
 */
async function readOrRecord(set, name, unreadable) {
  try {
    return await readSnapshot(set.snapshotsDir, name);
  } catch (error) {
    if (!isCorruptSnapshotError(error)) {
      throw error;
    }
    unreadable.set(`${set.name}/${name}`, {
      set: set.name,
      snapshot: name,
      reason: errorText(error),
    });
    return undefined;
  }
}

/**
 * Search the given sets' local snapshots for paths matching any of `patterns`,
 * and report the objects that back them.
 *
 * Local only, and it costs zero S3 calls: `reattach` pulls a set's entire
 * snapshot history down precisely so the browse commands need not each grow a
 * remote variant ([ADR-0027](../../docs/adr/0027-compare-local-only-adoption-syncs-manifests.md)).
 *
 * The result is the whole report — including the sets searched and any snapshot
 * that would not read — so the renderer can say what was looked at, not just
 * what was found (ADR-0043: the command returns data, the render layer prints).
 * @param {BackupSet[]} sets - The sets to search, in the order they are reported
 * @param {string[]} patterns - Find patterns, as the user typed them
 * @param {object} [options]
 * @param {boolean} [options.all] - One entry per snapshot instead of collapsed ranges
 * @returns {Promise<FindResult>}
 */
export async function findInSnapshots(sets, patterns, { all = false } = {}) {
  const matchers = patterns.map(compileFindPattern);

  /** @type {Map<string, UnreadableSnapshot>} */
  const unreadable = new Map();
  /** @type {SearchedSet[]} */
  const searched = [];
  /**
   * Every match, path first because the report is path-first: path → hash →
   * where it was seen. Small — the whole point of pass 2 existing separately.
   * @type {Map<string, Map<string, { size: number, mtime: string, indices: Map<string, number[]> }>>}
   */
  const matched = new Map();
  /** @type {Map<string, string[]>} Set name → its snapshot names, oldest first */
  const namesBySet = new Map();

  let read = 0;
  {
    using progress = countedPass(stderr, "Searching snapshots…", () => read);
    for (const set of sets) {
      // Oldest first, so a snapshot's position in this array is its position in
      // history — which is what makes a run of consecutive positions a range.
      const names = listSnapshotNames(set.snapshotsDir).toReversed();
      namesBySet.set(set.name, names);
      searched.push({
        name: set.name,
        bucket: set.bucket,
        snapshots: names.length,
      });

      for (const [index, name] of names.entries()) {
        const snapshot = await readOrRecord(set, name, unreadable);
        read++;
        if (!snapshot) {
          continue;
        }
        for (const [path, props] of snapshot.entries) {
          const candidate = prepare(path);
          if (!matchers.some((matcher) => matcher.test(candidate))) {
            continue;
          }
          let byHash = matched.get(path);
          if (!byHash) {
            byHash = new Map();
            matched.set(path, byHash);
          }
          let record = byHash.get(props.hash);
          if (!record) {
            record = {
              size: props.size,
              mtime: props.mtime,
              indices: new Map(),
            };
            byHash.set(props.hash, record);
          }
          // Newest wins: snapshots are read oldest first, so the last write is
          // the most recent thing the history knows about this content.
          record.mtime = props.mtime;
          let indices = record.indices.get(set.name);
          if (!indices) {
            indices = [];
            record.indices.set(set.name, indices);
          }
          indices.push(index);
        }
      }
    }
    progress.done();
  }

  const hashes = new Set(
    [...matched.values()].flatMap((byHash) => [...byHash.keys()]),
  );
  const alsoBacks = await otherPaths(sets, hashes, new Set(matched.keys()), {
    unreadable,
  });

  const files = [...matched]
    .map(([path, byHash]) => ({
      path,
      objects: [...byHash]
        .map(([hash, { size, mtime, indices }]) => ({
          hash,
          size,
          mtime,
          spans: [...indices].flatMap(([setName, positions]) =>
            collapse(setName, positions, namesBySet.get(setName) ?? [], all),
          ),
          alsoBacks: [...(alsoBacks.get(hash) ?? [])].sort((a, b) =>
            a.localeCompare(b),
          ),
        }))
        // Newest version of the path first: the objects under one path are what
        // it held over time, and that is the order a reader is looking for.
        // Hash breaks the tie so the order is total (two versions can share an
        // mtime — a restore writes the recorded one).
        .sort(
          (a, b) =>
            b.mtime.localeCompare(a.mtime) || a.hash.localeCompare(b.hash),
        ),
    }))
    .sort((a, b) => a.path.localeCompare(b.path));

  return {
    patterns,
    searched,
    files,
    unreadable: [...unreadable.values()],
  };
}

/**
 * Pass 2: what *else* do these hashes back? Re-scans the same snapshots asking
 * the reverse question of the small hash set pass 1 produced, and collects every
 * path that is not itself a match.
 *
 * This is the dedup warning — content-addressable storage means deleting an
 * object removes every file stored under that content, and a user who searched
 * for one path deserves to know before they act.
 *
 * Returns immediately on an empty hash set: nothing found means nothing to warn
 * about, and re-reading all of history to prove it would double the cost of the
 * commonest search of all.
 * @param {BackupSet[]} sets
 * @param {Set<string>} hashes - The hashes pass 1 matched
 * @param {Set<string>} matchedPaths - Paths that matched, excluded from the answer
 * @param {object} context
 * @param {Map<string, UnreadableSnapshot>} context.unreadable - Snapshots pass 1 could not read, skipped rather than re-reported
 * @returns {Promise<Map<string, Set<string>>>} Hash → the other paths it backs
 */
async function otherPaths(sets, hashes, matchedPaths, { unreadable }) {
  /** @type {Map<string, Set<string>>} */
  const found = new Map();
  if (hashes.size === 0) {
    return found;
  }

  let read = 0;
  using progress = countedPass(
    stderr,
    "Checking what else those objects back…",
    () => read,
  );
  for (const set of sets) {
    for (const name of listSnapshotNames(set.snapshotsDir)) {
      if (unreadable.has(`${set.name}/${name}`)) {
        continue;
      }
      const snapshot = await readOrRecord(set, name, unreadable);
      read++;
      if (!snapshot) {
        continue;
      }
      for (const [path, props] of snapshot.entries) {
        if (!hashes.has(props.hash) || matchedPaths.has(path)) {
          continue;
        }
        let paths = found.get(props.hash);
        if (!paths) {
          paths = new Set();
          found.set(props.hash, paths);
        }
        paths.add(path);
      }
    }
  }
  progress.done();
  return found;
}
