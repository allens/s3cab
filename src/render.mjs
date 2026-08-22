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
//
// One function here is not a renderer: `offerBackupChanges` *asks* whether to
// render more, so it is async and it reads the terminal (ADR-0078). It lives
// beside the renderers because what it hands back is rendered text, produced by
// the very renderer `compare` uses — and it still returns rather than prints.
// The dispatcher runs it through the registry's `offer` field, after the result
// it follows is already on screen.

import { dirname, relative, sep } from "node:path";
import {
  countOf,
  formatByteValue,
  formatCount,
  plural,
  shortDuration,
} from "./lib/format.mjs";
import { tildeify } from "./lib/home.mjs";
import { promptYesNo } from "./lib/prompt.mjs";
import { keyTail } from "./lib/provider.mjs";
import { NO_SETS_MESSAGE } from "./lib/sets.mjs";
import { setHasFindings } from "./lib/verify.mjs";
import { bold, cyan, green, isInteractive, red, yellow } from "./lib/style.mjs";

/** @import { BackupSet } from "./lib/sets.mjs" */
/** @import { ListResult } from "./commands/list.mjs" */
/** @import { ExcludedEntry } from "./commands/tree.mjs" */
/** @import { ProviderConfig } from "./lib/provider.mjs" */
/** @import { StatusReport } from "./commands/status.mjs" */
/** @import { Props } from "./lib/snapshot-file.mjs" */
/** @import { SetReport } from "./lib/verify.mjs" */
/** @import { BackupResult } from "./commands/backup.mjs" */
/** @import { UploadResult } from "./commands/upload.mjs" */
/** @import { RestoreResult } from "./commands/restore.mjs" */
/** @import { ForgetResult } from "./commands/forget.mjs" */
/** @import { CleanupResult } from "./commands/cleanup.mjs" */
/** @import { DeleteResult } from "./commands/delete.mjs" */
/** @import { FindResult } from "./lib/find.mjs" */
/**
 * @import {
 *   CompareResult, AddedEntry, MovedEntry, PathSize, CompareError, SkippedEntry,
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
 * Confirm a `setup` (create) or `reattach` by echoing the set's resulting state.
 * Both return the stored `BackupSet`, so they share this renderer (ADR-0043 keeps
 * the command a pure data returner): the confirmation someone wants is "what is
 * this set now". The command-specific guidance (setup's starter-exclude notice,
 * reattach's snapshot-pull summary) already went to stderr from inside the command.
 *
 * The `dirs.txt` path heads the directory list so a capable terminal can open it
 * — directories are edited in that file now, not through a `setup` re-run (there
 * is no update mode, ADR-0052), which is also what an empty set is steered toward.
 * @param {BackupSet} set
 * @returns {string}
 */
export function renderSetup(set) {
  const dirs = set.dirs.length
    ? set.dirs.map((dir) => `  ${dir}`).join("\n")
    : "  (none yet — add them by editing that file)";
  return `Set '${set.name}' → bucket '${set.bucket}'\ndirs (${set.dirsPath}):\n${dirs}`;
}

/**
 * Colouriser gate for a renderer: `painter(color)` yields a `paint` that
 * applies a colouriser only when colour is enabled — headings paint on a TTY
 * and stay plain when piped.
 * @param {boolean} color
 * @returns {(colourise: (text: string) => string) => (text: string) => string}
 */
const painter = (color) => (colourise) => (text) =>
  color ? colourise(text) : text;

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
  const paint = painter(color);

  const head = header(result, base);

  if (result.since === null) {
    // First snapshot: collapse the whole listing to a count + total size.
    const files = result.added.length;
    const bytes = sumSize(result.added);
    const line = `First snapshot: ${countOf(files, "file")} (${formatByteValue(bytes)})`;
    const parts = [head, line];
    // Kept on a first snapshot, where the all-added listing is collapsed: these
    // are the files that *didn't* go in, which is the one thing a collapsed
    // listing can't tell you — and it matters more here than later, since a
    // first run is when you find out what your set can't hold (ADR-0078).
    if (result.skipped.length) {
      parts.push(skippedSection(result.skipped, shorten, paint));
    }
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
    sections.push(addedSection(result.added, result.since, shorten, paint));
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
  // Skipped then Errors last, both after the change sections: neither is a
  // change, and the fault is the one that should be left on screen.
  if (result.skipped.length) {
    sections.push(skippedSection(result.skipped, shorten, paint));
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
 * The added files, each with the notes that stop a reader drawing a wrong
 * inference from the bare word "added" (ADR-0043's human-first reading):
 * `(duplicate of …)` says the content is not new, and `(was unreadable in …)`
 * says the *file* is not new — it sat there the whole time and simply couldn't
 * be hashed for the older snapshot, so this run is when it reached the backup
 * ([ADR-0079](../docs/adr/0079-previously-unreadable-file-is-an-annotated-addition.md)).
 * The older snapshot is named rather than called "last time", because `compare`
 * takes an arbitrary `--since`; the header shows the same name.
 *
 * Both notes share one parenthetical when both apply — two bracketed asides on
 * one path read as a stutter.
 * @param {AddedEntry[]} added
 * @param {string} since - The older snapshot's name (the caller has returned already when there is none)
 * @param {(path: string) => string} shorten
 * @param {(colourise: (t: string) => string) => (t: string) => string} paint
 */
function addedSection(added, since, shorten, paint) {
  const lines = added.map((entry) => {
    const notes = [];
    if (entry.wasUnreadable) {
      notes.push(`was unreadable in ${since}`);
    }
    if (entry.duplicates.length) {
      notes.push(`duplicate of ${entry.duplicates.map(shorten).join(", ")}`);
    }
    const note = notes.length ? `  (${notes.join("; ")})` : "";
    return `  ${shorten(entry.path)}${note}`;
  });
  return `${paint(green)(`Added (${formatCount(added.length)})`)}\n${lines.join("\n")}`;
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
  return `${paint(colour)(`${label} (${formatCount(entries.length)})`)}\n${lines.join("\n")}`;
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
  return `${paint(colour)(`${label} (${formatCount(entries.length)})`)}\n${lines.join("\n")}`;
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
  const heading = paint((text) => bold(red(text)))(
    `Errors (${formatCount(errors.length)})`,
  );
  return `${heading}\n${lines.join("\n")}`;
}

/**
 * What the walk left out by design — a symlink, a socket, an entry the
 * filesystem couldn't classify (ADR-0078). Named in full, every time, not
 * diffed against the older snapshot: the question this answers is "what *is*
 * that thing?", which a reader asks on whatever run they happen to be looking
 * at, not only on the one where it first appeared. An entry that keeps
 * reappearing is then its own argument for an exclude pattern.
 *
 * The line carries the **file type**, not the recorded reason: the walk writes
 * one reason for every skip (`Unsupported file type`), so it would repeat down
 * the column while `Symbolic Link` is the part that answers the question. The
 * reason stays in the data for `--json` and for snapshots that recorded another.
 *
 * The type is printed as stored. The walk writes it in its readable form, so
 * there is no token to un-camel-case on the way out — see `getFileType`.
 *
 * Yellow, not the errors' bold red: a skipped entry is by design, and colouring
 * it like a fault would say something untrue about it.
 * @param {SkippedEntry[]} skipped
 * @param {(path: string) => string} shorten
 * @param {(colourise: (t: string) => string) => (t: string) => string} paint
 */
function skippedSection(skipped, shorten, paint) {
  const lines = skipped.map(
    (entry) => `  ${shorten(entry.path)}  (${entry.fileType})`,
  );
  const heading = paint(yellow)(`Skipped (${formatCount(skipped.length)})`);
  return `${heading}\n${lines.join("\n")}`;
}

/**
 * Whether a diff has anything at all to report. Skipped is in the test alongside
 * errors, so a snapshot whose only news is an unbacked-up symlink can't print
 * `No changes.` directly beneath the section that just listed it — and so a
 * backup with nothing but a skip still has something to offer showing.
 * @param {CompareResult} result
 * @returns {boolean}
 */
const hasFindings = ({ added, moved, modified, deleted, errors, skipped }) =>
  Boolean(
    added.length ||
    moved.length ||
    modified.length ||
    deleted.length ||
    errors.length ||
    skipped.length,
  );

/**
 * The closing summary: every category with its count (stable width, zeros
 * included) plus the bytes that changed — added + modified + deleted content
 * (rename and move both relocate the same bytes, so both are excluded).
 * Collapses to `No changes.` when nothing differs; appends the skipped and
 * error counts only when > 0. `renamed`/`moved` counts are the human split of
 * the one `moved` category (passed in so the summary and its sections can't
 * disagree).
 * @param {CompareResult} result
 * @param {number} renamedCount
 * @param {number} movedCount
 * @returns {string}
 */
function summaryLine(result, renamedCount, movedCount) {
  const { added, modified, deleted, errors, skipped } = result;
  if (!hasFindings(result)) {
    return "No changes.";
  }
  const bytes = sumSize(added) + sumSize(modified) + sumSize(deleted);
  let line =
    `${formatCount(added.length)} added, ${formatCount(renamedCount)} renamed, ` +
    `${formatCount(movedCount)} moved, ${formatCount(modified.length)} modified, ` +
    `${formatCount(deleted.length)} deleted` +
    ` · ${formatByteValue(bytes)} changed`;
  if (skipped.length) {
    line += `, ${formatCount(skipped.length)} skipped`;
  }
  if (errors.length) {
    line += `, ${countOf(errors.length, "error")}`;
  }
  return line;
}

/**
 * Render `list` (ADR-0043) — the read half of the old `sets` command, in one of
 * two mode-tagged shapes. **`detail`** (a named set, or `--remote`) shows the
 * set's config — name, bucket, member directories with the `dirs.txt` path, the
 * exclude-file path — then its snapshots; the config paths teach where to edit a
 * set ("the files are the API", ADR-0002). **`summary`** (all sets) lists each
 * set's name then its snapshot times, collapsing to the "create one" guidance
 * when there are no sets yet (a legitimate result on stdout, not a stderr
 * warning — ADR-0043).
 * @param {ListResult} result
 * @returns {string}
 */
export function renderList(result) {
  if (result.mode === "detail") {
    const { set, overrides, snapshots, remote } = result;
    return [
      `name: ${set.name}`,
      `bucket: ${set.bucket}`,
      ...providerOverrideLines(overrides),
      `dirs (${set.dirsPath}):`,
      ...(set.dirs.length ? set.dirs.map((dir) => `  ${dir}`) : ["  (none)"]),
      `exclude file: ${set.excludePath}`,
      `${remote ? "remote snapshots" : "snapshots"}:`,
      indentSnapshots(snapshots),
    ].join("\n");
  }
  if (result.sets.length === 0) {
    return NO_SETS_MESSAGE;
  }
  return result.sets
    .map((s) => `${s.name}:\n${indentSnapshots(s.snapshots)}`)
    .join("\n");
}

/**
 * The set's own provider settings, as an indented block after the bucket —
 * where its backups actually go (ADR-0047). Rendered only when the set
 * carries provider settings of its own; a set relying on the ambient AWS setup
 * shows no block (the absence IS the answer). The sign-in mode leads (RA-first,
 * like `authNotice`); the key's tail names the key, never the secret.
 * @param {ProviderConfig} overrides
 * @returns {string[]}
 */
function providerOverrideLines({
  profile,
  endpoint,
  region,
  keyId,
  rolesAnywhere,
}) {
  const lines = [];
  if (rolesAnywhere) {
    lines.push(`  sign-in: Roles Anywhere (keyless)`);
  }
  if (profile) {
    lines.push(`  AWS profile: ${profile}`);
  }
  if (endpoint) {
    lines.push(`  endpoint: ${endpoint}`);
  }
  if (region) {
    lines.push(`  region: ${region}`);
  }
  if (keyId) {
    lines.push(`  access keys: set (${keyTail(keyId)})`);
  }
  return lines.length ? ["provider overrides:", ...lines] : [];
}

/**
 * Snapshot names as indented lines, or a `(none yet)` placeholder when there are
 * none — so an empty set reads clearly rather than as a blank gap.
 * @param {string[]} names
 * @returns {string}
 */
function indentSnapshots(names) {
  if (names.length === 0) {
    return "  (none yet)";
  }
  return names.map((name) => `  ${name}`).join("\n");
}

/**
 * Render a flat line stream — the shared renderer the plumbing list commands
 * (`tree`'s file paths, `hashes`' object hashes) both point at, since both return
 * a `string[]` whose human form *is* one entry per line. This is the composition
 * medium (docs/design/backup.md): `s3cab tree > files.txt`, `s3cab hashes <bucket>
 * | …`. An empty list renders to the empty string — the honest, greppable answer
 * for a set with no files or a store with no objects (Unix `find`/`ls` behave the
 * same); a placeholder would corrupt the redirected/piped stream.
 * @param {string[]} lines
 * @returns {string}
 */
export function renderLines(lines) {
  return lines.join("\n");
}

/**
 * Render `tree` in either of its two directions: the kept paths (one per line,
 * exactly as before) or, under `--excluded`, what the set's patterns dropped —
 * the path, a tab, and the pattern that matched it. Two shapes, one renderer,
 * because the registry gives a command a single `render`.
 *
 * The path stays in column 1 so `s3cab tree --excluded | cut -f1` yields the
 * same stream shape as a plain `s3cab tree`, and the pattern rides alongside
 * rather than in a second pass — which is what makes a per-path "why is *this*
 * excluded?" a `grep` rather than another flag. A tab is the separator for the
 * same reason snapshots use one (ADR-0004): no quoting, no escaping, and a
 * column a script can cut. `--json` never sees this — it gets the record objects
 * the command actually returned.
 * @param {Array<string | ExcludedEntry>} entries
 * @returns {string}
 */
export const renderTree = (entries) =>
  renderLines(
    entries.map((entry) =>
      typeof entry === "string" ? entry : `${entry.path}\t${entry.pattern}`,
    ),
  );

/**
 * The degenerate renderer for commands whose result already *is* the finished
 * human text — `aws`'s onboarding recipe (a prescriptive `aws`-CLI plan) and
 * `auth`'s status/confirmation lines. ADR-0043 deliberately does *not* structure
 * these: their result is prose, not data to shape, so an identity function is the
 * honest end-state (the single-string sibling of `renderLines`). Under `--json`
 * the dispatcher `JSON.stringify`s this text into a quoted, escaped string
 * literal — the same content, machine-wrapped; a consumer of a recipe still
 * wants the recipe.
 * @param {string} text
 * @returns {string}
 */
export const renderText = (text) => text;

/**
 * A stored `mtime` shortened for a comment line: `2019-04-02T07:55:12.345Z` →
 * `2019-04-02 07:55Z`. The exact value is in the snapshot (and in `--json`);
 * what a `find` result needs is enough to recognize a file by, in a line that
 * already carries a size. Anything not shaped like the stored instant
 * (ADR-0072) is passed through untouched — a snapshot is a text file a user may
 * edit, and mangling what we don't recognize would be worse than showing it.
 * @param {string} mtime
 * @returns {string}
 */
const shortMoment = (mtime) =>
  /^\d{4}-\d\d-\d\dT\d\d:\d\d/.test(mtime)
    ? `${mtime.slice(0, 16).replace("T", " ")}Z`
    : mtime;

/**
 * An exact byte count, glossed with its SI magnitude once that reads faster:
 * `892` → `"892 bytes"`, `14203847163` → `"14,203,847,163 bytes (14.2GB)"`.
 *
 * The exact figure leads because a `find` result is what someone reaches for
 * when deciding whether *this* is the file they meant, and `prop` — the other
 * command answering that question — spells it out the same way. The gloss is
 * dropped below 1 kB, where `formatByteValue` returns the same digits again and
 * the parenthetical is pure noise; the threshold is that function's own scaling
 * point, not a second opinion about what counts as big.
 * @param {number} size
 * @returns {string}
 */
const byteSize = (size) =>
  size < 1000
    ? countOf(size, "byte")
    : `${formatCount(size)} bytes (${formatByteValue(size)})`;

/**
 * Render `find` — **one hash per line, every other thing a `#` comment**
 * ([ADR-0088](../docs/adr/0088-find-matches-like-posix-find.md)).
 *
 * That shape is the point rather than a style: it *is* the flat hash-per-line
 * stream `hashes` already establishes as this tool's composition medium, so the
 * result reads in a terminal without wrapping (a 64-char hash plus a size, an
 * mtime and a Windows path does not fit a line), redirects to a file, and
 * survives being edited down to the hashes you actually want — the form the
 * hash-operand `delete` (ADR-0089) reads back via `--from-file`. The columnar
 * scan a table would give is what it trades away, and most searches return one
 * file or a few.
 *
 * Comments carry the context: what was searched (with each set's bucket, since
 * that is where a hash would be deleted from), then per file its size, when it
 * was last modified, which snapshots hold it, and the dedup warning when the
 * same content is stored under other paths too. Two warnings are coloured — the
 * only lines here a reader must not skim past.
 * @param {FindResult} result
 * @param {RenderContext} [context]
 * @returns {string}
 */
export function renderFind(result, { color = false } = {}) {
  const warn = painter(color)(yellow);
  const objects = result.files.reduce(
    (total, file) => total + file.objects.length,
    0,
  );

  // The unit is stated once and the later counts are bare, the way the sets read
  // aloud: "myset, 943 snapshots; work, 211".
  const searched = result.searched
    .map(
      ({ name, bucket, snapshots }, index) =>
        `${name} → s3://${bucket} (${index === 0 ? countOf(snapshots, "snapshot") : formatCount(snapshots)})`,
    )
    .join(", ");

  const lines = [
    `# s3cab find · ${countOf(result.patterns.length, "pattern")} · ${countOf(result.files.length, "file")} · ${countOf(objects, "object")}`,
    `# searched ${searched} — local history`,
  ];

  // A hash identifies content within one bucket, and `delete` takes one bucket,
  // so a result drawn from two is the one case where feeding this file straight
  // back would silently drop rows.
  const bucketOf = new Map(
    result.searched.map(({ name, bucket }) => [name, bucket]),
  );
  const spanned = new Set(
    result.files.flatMap((file) =>
      file.objects.flatMap((object) =>
        object.spans.map((span) => bucketOf.get(span.set)),
      ),
    ),
  );
  if (spanned.size > 1) {
    lines.push(
      warn(
        `# ⚠ results span ${countOf(spanned.size, "bucket")} — 's3cab delete' takes one bucket at a time`,
      ),
    );
  }

  // Named, not swallowed: an unsearched snapshot could be the one holding the
  // file, so a short answer must say what it could not look at. Deliberately
  // *not* `referenced.mjs`'s `unreadableMessage`: that one is worded for a
  // destructive command it blocks and signs off with `s3cab verify <bucket>`,
  // and `find` neither blocks nor has one bucket to name.
  if (result.unreadable.length) {
    lines.push(
      warn(
        `# ⚠ ${countOf(result.unreadable.length, "snapshot")} could not be read and went unsearched:`,
      ),
      ...result.unreadable.map(
        ({ set, snapshot, reason }) => `#     ${set}/${snapshot} — ${reason}`,
      ),
    );
  }

  if (result.files.length === 0) {
    lines.push(
      "#",
      "# nothing matched. A pattern with no separator matches the file name only;",
      "# add a separator to match the path, or a trailing one to search beneath a",
      "# directory — 's3cab find secrets/'.",
    );
    return lines.join("\n");
  }

  // One column width for the set names across the whole report, so the snapshot
  // ranges line up between files rather than stepping in and out.
  const setColumn = Math.max(
    ...result.files.flatMap((file) =>
      file.objects.flatMap((object) =>
        object.spans.map((span) => span.set.length),
      ),
    ),
  );

  for (const { path, objects: found } of result.files) {
    lines.push("#", `# ${path}`);
    for (const object of found) {
      lines.push(
        `#   ${byteSize(object.size)}   modified ${shortMoment(object.mtime)}`,
        ...object.spans.map(
          ({ set, first, last, count }) =>
            `#   ${set.padEnd(setColumn)}  ${count === 1 ? first : `${first} … ${last}   (${countOf(count, "snapshot")})`}`,
        ),
      );
      if (object.alsoBacks.length) {
        lines.push(
          warn(
            `#   ⚠ also backs ${countOf(object.alsoBacks.length, "other path")} — deleting this removes ${object.alsoBacks.length === 1 ? "both" : "all of them"}`,
          ),
        );
      }
      lines.push(object.hash);
    }
  }

  return lines.join("\n");
}

/**
 * Render `prop` — one file's content properties as an aligned label/value block.
 * The size shows both the exact byte count and its human form. `hashDuration`
 * (an internal timing, in seconds) is a property of the *run*, not the file, so
 * the human view omits it — except under `S3CAB_DEBUG`, where a `hashed` row
 * surfaces it for diagnostics; `--json` always keeps it. `S3CAB_DEBUG` is read
 * ambiently here rather than threaded through `RenderContext`: unlike `color` (a
 * value the dispatcher *resolves* from the TTY and possibly flags), it has one
 * input — the env var — so putting it in every renderer's signature earns nothing.
 * @param {Props} props
 * @returns {string}
 */
export function renderProp(props) {
  /**
   * @param {string} label
   * @param {string} value
   */
  const row = (label, value) => `${label.padEnd(8)}  ${value}`;
  const rows = [
    row("hash", props.hash),
    row(
      "size",
      `${formatCount(props.size)} bytes (${formatByteValue(props.size)})`,
    ),
    row("modified", props.mtime),
  ];
  if (process.env.S3CAB_DEBUG && props.hashDuration !== undefined) {
    rows.push(row("hashed", `${props.hashDuration}s`));
  }
  return rows.join("\n");
}

/**
 * Render `status` — what is backed up and what a backup would upload
 * (docs/design/backup.md). A short record: the set, its latest local snapshot (the
 * upload target), the latest remote snapshot (or `never`), and the object count a
 * backup would upload — collapsing to `up to date` at zero.
 * @param {StatusReport} report
 * @returns {string}
 */
export function renderStatus({ set, snapshot, backedUp, toUpload }) {
  const upload =
    toUpload === 0 ? "up to date" : `${countOf(toUpload, "object")} to upload`;
  return [
    set,
    `  latest snapshot   ${snapshot}`,
    `  backed up         ${backedUp ?? "never"}`,
    `  ${upload}`,
  ].join("\n");
}

/**
 * Render `verify` (ADR-0042, ADR-0043) — file-centric integrity findings whose
 * headline mirrors the exit code: green `all verified ✓` (exit 0) vs red `N sets
 * with findings ✗` (exit 1). The scale figure is the *referenced* objects checked
 * (not the stored total — orphans are `cleanup`'s concern now). Only sets with
 * findings get a block; each `problems` row maps 1:1 to a line (hashes never
 * surface — the user thinks in files). Paths print as stored (absolute): verify
 * spans many sets with different roots and no single common base, so there is
 * nothing to shorten against, and re-canonicalizing per path is exactly what the
 * compare renderer is warned off (CLAUDE.md).
 * @param {{ bucket: string, sets: SetReport[] }} result
 * @param {RenderContext} [context]
 * @returns {string}
 */
export function renderVerify(result, { color = false } = {}) {
  const { bucket, sets } = result;
  const paint = painter(color);

  const findingSets = sets.filter(setHasFindings);
  const objectsChecked = sets.reduce((n, s) => n + s.referencedObjects, 0);

  const verdict = findingSets.length
    ? paint((t) => bold(red(t)))(
        `${countOf(findingSets.length, "set")} with findings ✗`,
      )
    : paint((t) => bold(green(t)))("all verified ✓");

  const head =
    `${bucket}: ${countOf(sets.length, "set")}, ` +
    `${countOf(objectsChecked, "object")} checked — ${verdict}`;

  // Deliberately deleted content (ADR-0064): context, not a finding — one line
  // per affected set, so the run's clean verdict and the "why are these files
  // gone" answer sit together without the deletion ringing the alarm forever.
  const deletedLines = sets
    .filter((set) => set.expectedMissing.length > 0)
    .map((set) => {
      // `deletedOn` is a full UTC instant; the calendar date is the "when" a
      // human wants here. Sort the distinct dates chronologically
      // (lexicographic == chronological for `YYYY-MM-DD`) — `expectedMissing`
      // is path-ordered, so the raw encounter order would make `.at(-1)` the
      // last file alphabetically, not the newest deletion.
      const dates = [
        ...new Set(set.expectedMissing.map((e) => e.deletedOn.slice(0, 10))),
      ].sort();
      const when =
        dates.length <= 2
          ? `deleted ${dates.join(", ")}`
          : `${formatCount(dates.length)} deletions, latest ${dates.at(-1)}`;
      return (
        `  ${set.set}   ${formatCount(set.expectedMissing.length)} ` +
        `${plural(set.expectedMissing.length, "file")} deleted from backups ` +
        `(s3cab delete — ${when}; expected, not damage)`
      );
    });

  const parts = [head];
  if (deletedLines.length) {
    parts.push(deletedLines.join("\n"));
  }
  if (findingSets.length > 0) {
    parts.push(...findingSets.map((set) => setFindings(set, paint)));
  }
  return parts.join("\n\n");
}

/**
 * One set's verify findings: a heading naming the set (red) and summarizing what
 * is wrong, then a line per broken file (path / problem / detail, column-aligned
 * within the set) and a line per snapshot that could not be read.
 * @param {SetReport} report
 * @param {(colourise: (t: string) => string) => (t: string) => string} paint
 * @returns {string}
 */
function setFindings(report, paint) {
  const { set, problems, unreadableSnapshots } = report;

  const phrase = [];
  if (problems.length) {
    phrase.push(`${countOf(problems.length, "file")} with problems`);
  }
  if (unreadableSnapshots.length) {
    phrase.push("could not fully check");
  }
  const heading = `  ${paint(red)(set)}   ${phrase.join("; ")}`;

  const lines = [];
  if (problems.length) {
    const pathWidth = Math.max(...problems.map((p) => p.path.length));
    const labelWidth = Math.max(
      ...problems.map((p) => problemLabel(p.problem).length),
    );
    for (const p of problems) {
      const label = problemLabel(p.problem).padEnd(labelWidth);
      lines.push(
        `    ${p.path.padEnd(pathWidth)}   ${label}   ${problemDetail(p)}`,
      );
    }
  }
  for (const u of unreadableSnapshots) {
    lines.push(`    snapshot ${u.snapshot} could not be read (${u.reason})`);
  }
  return [heading, ...lines].join("\n");
}

/**
 * The two-word human label for a problem kind (the stored `wrong-size` reads as
 * `wrong size`).
 * @param {SetReport["problems"][number]["problem"]} problem
 * @returns {string}
 */
const problemLabel = (problem) =>
  problem === "missing" ? "missing" : "wrong size";

/**
 * The parenthetical detail for a problem row: which snapshots reference a
 * `missing` file (it can't be restored), or the recorded-vs-stored byte counts
 * for a `wrong-size` one (a truncated/overwritten upload or a torn snapshot file).
 * @param {SetReport["problems"][number]} p
 * @returns {string}
 */
function problemDetail(p) {
  if (p.problem === "missing") {
    return `(in ${plural(p.snapshots.length, "snapshot")} ${p.snapshots.join(", ")})`;
  }
  return `(recorded ${formatCount(p.recordedSize ?? 0)} bytes, stored ${formatCount(p.storedSize ?? 0)})`;
}

/**
 * Report a finished `backup` ([ADR-0078](../docs/adr/0078-backup-run-report.md)) —
 * a line per question, in that order because they are different questions:
 *
 * ```
 * Backed up 'onedrive' → snapshot 2026-08-08T0206
 * Scanned 265,716 files (1.8TB) in 9m 12s — 1,204 needed re-hashing (12.4GB)
 * Uploaded 426 objects (14.9GB) in 2m 12s
 * Changes since 2026-08-01T0846: 425 added, 1 modified, 0 deleted, 0 moved
 * Couldn't be backed up: 1 skipped, 1 error
 *   s3cab compare onedrive --since 2026-08-01T0846 --until 2026-08-08T0206
 * ```
 *
 * **The report is about files** (§1). The object counts stay — they are the
 * transfer, and the answer to "why did that take so long" — but they no longer
 * stand in for what happened: content-addressed dedup (ADR-0001) means a file
 * that merely moved changes everything and uploads nothing.
 *
 * **What is listed in full versus counted** (§2) is the dividing line: `backup`
 * spells out only what only `backup` can know — bytes, timings, transfers.
 * Everything the *snapshot* holds is a count plus the copy-pasteable command,
 * because the snapshot is permanent, so nothing is lost by not printing it. The
 * command names **both** snapshots on purpose: a bare `s3cab compare` stops
 * meaning "that run" the moment another backup lands.
 *
 * **`moved` is in the changes line** so a large reorganisation cannot read as
 * "nothing happened" beside `uploaded 0 objects`. **The heading is `Couldn't`**,
 * not "Not backed up" (§4) — excluded files are also not backed up, in their
 * thousands, and the distinction that matters is *didn't choose to* versus
 * *couldn't*.
 *
 * Every figure is read off the result, never derived here (§10) — including
 * `skipped`/`errors`, which the *pass* counted rather than the diff, so a first
 * backup (which runs no diff) still reports them.
 * @param {BackupResult} result
 * @returns {string}
 */
export function renderBackup(result) {
  const { set, snapshot, skipped, errors, comparison } = result;
  const lines = [
    `Backed up '${set}' → snapshot ${snapshot}`,
    scanLine(result),
    uploadLine(result),
    changesLine(comparison),
  ];

  if (skipped || errors) {
    const parts = [];
    if (skipped) {
      parts.push(`${formatCount(skipped)} skipped`);
    }
    if (errors) {
      parts.push(countOf(errors, "error"));
    }
    lines.push(`Couldn't be backed up: ${parts.join(", ")}`);
  }

  // The pointer, only when it has something to show. On a run with no changes,
  // nothing skipped and nothing failed there is nothing behind the command, and
  // offering it would be busywork dressed as a next step.
  if (skipped || errors || (comparison && changed(comparison))) {
    const since = comparison?.since ? `--since ${comparison.since} ` : "";
    lines.push(`  s3cab compare ${set} ${since}--until ${snapshot}`);
  }

  return lines.join("\n");
}

/**
 * What the pass got through off the disk, and how much of it was *work*
 * (ADR-0078 §9). Two figures that look alike and answer different questions:
 * the size of the set, and the bytes actually read. A backup that re-hashed
 * 1.8TB and one that reused every stored hash differ by minutes and are
 * otherwise indistinguishable — and the second silently becomes the first the
 * day a sync client rewrites every mtime on a set nobody touched.
 *
 * The re-hash clause is **not** dropped when it happens to equal the scan (an
 * incremental run that re-read everything is precisely the alarm this exists to
 * raise); it is dropped only on a first backup, which hashes everything by
 * definition and would just restate the figure beside it.
 * @param {BackupResult} result
 * @returns {string}
 */
function scanLine({
  files,
  bytes,
  scanMs,
  hashedFiles,
  hashedBytes,
  comparison,
}) {
  const scanned =
    `Scanned ${countOf(files, "file")} (${formatByteValue(bytes)}) ` +
    `in ${shortDuration(scanMs)}`;
  if (!comparison) {
    return scanned;
  }
  if (hashedFiles === 0) {
    return `${scanned} — nothing needed re-hashing`;
  }
  return (
    `${scanned} — ${formatCount(hashedFiles)} needed re-hashing ` +
    `(${formatByteValue(hashedBytes)})`
  );
}

/**
 * What went over the link, with its own elapsed time — the other half of §9's
 * split, on its own line because it answers the other half of "is my disk slow
 * or my link slow". One combined figure answers it wrongly: 14.9GB in 11m 24s
 * reads as a 22MB/s link when the time went on reading 1.8TB off the disk.
 * @param {BackupResult} result
 * @returns {string}
 */
function uploadLine({ candidates, uploaded, uploadedBytes, uploadMs }) {
  if (candidates === 0) {
    return `Nothing new to upload`;
  }
  // "3 of 120" whenever the store already held some of them — a resumed backup,
  // or content that deduped against another set — since 3 alone would read as a
  // backup that considered only three files.
  const objects =
    uploaded === candidates
      ? countOf(uploaded, "object")
      : `${formatCount(uploaded)} of ${countOf(candidates, "object")}`;
  const stored =
    uploaded === candidates
      ? ""
      : `, ${formatCount(candidates - uploaded)} already stored`;
  return (
    `Uploaded ${objects} (${formatByteValue(uploadedBytes)}${stored}) ` +
    `in ${shortDuration(uploadMs)}`
  );
}

/**
 * The diff line: what changed, and *since when* — "425 added" is meaningless
 * without the baseline, so the baseline is named rather than implied. A first
 * backup has no baseline and no diff to summarize (ADR-0078 §7); a run where
 * nothing moved says so in one line instead of four zeros.
 * @param {CompareResult | null} comparison
 * @returns {string}
 */
function changesLine(comparison) {
  if (!comparison?.since) {
    return `First backup — every file is new.`;
  }
  const { since, added, modified, deleted, moved } = comparison;
  if (!changed(comparison)) {
    return `No changes since ${since}.`;
  }
  // Grouped counts, like every other figure s3cab prints: a big reorganisation
  // puts five digits in this line, and `12480 moved` is the one number here that
  // gets read as a magnitude rather than a label.
  return (
    `Changes since ${since}: ${formatCount(added.length)} added, ` +
    `${formatCount(modified.length)} modified, ${formatCount(deleted.length)} deleted, ` +
    `${formatCount(moved.length)} moved`
  );
}

/**
 * Whether a diff found any *change* — the four categories the changes line
 * counts. Skipped and errored entries are deliberately not in it: they have
 * their own line, and a symlink that has been skipped on every run since March
 * is not news about this one.
 * @param {CompareResult} comparison
 * @returns {boolean}
 */
const changed = ({ added, modified, deleted, moved }) =>
  Boolean(added.length || modified.length || deleted.length || moved.length);

/**
 * Offer a finished backup's full diff, and render it if it is wanted — the
 * interactive half of ADR-0078 §5, run by the dispatcher *after* the report is
 * on screen, because the report is what the answer is judged on.
 *
 * The diff is the one already in memory, rendered through the very renderer
 * `compare` uses: no second parse, no re-run, and no way for the summary and the
 * detail to disagree. It returns the text rather than printing it, like every
 * other renderer here — the dispatcher owns the stream, and output the user
 * asked for is output, so it lands on stdout (ADR-0010).
 *
 * **Nothing is asked off a terminal, and an unattended run prints the same thing
 * minus the prompt** (§6): one output shape, not two. Dumping a full diff into a
 * cron mail is ADR-0076's wall-of-bars mistake in new clothes — the counts and
 * the command are in the log, and the snapshot on disk holds the rest.
 *
 * The prompt is the shared `promptYesNo`, default **No**. Not a variant with a
 * default of yes: that helper is shared with `forget` and `cleanup`, where its
 * "a stray Enter/EOF cancels rather than deletes" invariant is load-bearing, and
 * one saved keystroke is not worth putting a second default in play.
 * @param {BackupResult} result
 * @param {RenderContext} [context]
 * @returns {Promise<string | undefined>} The rendered diff, or nothing
 */
export async function offerBackupChanges({ comparison }, context = {}) {
  if (
    !comparison ||
    !hasFindings(comparison) ||
    !isInteractive(process.stdin)
  ) {
    return undefined;
  }
  const show = await promptYesNo("Show what changed?");
  return show ? renderCompareResult(comparison, context) : undefined;
}

/**
 * The "how much content went up" line for the object-set uploads —
 * `upload --snapshot` and the folder seed, which report the same
 * candidates/uploaded counts under different headlines (ADR-0044). Zero
 * candidates is the up-to-date case; when every candidate uploaded, the
 * "already stored" aside is dropped. (`backup` used to share it, and has its own
 * report now — ADR-0078 — where the same counts are one clause of a longer line.)
 * @param {string} head - The headline naming what was uploaded
 * @param {number} candidates - Objects considered for upload (new since the baseline)
 * @param {number} uploaded - Those actually transferred (the rest were already stored)
 * @returns {string}
 */
function objectUploadLine(head, candidates, uploaded) {
  if (candidates === 0) {
    return `${head} — already up to date, nothing new to upload.`;
  }
  const objects = plural(candidates, "object");
  const detail =
    uploaded === candidates
      ? `uploaded ${formatCount(uploaded)} ${objects}`
      : `uploaded ${formatCount(uploaded)} of ${formatCount(candidates)} ${objects} ` +
        `(${formatCount(candidates - uploaded)} already stored)`;
  return `${head}: ${detail}.`;
}

/**
 * Confirm an `upload` (ADR-0043) — the plumbing put, in one of three shapes
 * (ADR-0044). **`file`**: the single-object put, reporting the object key (the
 * content address, never truncated) and human size, and whether the bytes were
 * transferred or the store already held them (a content-addressed store never
 * re-puts identical content). **`snapshot`**: a whole snapshot's objects, sharing
 * `backup`'s content-uploaded line under an upload-framed headline. **`dir`**: a
 * folder seeded into the store (objects only, no snapshot), sharing that same
 * content-uploaded line under a "Seeded …" headline.
 * @param {UploadResult} result
 * @returns {string}
 */
export function renderUpload(result) {
  if (result.mode === "snapshot") {
    const { set, snapshot, candidates, uploaded } = result;
    return objectUploadLine(
      `Uploaded snapshot '${snapshot}' to '${set}'`,
      candidates,
      uploaded,
    );
  }
  if (result.mode === "dir") {
    const { set, dir, candidates, uploaded, skipped, onlineOnly } = result;
    let line = objectUploadLine(
      `Seeded '${dir}' into '${set}'`,
      candidates,
      uploaded,
    );
    // Its own block, above the drift list and never merged into it: that list's
    // header says s3cab couldn't confirm a file *while reading it*, and these are
    // files it never opened (ADR-0081). Counted rather than named — a seeded
    // OneDrive folder can hold tens of thousands, and the paths are not the
    // question here; whether to spend the disk space is.
    if (onlineOnly.length) {
      line +=
        `\n\nLeft ${countOf(onlineOnly.length, "file")} online rather than ` +
        `downloading them: this computer holds a placeholder for each, not the ` +
        `contents.\nTo store them off-vendor, back the set up with room for ` +
        `them on this disk:\n  s3cab backup ${set} --include-online-only`;
    }
    if (skipped.length === 0) {
      return line;
    }
    // Named in full, never truncated — the same reasoning as the restore lists:
    // each one is a file the user asked to seed and didn't get, so say which and
    // what to do. The reason word (`changed`/`removed`/`unreadable`) is already
    // plain English, so it needs no mapping.
    //
    // The header stays **reason-neutral** deliberately: a file can be skipped for
    // any of the three, and naming one of them up here would contradict the
    // `(removed)` printed two lines below it. What they share is that s3cab could
    // not confirm the file still matched its fingerprint, which is the header's
    // job; the per-file word says which.
    return [
      line,
      ``,
      `Skipped ${countOf(skipped.length, "file")} that couldn't be confirmed while being read:`,
      ...skipped.map(({ path, reason }) => `  ${path}   (${reason})`),
      ``,
      `Nothing references them, so there is nothing to repair — a backup will ` +
        `store them:`,
      `  s3cab backup ${set}`,
    ].join("\n");
  }
  const { key, size, uploaded } = result;
  const human = formatByteValue(size);
  return uploaded
    ? `Uploaded ${key} (${human}).`
    : `${key} already stored (${human}).`;
}

/**
 * Confirm a `restore` (ADR-0043) — how many files were written from which
 * snapshot, then the existing files left untouched, then the names this volume
 * folded into an already-restored file, then any file whose content the bucket
 * no longer holds. All lists are given in full, never truncated: each entry is
 * a file the user asked for and didn't get, so name them all and say what to
 * do about it (`--overwrite` for the skipped, a separate `--output` for the
 * collided, `verify` for the missing — ADR-0030's constructive fix). The
 * missing block comes last so it is what remains on screen after a long run,
 * and its exit code is set by the command. An empty selection that did nothing
 * at all says so plainly rather than emitting blank output.
 * @param {RestoreResult} result
 * @returns {string}
 */
export function renderRestore({
  set,
  bucket,
  snapshot,
  restored,
  skipped,
  collided,
  missing,
  deleted,
}) {
  const sections = [];
  // The count line carries the set/snapshot context, so it leads whenever
  // anything happened — including the wrote-nothing-but-skipped case (every
  // requested file already existed), where "Restored 0 files" keeps that context
  // above the skipped list rather than starting cold on "Skipped …".
  if (
    restored.length ||
    skipped.length ||
    collided.length ||
    missing.length ||
    deleted.length
  ) {
    sections.push(
      `Restored ${countOf(restored.length, "file")} from '${set}' (snapshot ${snapshot}).`,
    );
  }
  if (skipped.length) {
    const heading =
      `Skipped ${formatCount(skipped.length)} existing ` +
      `${plural(skipped.length, "file")} (rerun with --overwrite to replace):`;
    sections.push([heading, ...skipped.map((path) => `  ${path}`)].join("\n"));
  }
  if (deleted.length) {
    // Deliberate removals (ADR-0064): the deletion record explains these, so
    // they are context, not the alarm the missing block below is — and alone
    // they leave exit 0.
    const heading =
      `Skipped ${countOf(deleted.length, "file")} ` +
      `whose contents were deliberately deleted from the backups (s3cab delete):`;
    sections.push(
      [
        heading,
        // `deletedOn` is a full UTC instant; the calendar date is enough here.
        ...deleted.map(
          ({ path, deletedOn }) =>
            `  ${path}  (deleted ${deletedOn.slice(0, 10)})`,
        ),
      ].join("\n"),
    );
  }
  if (collided.length) {
    // A fault, not a routine skip: the volume folded two backed-up names into
    // one file (case, or accent encoding on macOS), so a file the user asked
    // for was not written and the command exits 1. The constructive fix
    // (ADR-0030) is restoring the colliding paths somewhere they can coexist.
    const heading =
      `Could not restore ${formatCount(collided.length)} ` +
      `${plural(collided.length, "file")} — this disk can't tell ` +
      `${collided.length === 1 ? "its name" : "their names"} apart from ` +
      `${collided.length === 1 ? "a file" : "files"} already restored ` +
      `(the names differ only by letter case or accent encoding):`;
    sections.push(
      [
        heading,
        ...collided.map((path) => `  ${path}`),
        "",
        "Keep both versions by restoring a colliding path into its own directory:",
        "",
        `  s3cab restore --set ${set} <path> --output <directory>`,
      ].join("\n"),
    );
  }
  if (missing.length) {
    const heading =
      `Could not restore ${formatCount(missing.length)} ` +
      `${plural(missing.length, "file")} — the backup no longer holds ` +
      `${missing.length === 1 ? "its" : "their"} contents:`;
    sections.push(
      [
        heading,
        ...missing.map((path) => `  ${path}`),
        "",
        "The rest of the restore finished. To check the other backups in this bucket:",
        "",
        `  s3cab verify ${bucket}`,
      ].join("\n"),
    );
  }
  if (sections.length === 0) {
    return `Nothing to restore from '${set}' (snapshot ${snapshot}).`;
  }
  return sections.join("\n\n");
}

/**
 * Confirm a `forget` (ADR-0043) — the stdout record of whether the named snapshots
 * were removed. The reclaim-with-cleanup hint and the cancel notice are stderr
 * guidance the command already emitted (kept there, not folded in); this is only
 * the result line. `forgotten: false` means the user declined the confirmation.
 * @param {ForgetResult} result
 * @returns {string}
 */
export function renderForget({ set, snapshots, forgotten }) {
  const what =
    snapshots.length === 1
      ? `Snapshot '${snapshots[0]}'`
      : `${formatCount(snapshots.length)} snapshots`;
  return forgotten
    ? `${what} forgotten from set '${set}'.`
    : `${what} kept — nothing was removed.`;
}

/**
 * Confirm a `delete` (ADR-0043) — the stdout record of whether the named
 * paths' content was removed. The preview summary, the record URI, and the
 * cancel notice all went to their streams inside the command (the summary is
 * pre-decision output, the rest stderr guidance); this is only the result
 * line. `deleted: false` covers a dry run, a declined confirmation, and a
 * nothing-to-delete run alike — in each case the summary above it already
 * said which.
 * @param {DeleteResult} result
 * @returns {string}
 */
export function renderDelete({
  bucket,
  deletedObjects,
  deletedBytes,
  deleted,
}) {
  if (!deleted) {
    return "Nothing was deleted.";
  }
  return (
    `${bucket}: deleted ${countOf(deletedObjects, "object")} ` +
    `(${formatByteValue(deletedBytes)}). ` +
    `Snapshots were not modified.`
  );
}

/**
 * Confirm a `cleanup` (ADR-0043) — the run's counts, which are the command's
 * *result* (moved here from stderr, where only next-step guidance now remains). A
 * run that reclaimed reports what it removed; every other run (dry run,
 * declined, or nothing to do) reports the inventory — stored total, orphans and
 * the space they hold, plus the grace-protected and (integrity-fault) missing
 * tallies when non-zero.
 * @param {CleanupResult} result
 * @returns {string}
 */
export function renderCleanup(result) {
  const {
    bucket,
    storedObjects,
    orphanObjects,
    reclaimableBytes,
    withinGrace,
    missingObjects,
    deleted,
  } = result;
  if (deleted > 0) {
    return (
      `${bucket}: deleted ${formatCount(deleted)} orphaned ` +
      `${plural(deleted, "object")}, reclaimed ${formatByteValue(reclaimableBytes)}.`
    );
  }
  let line =
    `${bucket}: ${countOf(storedObjects, "object")} stored, ` +
    `${formatCount(orphanObjects)} orphaned (${formatByteValue(reclaimableBytes)} reclaimable)`;
  if (withinGrace) {
    line += `, ${formatCount(withinGrace)} too new to touch (7-day grace)`;
  }
  if (missingObjects) {
    line += `, ${formatCount(missingObjects)} missing (referenced but absent)`;
  }
  return line;
}

/** @param {{ size: number }[]} entries */
const sumSize = (entries) => entries.reduce((total, e) => total + e.size, 0);
