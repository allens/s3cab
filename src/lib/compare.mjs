import { basename, dirname } from "node:path";
import {
  listSnapshotNames,
  normalizeSnapshotName,
  readSnapshot,
} from "./snapshot-file.mjs";

/** @import { SnapshotEntries } from "./snapshot-file.mjs" */

/**
 * One added file. `duplicates` are the *existing* paths whose content this file
 * copies — `[]` means genuinely new; non-empty means a copy of content already
 * stored elsewhere (the renderer says "(duplicate of …)").
 * @typedef {Object} AddedEntry
 * @property {string} path - Absolute path of the added file
 * @property {number} size
 * @property {string[]} duplicates - Absolute paths this file duplicates
 */
/**
 * One moved/renamed file. `path` is the old location, `to` the new one; the
 * renderer derives "renamed" vs "moved" from whether the directory changed.
 * @typedef {Object} MovedEntry
 * @property {string} path - Absolute old location
 * @property {number} size
 * @property {string} to - Absolute new location
 */
/**
 * A path + its size — the uniform shape for `modified`/`deleted` (uniform
 * `{ path, … }` objects everywhere let the renderer share one loop, and future
 * fields don't break the contract).
 * @typedef {Object} PathSize
 * @property {string} path
 * @property {number} size
 */
/**
 * A file the newer snapshot couldn't hash: the absolute path and the recorded
 * error message.
 * @typedef {Object} CompareError
 * @property {string} path
 * @property {string} reason
 */
/**
 * Structured diff between two snapshots — **absolute paths throughout**
 * (ADR-0043). Path shortening is presentation, so it lives in the renderer
 * (`renderCompareResult`, which shortens against the common ancestor of `dirs`);
 * `--json` gets the unambiguous absolute paths. `since` is `null` for a first
 * snapshot (empty baseline). `setName`/`dirs`/`since`/`until` are metadata: the
 * renderer's header and self-describing `--json`.
 * @typedef {Object} CompareResult
 * @property {string} [setName]
 * @property {string[]} dirs
 * @property {string | null} since
 * @property {string} until
 * @property {AddedEntry[]} added
 * @property {MovedEntry[]} moved
 * @property {PathSize[]} modified
 * @property {PathSize[]} deleted
 * @property {CompareError[]} errors
 */

/**
 * Diff two snapshots from a snapshot directory, displaying paths relative to
 * `dirs` (the set's member directories). The engine behind the `compare`
 * command, reused by `snapshot` for its post-snapshot report.
 *
 * Naming a snapshot that doesn't exist is an error, never a silent empty
 * result. When `until` is the oldest snapshot (or the only one), the baseline
 * is empty and everything reports as added.
 *
 * The `since` side may arrive already parsed, as `{ name, entries }`:
 * `snapshot` reads the previous snapshot for its hash lookup anyway, and
 * handing the parse through here saves decompressing and re-parsing the same
 * baseline twice in one run (the hot-path rule: thread the data you already
 * have through the interface). The object pairs the name with its entries
 * structurally; a bare name is read from `snapshotDir` as before.
 * @param {string} snapshotDir - Directory holding the snapshot files
 * @param {string[]} dirs - The set's member directories (for path display)
 * @param {object} [options]
 * @param {string | { name: string, entries: SnapshotEntries }} [options.since] - Older snapshot to compare from (default: the one before `until`), optionally carrying its already-parsed entries
 * @param {string} [options.until] - Newer snapshot to compare to (default: latest)
 * @param {string} [options.setName] - The set's name, for the "no snapshots yet" guidance
 * @returns {Promise<CompareResult>} Diff results
 */
export async function compareSnapshots(snapshotDir, dirs, options = {}) {
  const snapshotNames = listSnapshotNames(snapshotDir);

  // Newer side (`until`) defaults to the latest snapshot.
  const until = normalizeSnapshotName(options.until) ?? snapshotNames.at(0);
  if (!until) {
    throw new Error(
      `No snapshots to compare yet for set '${options.setName}'.\n` +
        `Take one first with:\n  s3cab snapshot ${options.setName}`,
    );
  }
  const untilSnapshot = await readSnapshot(snapshotDir, until);

  // Older side (`since`) defaults to the snapshot immediately before `until`.
  let since;
  /** @type {SnapshotEntries | undefined} */
  let parsedEntries;
  if (typeof options.since === "object") {
    since = normalizeSnapshotName(options.since.name);
    parsedEntries = options.since.entries;
  } else {
    since = normalizeSnapshotName(options.since);
  }
  if (since === undefined) {
    const untilIndex = snapshotNames.indexOf(until);
    if (untilIndex === -1) {
      // `until` may still be a readable file outside the listed snapshots
      // (e.g. a debug .tsv) — but then it has no well-defined predecessor.
      throw new Error(
        `Snapshot '${until}' is not in the snapshot list; use --since to pick the older side`,
      );
    }
    since = snapshotNames.at(untilIndex + 1); // undefined when `until` is the oldest
  }

  /** @type {SnapshotEntries} */
  let sinceEntries;
  /** @type {string | undefined} */
  let sinceInstant;
  if (since === undefined) {
    // Nothing older than `until`: an empty baseline; everything is "added".
    sinceEntries = new Map();
  } else if (parsedEntries) {
    sinceEntries = parsedEntries;
  } else {
    const sinceSnapshot = await readSnapshot(snapshotDir, since);
    sinceEntries = sinceSnapshot.entries;
    sinceInstant = sinceSnapshot.instant;
  }
  console.warn(
    "Comparing",
    since ? `'${since}'` : "(nothing)",
    "→",
    `'${until}'`,
  );
  warnIfOutOfOrder(since, sinceInstant, until, untilSnapshot.instant);

  const { added, moved, modified, deleted } = diff(
    sinceEntries,
    untilSnapshot.entries,
  );

  // A file the `until` snapshot couldn't hash parses into `errors`, not
  // `entries`, so `diff` never sees it. Report those paths under their own
  // category, and pull any out of `deleted`: a path present in the older
  // snapshot that errored in the newer one is not a deletion, just unreadable.
  for (const path of untilSnapshot.errors.keys()) {
    deleted.delete(path);
  }

  // Size is looked up from the snapshot entries rather than threaded through
  // `diff` (which is content/path-only): the current file for added/moved/
  // modified (its size in `until`), the vanished file for deleted (its size in
  // `since`). Same content ⇒ same size, so a move reads either side equally.
  const untilEntries = untilSnapshot.entries;
  return {
    setName: options.setName,
    dirs,
    since: since ?? null,
    until,
    added: Array.from(added, ([path, duplicates]) => ({
      path,
      size: untilEntries.get(path)?.size ?? 0,
      duplicates: Array.from(duplicates),
    })),
    moved: Array.from(moved, ([path, to]) => ({
      path,
      size: untilEntries.get(to)?.size ?? 0,
      to,
    })),
    modified: Array.from(modified, (path) => ({
      path,
      size: untilEntries.get(path)?.size ?? 0,
    })),
    deleted: Array.from(deleted, (path) => ({
      path,
      size: sinceEntries.get(path)?.size ?? 0,
    })),
    errors: Array.from(untilSnapshot.errors, ([path, reason]) => ({
      path,
      reason,
    })),
  };
}

/** @typedef {Set<string>} PathSet */
/** @typedef {Map<string, string>} PathFromToLookup */
/** @typedef {Map<string, PathSet>} PathDuplicatesLookup */

/**
 * @typedef {Object} DiffResult
 * @property {PathDuplicatesLookup} added
 * @property {PathFromToLookup} moved
 * @property {PathSet} modified
 * @property {PathSet} deleted
 */

/**
 * Create a lookup of hash to set of paths.
 * @param {SnapshotEntries} snapshotLookup - Snapshot lookup
 * @returns {Map<string,PathSet>} Hash to path set lookup
 */
function getPathsByHash(snapshotLookup) {
  /** @type {Map<string,PathSet>} */
  const hashLookup = new Map();

  snapshotLookup.forEach(({ hash }, path) => {
    hashLookup.getOrInsertComputed(hash, () => new Set()).add(path);
  });

  return hashLookup;
}

/**
 * Diff two snapshots. Neither input is modified.
 *
 * Classification rules (each pinned by a test in compare.test.mjs; the
 * user-facing guide is guide/compare.md):
 * - Same path in both snapshots → `modified` when the hash differs; silently
 *   unchanged when it matches. The hash is the only signal — size/mtime are
 *   ignored, so a touch never reports as a change.
 * - Path only in the previous snapshot → `deleted`, unless claimed as a move
 *   source below.
 * - Path only in the current snapshot → `moved` when a *deleted* path with
 *   the same hash exists, otherwise `added`. Move pairing prefers same
 *   basename, then same parent directory, then any candidate (greedy — see
 *   the comment at the pairing).
 * - Only deleted paths can be move sources: rotation/copy-then-edit reports
 *   as modified plus an annotated copy, and swapped contents report as two
 *   modifications — never as moves of paths that still exist.
 * - `added` entries carry the previous-snapshot paths that held the same
 *   content; when all of those were claimed as move sources, the moved-to
 *   locations are reported instead.
 * - Files that failed hashing are not entries — they parse into the snapshot's
 *   `errors` map, not `currentSnapshot` — so `diff` never sees them.
 *   `compareSnapshots` reports them under its own `errors` category and keeps
 *   them out of `deleted`.
 * @param {SnapshotEntries} previousSnapshot - Previous snapshot lookup
 * @param {SnapshotEntries} currentSnapshot - Current snapshot
 * @returns {DiffResult} Diff results
 */
export function diff(previousSnapshot, currentSnapshot) {
  /** @type {PathDuplicatesLookup} */ // new paths - mapped to matching paths in previous snapshot
  const added = new Map();

  /** @type {PathFromToLookup} */ // from to path
  const moved = new Map();

  /** @type {PathSet} */ // modified paths - files that have changed
  const modified = new Set();

  /** @type {PathSet} */
  const deleted = new Set();

  const previousPathsByHash = getPathsByHash(previousSnapshot);

  // Paths only in the current snapshot; both-side paths are settled first.
  const currentOnly = new Map(currentSnapshot);

  previousSnapshot.forEach(({ hash }, path) => {
    const currentProps = currentOnly.get(path);
    if (currentProps) {
      currentOnly.delete(path);
      if (currentProps.hash !== hash) {
        modified.add(path);
      }
    } else {
      deleted.add(path);
    }
  });

  // Phase two: what's left in currentOnly is the added paths — classify each as
  // genuinely new, a move/rename, or a copy.
  for (const [addedPath, { hash }] of currentOnly) {
    const previousPathSetForHash = previousPathsByHash.get(hash);

    if (previousPathSetForHash) {
      const sources = Array.from(previousPathSetForHash).filter((path) =>
        deleted.has(path),
      );
      const [firstSource] = sources;

      if (firstSource) {
        // moved! Pair greedily: same basename, then same parent dir, then
        // any. Greedy in iteration order, not a globally optimal matching —
        // an early added path can take a later one's better-matching source.
        // Accepted: with identical content the pairing is display-only; the
        // stored objects are the same either way.
        const source =
          sources.find((path) => basename(path) === basename(addedPath)) ??
          sources.find((path) => dirname(path) === dirname(addedPath)) ??
          firstSource;
        deleted.delete(source);
        moved.set(source, addedPath);
        // No lookup cleanup is needed here (an old parked question): a
        // claimed source can't be re-claimed, since `sources` only accepts
        // paths still in `deleted` — and the copy annotations below subtract
        // the `moved` keys instead, keeping previousPathSetForHash intact.
      } else {
        // Set.difference treats the `moved` Map as set-like: its keys are the
        // moved-from paths, which is exactly what to subtract here.
        let sameContentPaths = previousPathSetForHash.difference(moved);
        if (sameContentPaths.size === 0) {
          // Every previous holder of this content was claimed as a move
          // source — point at where the content lives now instead, so a copy
          // is never mistaken for brand-new content. (No holder can still be
          // in `deleted` here, else this path would have claimed it as a
          // move; the filter only narrows the type.)
          sameContentPaths = new Set(
            Array.from(previousPathSetForHash, (path) =>
              moved.get(path),
            ).filter((path) => path !== undefined),
          );
        }
        added.set(addedPath, sameContentPaths);
      }
    } else {
      added.set(addedPath, new Set());
    }
  }

  return {
    added,
    moved,
    modified,
    deleted,
  };
}

/**
 * Warn when the two sides are in the opposite order to the one their names imply
 * — check B of [ADR-0072](../../docs/adr/0072-timestamps-utc-in-files-local-in-names.md).
 *
 * `since` defaults to whatever sorts just below `until`, and that sort is over
 * *names*, which are local wall clock. In the hour the clocks go back, or across
 * a time-zone move, the older-looking name can be the newer snapshot — and the
 * diff would then read backwards with nothing to say so: additions shown as
 * deletions, and the other way round.
 *
 * Compares the recorded instants, so it is certain rather than a guess, and says
 * nothing when it cannot be certain: either side may predate ADR-0072 and carry
 * no instant, and `snapshot`'s fused fast path hands its baseline over as
 * pre-parsed entries with no header at all. That path is already covered where
 * the fault is *created*, by the clock-went-backwards warning in
 * `generateSnapshot`.
 * @param {string | undefined} since
 * @param {string | undefined} sinceInstant
 * @param {string} until
 * @param {string | undefined} untilInstant
 */
function warnIfOutOfOrder(since, sinceInstant, until, untilInstant) {
  if (
    !since ||
    !sinceInstant ||
    !untilInstant ||
    Temporal.Instant.compare(sinceInstant, untilInstant) <= 0
  ) {
    return;
  }
  console.warn(
    `'${since}' was actually taken after '${until}', even though its name ` +
      `sorts earlier — the computer's clock had gone back when one of them was ` +
      `taken (daylight saving, or a different time zone).\n` +
      `This comparison therefore reads backwards: what it calls added was ` +
      `removed, and the other way round. Swap --since and --until to read it ` +
      `the right way round.`,
  );
}
