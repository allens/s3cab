import { clearLine, cursorTo } from "node:readline";
import { isInteractive } from "./style.mjs";

// The one owner of the in-place stderr progress mechanic (clig.dev): gate on the
// stream being an interactive terminal, redraw a single line in place (cursor to
// column 0, clear it, write), and close it with exactly one newline when
// disposed — but only if a line was actually drawn. Off a terminal it stays
// silent, unless `logLines` is set, in which case each update is its own plain
// line (no carriage returns) — the form a redirected log or CI wants.
//
// snapshot, restore, and the upload bar each used to hand-roll this; the copies
// diverged, and snapshot's forgot the TTY gate entirely (it wrote `\r` into any
// stream). Centralizing it here means the "don't animate off a TTY" rule that
// style.mjs decides can't be forgotten again — every progress consumer routes
// through this module, which routes through `isInteractive`. The renderer (what
// each line *says* — a byte bar, a percentage, an n/total counter) stays with
// each caller; only the terminal-writing mechanic lives here.
//
// *Cadence* lives here too, for the same reason. Each caller used to carry its
// own count-based gate — every 500 objects, every 1,000 files, every changed
// percentage — which bounds the *count* between redraws but never the *rate*:
// the identical gate is placid on a network-paced LIST (a page per round trip)
// and a strobe on a warm dircache (tens of thousands of paths a second). Rate is
// what the eye reacts to, so it is one dial in one place.

// Redraw at most ten times a second. Fast enough to read as live, slow enough
// that the digits stay legible instead of blurring.
const MIN_REDRAW_MS = 100;

/**
 * Write one *retained* status line, over whatever a progress bar left on the
 * current line.
 *
 * A bar leaves its line un-terminated, so an ordinary `console.warn` mid-run
 * appends to it and mangles the display. Clearing the line first and ending with
 * a newline sidesteps that without the caller needing to know whether a bar is
 * even running: on an empty line the clear is a no-op, and either way the cursor
 * lands at the start of a fresh line, so a bar simply redraws below. The frozen
 * bar it overwrites was showing stale bytes anyway.
 *
 * Off a terminal it is just the plain line — no cursor games, nothing to gate,
 * which is what a redirected log wants (clig.dev).
 * @param {NodeJS.WriteStream} stream - Usually `process.stderr`
 * @param {string} text
 */
export function statusLine(stream, text) {
  if (isInteractive(stream)) {
    cursorTo(stream, 0);
    clearLine(stream, 1);
  }
  stream.write(`${text}\n`);
}

/**
 * Create an in-place stderr progress reporter. Use it with `using` so its
 * closing newline runs on any scope exit (including a throw mid-loop), leaving
 * the cursor on a fresh line before whatever prints next.
 * @param {NodeJS.WriteStream} stream - Usually `process.stderr`
 * @param {object} [options]
 * @param {boolean} [options.logLines] - Off a terminal, write each update as its
 *   own plain line instead of staying silent (for a caller whose long-running
 *   progress is worth logging, like `restore`).
 * @returns {{ update: (text: string, opts?: { cursor?: number }) => void, due: () => boolean, clear: () => void } & Disposable}
 */
export function createProgress(stream, { logLines = false } = {}) {
  const interactive = isInteractive(stream);
  // Off a terminal without `logLines` nothing is ever written, so `due` stays
  // false forever and a hot-path caller skips even building its text.
  const writes = interactive || logLines;
  let drawn = false;
  let lastDrawnAt = -Infinity;
  /** @type {{ text: string, cursor?: number } | null} */
  let pending = null;

  /**
   * @param {string} text
   * @param {number} [cursor]
   */
  const draw = (text, cursor) => {
    lastDrawnAt = performance.now();
    pending = null;
    if (interactive) {
      cursorTo(stream, 0);
      // Never let a line wrap. An in-place redraw clears one row, so the
      // overflow of a wrapped line is stranded on screen and every later redraw
      // lands under it. Callers that care which end survives trim their own text
      // first (the backup line keeps the tail of the path); this is the backstop.
      stream.write(text.slice(0, (stream.columns || Infinity) - 1));
      // Clear the *tail* after writing rather than blanking the line before it.
      // Same end state — no stale characters left by a longer previous update —
      // but the line is never empty in between. Clearing first leaves a window
      // in which the terminal can repaint an empty line: invisible at a few
      // redraws a second, and at hundreds it *is* the flicker.
      clearLine(stream, 1);
      if (cursor !== undefined) {
        cursorTo(stream, cursor);
      }
      drawn = true;
    } else {
      stream.write(`${text}\n`);
    }
  };

  return {
    /**
     * Whether a redraw is due yet. A caller in a hot loop asks this *before*
     * composing its text: the line costs ~0.5µs to build (`Intl` number
     * formatting and a template) against this check's ~0.07µs, and over
     * hundreds of thousands of files that gap is the whole cost. Purely an
     * optimization — `update` enforces the same interval either way.
     */
    due: () => writes && performance.now() - lastDrawnAt >= MIN_REDRAW_MS,
    /**
     * Draw one progress update. On a terminal it replaces the current line in
     * place; `cursor`, when given, parks the terminal cursor at that column
     * afterwards (the upload bar rests it inside the bar). Off a terminal it
     * emits a plain line when `logLines` is set, otherwise nothing.
     *
     * An update inside the redraw interval is *held*, not dropped, and drawn
     * when the line closes — so the final state always reaches the screen. That
     * is what lets every caller's closing line (`… 1,204 in 3 secs`, `Restoring
     * 200/200…`, a finished byte bar) be an ordinary `update` that the pacing
     * can't swallow.
     * @param {string} text
     * @param {{ cursor?: number }} [opts]
     */
    update(text, { cursor } = {}) {
      if (!writes) {
        return;
      }
      if (performance.now() - lastDrawnAt < MIN_REDRAW_MS) {
        pending = { text, cursor };
        return;
      }
      draw(text, cursor);
    },
    /**
     * Wipe the line and forget it was ever drawn, so disposal retains nothing.
     * For progress that was only ever *live* — the per-file upload bar, whose
     * finished state says nothing its caller's summary doesn't — as against the
     * counters whose last line is the result and must stay.
     *
     * A no-op off a terminal: `logLines` output is a log, and a log doesn't
     * retract lines it has already written.
     */
    clear() {
      pending = null;
      if (interactive && drawn) {
        cursorTo(stream, 0);
        clearLine(stream, 1);
        drawn = false;
      }
    },
    [Symbol.dispose]() {
      if (pending) {
        draw(pending.text, pending.cursor);
      }
      // Close the in-place line — only if one was drawn, so an instant operation
      // (no updates) or a non-interactive run leaves no stray newline.
      if (interactive && drawn) {
        stream.write("\n");
      }
    },
  };
}
