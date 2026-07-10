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
import { NO_SETS_MESSAGE } from "./lib/sets.mjs";
import { setHasFindings } from "./lib/verify.mjs";
import { bold, cyan, green, red, yellow } from "./lib/style.mjs";

/** @import { BackupSet } from "./lib/sets.mjs" */
/** @import { ListResult, ProviderOverrides } from "./commands/list.mjs" */
/** @import { StatusReport } from "./commands/status.mjs" */
/** @import { Props } from "./lib/snapshot-file.mjs" */
/** @import { SetReport } from "./lib/verify.mjs" */
/** @import { BackupResult } from "./commands/backup.mjs" */
/** @import { UploadResult } from "./commands/upload.mjs" */
/** @import { RestoreResult } from "./commands/restore.mjs" */
/** @import { DeleteResult } from "./commands/delete.mjs" */
/** @import { CleanupResult } from "./commands/cleanup.mjs" */
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
 * overrides something; a set on the user default stays as before (the absence
 * IS the answer). Key presence only, never the secret.
 * @param {ProviderOverrides} overrides
 * @returns {string[]}
 */
function providerOverrideLines({ profile, endpoint, region, keys }) {
  const lines = [];
  if (profile) {
    lines.push(`  AWS profile: ${profile}`);
  }
  if (endpoint) {
    lines.push(`  endpoint: ${endpoint}`);
  }
  if (region) {
    lines.push(`  region: ${region}`);
  }
  if (keys) {
    lines.push(`  access keys: set`);
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
    row("size", `${count(props.size)} bytes (${formatByteValue(props.size)})`),
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
    toUpload === 0
      ? "up to date"
      : `${count(toUpload)} ${plural(toUpload, "object")} to upload`;
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
  /** Apply a colouriser only when colour is enabled. @param {(t: string) => string} c */
  const paint = (c) => (/** @type {string} */ text) => (color ? c(text) : text);

  const findingSets = sets.filter(setHasFindings);
  const objectsChecked = sets.reduce((n, s) => n + s.referencedObjects, 0);

  const verdict = findingSets.length
    ? paint((t) => bold(red(t)))(
        `${findingSets.length} ${plural(findingSets.length, "set")} with findings ✗`,
      )
    : paint((t) => bold(green(t)))("all verified ✓");

  const head =
    `${bucket}: ${count(sets.length)} ${plural(sets.length, "set")}, ` +
    `${count(objectsChecked)} ${plural(objectsChecked, "object")} checked — ${verdict}`;

  if (findingSets.length === 0) {
    return head;
  }
  const blocks = findingSets.map((set) => setFindings(set, paint));
  return [head, ...blocks].join("\n\n");
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
    phrase.push(
      `${problems.length} ${plural(problems.length, "file")} with problems`,
    );
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
  return `(recorded ${count(p.recordedSize ?? 0)} bytes, stored ${count(p.storedSize ?? 0)})`;
}

/**
 * Confirm a `backup` (ADR-0043) — which set and snapshot went up, and how much
 * new content transferred. `candidates` is the objects this backup considered
 * (new since the last one); `uploaded` those actually sent — the rest the store
 * already held (dedup, or a resumed backup). Zero candidates is the up-to-date
 * case; when every candidate uploaded, the "already stored" aside is dropped.
 * @param {BackupResult} result
 * @returns {string}
 */
export function renderBackup({ set, snapshot, candidates, uploaded }) {
  return objectUploadLine(
    `Backed up '${set}' (snapshot ${snapshot})`,
    candidates,
    uploaded,
  );
}

/**
 * The shared "how much content went up" line for the object-set uploads —
 * `backup` and `upload --snapshot`, which report the same candidates/uploaded
 * counts under different headlines (ADR-0044). Zero candidates is the up-to-date
 * case; when every candidate uploaded, the "already stored" aside is dropped.
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
      ? `uploaded ${count(uploaded)} ${objects}`
      : `uploaded ${count(uploaded)} of ${count(candidates)} ${objects} ` +
        `(${count(candidates - uploaded)} already stored)`;
  return `${head}: ${detail}.`;
}

/**
 * Confirm an `upload` (ADR-0043) — the plumbing put, in one of two shapes
 * (ADR-0044). **`file`**: the single-object put, reporting the object key (the
 * content address, never truncated) and human size, and whether the bytes were
 * transferred or the store already held them (a content-addressed store never
 * re-puts identical content). **`snapshot`**: a whole snapshot's objects, sharing
 * `backup`'s content-uploaded line under an upload-framed headline.
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
  const { key, size, uploaded } = result;
  const human = formatByteValue(size);
  return uploaded
    ? `Uploaded ${key} (${human}).`
    : `${key} already stored (${human}).`;
}

/**
 * Confirm a `restore` (ADR-0043) — how many files were written from which
 * snapshot, then the existing files left untouched (the full list, never
 * truncated: each is a file the user asked for and didn't get, so name them all
 * and point at --overwrite). An empty selection that wrote and skipped nothing
 * says so plainly rather than emitting blank output.
 * @param {RestoreResult} result
 * @returns {string}
 */
export function renderRestore({ set, snapshot, restored, skipped }) {
  const sections = [];
  // The count line carries the set/snapshot context, so it leads whenever
  // anything happened — including the wrote-nothing-but-skipped case (every
  // requested file already existed), where "Restored 0 files" keeps that context
  // above the skipped list rather than starting cold on "Skipped …".
  if (restored.length || skipped.length) {
    sections.push(
      `Restored ${count(restored.length)} ${plural(restored.length, "file")} ` +
        `from '${set}' (snapshot ${snapshot}).`,
    );
  }
  if (skipped.length) {
    const heading =
      `Skipped ${count(skipped.length)} existing ` +
      `${plural(skipped.length, "file")} (rerun with --overwrite to replace):`;
    sections.push([heading, ...skipped.map((path) => `  ${path}`)].join("\n"));
  }
  if (sections.length === 0) {
    return `Nothing to restore from '${set}' (snapshot ${snapshot}).`;
  }
  return sections.join("\n\n");
}

/**
 * Confirm a `delete` (ADR-0043) — the stdout record of whether the named snapshot
 * was removed. The reclaim-with-cleanup hint and the cancel notice are stderr
 * guidance the command already emitted (kept there, not folded in); this is only
 * the result line. `deleted: false` means the user declined the confirmation.
 * @param {DeleteResult} result
 * @returns {string}
 */
export function renderDelete({ set, snapshot, deleted }) {
  return deleted
    ? `Snapshot '${snapshot}' deleted from set '${set}'.`
    : `Snapshot '${snapshot}' kept — deletion cancelled.`;
}

/**
 * Confirm a `cleanup` (ADR-0043) — the run's counts, which are the command's
 * *result* (moved here from stderr, where only next-step guidance now remains). A
 * `--delete` run that reclaimed reports what it removed; every other run (dry run,
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
      `${bucket}: deleted ${count(deleted)} orphaned ` +
      `${plural(deleted, "object")}, reclaimed ${formatByteValue(reclaimableBytes)}.`
    );
  }
  let line =
    `${bucket}: ${count(storedObjects)} ${plural(storedObjects, "object")} stored, ` +
    `${count(orphanObjects)} orphaned (${formatByteValue(reclaimableBytes)} reclaimable)`;
  if (withinGrace) {
    line += `, ${count(withinGrace)} too new to touch (7-day grace)`;
  }
  if (missingObjects) {
    line += `, ${count(missingObjects)} missing (referenced but absent)`;
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
