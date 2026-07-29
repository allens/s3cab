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
 * @returns {{ update: (text: string, opts?: { cursor?: number }) => void } & Disposable}
 */
export function createProgress(stream, { logLines = false } = {}) {
  const interactive = isInteractive(stream);
  let drawn = false;
  return {
    /**
     * Draw one progress update. On a terminal it replaces the current line in
     * place; `cursor`, when given, parks the terminal cursor at that column
     * afterwards (the upload bar rests it inside the bar). Off a terminal it
     * emits a plain line when `logLines` is set, otherwise nothing.
     * @param {string} text
     * @param {{ cursor?: number }} [opts]
     */
    update(text, { cursor } = {}) {
      if (interactive) {
        cursorTo(stream, 0);
        clearLine(stream, 1); // clear to line end so a shorter update leaves no stale tail
        stream.write(text);
        if (cursor !== undefined) {
          cursorTo(stream, cursor);
        }
        drawn = true;
      } else if (logLines) {
        stream.write(`${text}\n`);
      }
    },
    [Symbol.dispose]() {
      // Close the in-place line — only if one was drawn, so an instant operation
      // (no updates) or a non-interactive run leaves no stray newline.
      if (interactive && drawn) {
        stream.write("\n");
      }
    },
  };
}
