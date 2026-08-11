import { loadSet } from "../lib/env.mjs";
import { formatCount, plural } from "../lib/format.mjs";
import { tildeify } from "../lib/home.mjs";
import { walkSet } from "../lib/walk.mjs";

/** @import { ExclusionRecord } from "../lib/walk.mjs" */

/**
 * One entry the set's exclude patterns dropped, with the pattern that dropped
 * it. The walk's own `ExclusionRecord` calls that field `reason` because it
 * carries two different things (a pattern for `excluded`, a sentence for
 * `skipped`); by the time it reaches a user it is only ever a pattern, so it is
 * named one.
 * @typedef {{ path: string, pattern: string }} ExcludedEntry
 */

/**
 * List what a snapshot of `setName` would include — the `tree` command, and the
 * diagnostic answer to "exactly what is in this set". Resolves the set
 * (sole-set default, or an error listing the sets) and walks it.
 *
 * `--excluded` answers the inverse question from the same walk: *what are my
 * patterns dropping, and which pattern dropped it* — the one exclude question a
 * user had no way to ask, since `#EXCLUDED` snapshot rows are written but never
 * read back (`lib/snapshot-file.mjs`). It is computed from the directories
 * rather than from a snapshot on purpose: you can edit `exclude.txt` and re-run
 * to see the effect immediately, which reading a stored snapshot could never do.
 * That per-path pattern is also why there is no separate "why is *this* file
 * excluded?" flag — the answer is one `findstr`/`grep` away in this output.
 * @param {string} [setName] - Backup set to list (default: the only set)
 * @param {{ excluded?: boolean }} [options] - `excluded`: list what the patterns dropped instead
 * @returns {string[] | ExcludedEntry[]} File paths, or the excluded entries
 */
export function tree(setName, options = {}) {
  const set = loadSet(setName);
  const { files, excluded } = walkSet(set);

  if (!options.excluded) {
    return files;
  }

  reportExclusionTally(excluded, set.excludePath);
  return excluded.map(({ path, reason }) => ({ path, pattern: reason }));
}

/**
 * Summarize the exclusions on stderr, so the listing on stdout stays a clean
 * one-record-per-line stream to pipe or redirect (ADR-0010). The tally is what
 * makes this a *review* — "what is really going on" is answered by a dozen
 * lines of pattern → count, not by scrolling forty thousand paths — and it
 * mirrors the walk's own by-type skip notice rather than inventing a shape.
 *
 * The parenthetical only appears when a directory is among them, because that
 * is the one way the counts can mislead: the walk doesn't descend into an
 * excluded directory, so `node_modules` is a single record standing for
 * everything beneath it.
 * @param {ExclusionRecord[]} excluded
 * @param {string} excludePath - The set's `exclude.txt`, named when nothing matched
 */
function reportExclusionTally(excluded, excludePath) {
  if (!excluded.length) {
    // Without this the whole command is silent: an empty result renders to the
    // empty string, which is right for a pipe but reads as a broken run at a
    // terminal. Naming the file also separates "your patterns match nothing"
    // from "you have no patterns" without a second read of the file.
    console.warn(
      `Nothing was excluded — no file or directory matched a pattern in ` +
        `'${tildeify(excludePath)}'`,
    );
    return;
  }

  /** @type {Map<string, number>} */
  const byPattern = new Map();
  for (const { reason } of excluded) {
    byPattern.set(reason, (byPattern.get(reason) ?? 0) + 1);
  }
  // Biggest first — the pattern doing the most work is the one worth reviewing
  // — with the name as a tiebreak so the order is stable rather than walk-order.
  const rows = [...byPattern].sort(
    ([aPattern, aCount], [bPattern, bCount]) =>
      bCount - aCount || aPattern.localeCompare(bPattern),
  );
  const width = Math.max(...rows.map(([, count]) => formatCount(count).length));

  const containsDir = excluded.some(({ fileType }) => fileType === "Directory");
  console.warn(
    `Excluded ${formatCount(excluded.length)} ` +
      `${plural(excluded.length, "item")}` +
      `${containsDir ? " (a directory stands for everything inside it)" : ""}:`,
  );
  for (const [pattern, count] of rows) {
    console.warn(`  ${formatCount(count).padStart(width)}  ${pattern}`);
  }
}
