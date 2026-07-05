// The central render layer (ADR-0043): command functions return pure data, and
// the *presentation* of that data — human-readable text on stdout — lives here.
// Each renderer takes a command's result and returns a finished string; the
// dispatcher (s3cab.mjs) owns the stream, the `--json` toggle, and the colour
// gate, calling the renderer only for the human path. Routing is by registry
// reference (`render` on each command in commands.mjs), which keeps machine
// output free of presentation fields and lets same-typed commands (snapshot +
// compare) share one renderer.
//
// Renderer bodies compose the primitives in lib/format.mjs and the colourisers
// in lib/style.mjs; a renderer never prints (it returns), and never truncates
// (ADR-0043 — the user manages volume with a pager or redirect).

import { homedir } from "node:os";
import { dirname, relative, sep } from "node:path";
import { formatByteValue } from "./lib/format.mjs";
import { bold, cyan, green, red, yellow } from "./lib/style.mjs";

/** @import { BackupSet } from "./lib/sets.mjs" */
/**
 * @import {
 *   CompareResult, AddedEntry, MovedEntry, PathSize, CompareError,
 * } from "./lib/compare.mjs"
 */

/**
 * The context the dispatcher threads into every renderer. The dispatcher owns
 * the stdout TTY/colour gate (`styleEnabled`, ADR-0043); a renderer only reads
 * this flag to decide whether to emit ANSI style, never re-checks the stream.
 * @typedef {Object} RenderContext
 * @property {boolean} [color] - Whether ANSI colour/style may be emitted (the dispatcher always sets it; renderers default it off when called bare, e.g. in tests)
 */

/**
 * Confirm a `setup` (create / update / inherit) by echoing the set's resulting
 * state. The renderer is mode-neutral by necessity: ADR-0043 keeps the command
 * a pure data returner, so it returns only the stored `BackupSet` and can't say
 * which mode ran — and it needn't, since the confirmation someone wants is
 * "what is this set now". The mode-specific guidance (the starter-exclude
 * notice, inherit's snapshot-pull summary) already went to stderr from inside
 * the command.
 * @param {BackupSet} set
 * @returns {string}
 */
export function renderSetup(set) {
  const dirs = set.dirs.length
    ? set.dirs.map((dir) => `  ${dir}`).join("\n")
    : "  (no directories yet — add them with 's3cab setup " +
      `${set.name} <directory>...')`;
  return `Set '${set.name}' → bucket '${set.bucket}'\n${dirs}`;
}

/**
 * Render a `compare`/`snapshot` diff — the shared renderer both point at, since
 * they return the same `CompareResult` (ADR-0043). Fixed section order, only
 * non-empty sections shown, a count in each header, and a closing summary line.
 * Paths are stored absolute; this shortens them against the common-ancestor
 * directory of the set's member dirs (one unambiguous base, shown in the
 * header), which unifies single- and multi-root and degrades to absolute when
 * the roots share no base (e.g. different Windows drives). A first snapshot
 * (`since === null`) collapses its all-added listing to a one-line count — every
 * file is "added" against an empty baseline, so the list carries no diff signal
 * (`--json`/`tree` still enumerate everything).
 * @param {CompareResult} result
 * @param {RenderContext} [context]
 * @returns {string}
 */
export function renderCompareResult(result, { color = false } = {}) {
  const base = commonAncestor(result.dirs);
  /** @param {string} path */
  const shorten = (path) => (base ? relative(base, path) : path);
  /** Apply a colouriser only when colour is enabled (headers only). */
  const paint =
    /** @param {(text: string) => string} colourise */
    (colourise) =>
      /** @param {string} text */
      (text) => (color ? colourise(text) : text);

  const head = header(result, base);

  if (result.since === null) {
    // First snapshot: collapse the whole listing to a count + total size.
    const files = result.added.length;
    const bytes = sumSize(result.added);
    const line = `First snapshot: ${count(files)} ${plural(files, "file")} (${formatByteValue(bytes)})`;
    const parts = [head, line];
    if (result.errors.length) {
      parts.push(errorSection(result.errors, shorten, paint));
    }
    return parts.join("\n\n");
  }

  // The data carries one `moved` category; the human view splits it — a rename
  // (same directory, name changed) and a move (to a different directory) are
  // meaningfully different events to a person, so they get their own sections
  // (build spec / ADR-0043). Ordered by escalating impact: rename (cosmetic) →
  // move → modify (content changed) → delete. `Object.groupBy` buckets by key;
  // an empty bucket is absent from the result, so the `= []` defaults matter.
  const { rename: renamed = [], move: moved = [] } = Object.groupBy(
    result.moved,
    (entry) => (dirname(entry.path) === dirname(entry.to) ? "rename" : "move"),
  );

  const sections = [];
  if (result.added.length) {
    sections.push(addedSection(result.added, shorten, paint));
  }
  if (renamed.length) {
    sections.push(fromToSection("Renamed", renamed, cyan, shorten, paint));
  }
  if (moved.length) {
    sections.push(fromToSection("Moved", moved, cyan, shorten, paint));
  }
  if (result.modified.length) {
    sections.push(
      pathSection("Modified", result.modified, yellow, shorten, paint),
    );
  }
  if (result.deleted.length) {
    sections.push(pathSection("Deleted", result.deleted, red, shorten, paint));
  }
  if (result.errors.length) {
    sections.push(errorSection(result.errors, shorten, paint));
  }

  const summary = summaryLine(result, renamed.length, moved.length);
  return [head, ...sections, summary].join("\n\n");
}

/**
 * The report header: `<set>: <base>  <since> → <until>` — the set name, the
 * common-ancestor base (home-shortened to `~`), and the compared range. Parts
 * absent (no set name, no common base, a first snapshot) are dropped rather than
 * printed empty.
 * @param {CompareResult} result
 * @param {string | undefined} base
 * @returns {string}
 */
function header(result, base) {
  const name = result.setName ? `${result.setName}: ` : "";
  const loc = base ? `${tildeify(base)}  ` : "";
  const range = result.since
    ? `${result.since} → ${result.until}`
    : result.until;
  return `${name}${loc}${range}`;
}

/**
 * The longest common ancestor *directory* of the member dirs, computed
 * segment-wise (not by string prefix, which would wrongly pair `/a/bc` with
 * `/a/bd`). `undefined` when there is none (empty set, or roots on different
 * drives) — the caller then shows absolute paths.
 * @param {string[]} dirs
 * @returns {string | undefined}
 */
function commonAncestor(dirs) {
  if (dirs.length === 0) {
    return undefined;
  }
  const parts = dirs.map((dir) => dir.split(sep));
  const first = parts[0];
  if (!first) {
    return undefined;
  }
  let i = 0;
  while (i < first.length && parts.every((other) => other[i] === first[i])) {
    i++;
  }
  // No shared leading segment (e.g. different Windows drives) → no base; the
  // caller shows absolute paths.
  if (i === 0) {
    return undefined;
  }
  const base = first.slice(0, i).join(sep);
  // A base that is exactly a root/drive component isn't a usable directory for
  // `path.relative`: `""` (POSIX root) and `"C:"` (a bare drive — *cwd*-relative,
  // not the drive root) both need the separator re-appended to become the real
  // root (`/`, `C:\`). An exotic cross-UNC-share base degrades to near-absolute
  // — not worth hand-parsing UNC (minimal-code pillar).
  return base === "" || /^[A-Za-z]:$/.test(base) ? base + sep : base;
}

/**
 * Shorten a home-directory path to a leading `~` for the header (display only).
 * @param {string} path
 * @returns {string}
 */
function tildeify(path) {
  const home = homedir();
  if (path === home) {
    return "~";
  }
  return path.startsWith(home + sep) ? `~${path.slice(home.length)}` : path;
}

/**
 * @param {AddedEntry[]} added
 * @param {(path: string) => string} shorten
 * @param {(colourise: (t: string) => string) => (t: string) => string} paint
 */
function addedSection(added, shorten, paint) {
  const lines = added.map((entry) => {
    const dupes = entry.duplicates.length
      ? `  (duplicate of ${entry.duplicates.map(shorten).join(", ")})`
      : "";
    return `  ${shorten(entry.path)}${dupes}`;
  });
  return `${paint(green)(`Added (${added.length})`)}\n${lines.join("\n")}`;
}

/**
 * A `from → to` section — shared by Renamed and Moved (same shape, different
 * label; the rename/move split by directory happens in the caller, via
 * `Object.groupBy`).
 * @param {string} label
 * @param {MovedEntry[]} entries
 * @param {(text: string) => string} colour
 * @param {(path: string) => string} shorten
 * @param {(colourise: (t: string) => string) => (t: string) => string} paint
 */
function fromToSection(label, entries, colour, shorten, paint) {
  const lines = entries.map(
    (entry) => `  ${shorten(entry.path)} → ${shorten(entry.to)}`,
  );
  return `${paint(colour)(`${label} (${entries.length})`)}\n${lines.join("\n")}`;
}

/**
 * The uniform `{ path }` sections — Modified, Deleted.
 * @param {string} label
 * @param {PathSize[]} entries
 * @param {(text: string) => string} colour
 * @param {(path: string) => string} shorten
 * @param {(colourise: (t: string) => string) => (t: string) => string} paint
 */
function pathSection(label, entries, colour, shorten, paint) {
  const lines = entries.map((entry) => `  ${shorten(entry.path)}`);
  return `${paint(colour)(`${label} (${entries.length})`)}\n${lines.join("\n")}`;
}

/**
 * @param {CompareError[]} errors
 * @param {(path: string) => string} shorten
 * @param {(colourise: (t: string) => string) => (t: string) => string} paint
 */
function errorSection(errors, shorten, paint) {
  const lines = errors.map(
    (entry) => `  ${shorten(entry.path)}  (${entry.reason})`,
  );
  const heading = paint((text) => bold(red(text)))(`Errors (${errors.length})`);
  return `${heading}\n${lines.join("\n")}`;
}

/**
 * The closing summary: every category with its count (stable width, zeros
 * included) plus the bytes that changed — added + modified + deleted content
 * (rename and move both relocate the same bytes, so both are excluded).
 * Collapses to `No changes.` when nothing differs; appends the error count only
 * when > 0. `renamed`/`moved` counts are the human split of the one `moved`
 * category (passed in so the summary and its sections can't disagree).
 * @param {CompareResult} result
 * @param {number} renamedCount
 * @param {number} movedCount
 * @returns {string}
 */
function summaryLine(result, renamedCount, movedCount) {
  const { added, moved, modified, deleted, errors } = result;
  if (
    !added.length &&
    !moved.length &&
    !modified.length &&
    !deleted.length &&
    !errors.length
  ) {
    return "No changes.";
  }
  const bytes = sumSize(added) + sumSize(modified) + sumSize(deleted);
  let line =
    `${added.length} added, ${renamedCount} renamed, ${movedCount} moved, ` +
    `${modified.length} modified, ${deleted.length} deleted` +
    ` · ${formatByteValue(bytes)} changed`;
  if (errors.length) {
    line += `, ${errors.length} ${plural(errors.length, "error")}`;
  }
  return line;
}

/** @param {{ size: number }[]} entries */
const sumSize = (entries) => entries.reduce((total, e) => total + e.size, 0);
/** @param {number} n */
const count = (n) => n.toLocaleString("en");
/**
 * @param {number} n
 * @param {string} word
 */
const plural = (n, word) => (n === 1 ? word : `${word}s`);
