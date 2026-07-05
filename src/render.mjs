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

/** @import { BackupSet } from "./lib/sets.mjs" */

/**
 * The context the dispatcher threads into every renderer. The dispatcher owns
 * the stdout TTY/colour gate (`styleEnabled`, ADR-0043); a renderer only reads
 * this flag to decide whether to emit ANSI style, never re-checks the stream.
 * @typedef {Object} RenderContext
 * @property {boolean} color - Whether ANSI colour/style may be emitted
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
