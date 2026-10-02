import { clearLine, cursorTo } from "node:readline";
import { formatCount, secondsSince } from "./format.mjs";
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
// style.mjs decides can't be forgotten again. The renderer (what each line
// *says* — a byte bar, a percentage, an n/total counter) stays with each caller;
// only the terminal-writing mechanic lives here.
//
// *Cadence* lives here too, for the same reason. Each caller used to carry its
// own count-based gate — every 500 objects, every 1,000 files, every changed
// percentage — which bounds the *count* between redraws but never the *rate*:
// the identical gate is placid on a network-paced LIST (a page per round trip)
// and a strobe on a warm dircache (tens of thousands of paths a second). Rate is
// what the eye reacts to, so it is one dial in one place.
//
// **And the clock lives here: {@link clockedLine}.** `createProgress` hands back
// the bare mechanic; a clocked line is that mechanic plus what keeps it live —
// a timer for a caller waiting on I/O, and a `tick()` for one whose work is
// synchronous and so never lets a timer fire
// ([ADR-0093](../../docs/adr/0093-a-clocked-line-ticks-where-its-caller-never-yields.md)).
// The walk's line and the fused pass's each used to carry half of that, a
// different half each. {@link countedPass} is the one whole line *shape* built
// on it — bare label, then `<label> <count> in <elapsed>`, then a tally that
// survives off a terminal — because a pass is the unit
// [ADR-0076](../../docs/adr/0076-one-progress-line-driven-by-a-clock.md) names.
//
// One consumer deliberately still reaches for `isInteractive` itself:
// `s3.mjs`'s per-file upload bar asks a *different* question — "was a bar drawn,
// so should I log a line instead?" — which this module answers internally
// (`drawn`) but does not expose. That is its own small change and its own
// decision; it is named here so the omission reads as known rather than missed.

// Redraw at most ten times a second. Fast enough to read as live, slow enough
// that the digits stay legible instead of blurring.
const MIN_REDRAW_MS = 100;

// A counted pass redraws once a second, not on `MIN_REDRAW_MS`. Its line shows a
// count and `secondsSince`, which **rounds to whole seconds** — so at 100ms the
// elapsed half cannot change on nine draws out of ten, and the count alone does
// not earn ten redraws a second. Ticking at the rate of the slowest-changing
// field the line actually shows is also what lets the callers drop their
// per-item `due()` gate: composing one line a second is not a per-file cost.
const COUNTED_TICK_MS = 1000;

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
 * @param {boolean} [options.logLines] - Off a terminal, write plain lines instead
 *   of staying silent (for a caller whose long-running progress is worth logging,
 *   like `restore`). Paced like the animation, not one line per update: updates
 *   inside the redraw interval coalesce, so a log gets the latest state ten times
 *   a second at most. The final state always lands, held updates included.
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

/**
 * A **clocked line**: an in-place line that redraws itself on a clock, composing
 * its text afresh at each redraw rather than being handed it
 * ([ADR-0076](../../docs/adr/0076-one-progress-line-driven-by-a-clock.md) §3).
 * The caller says what the line reads; this decides when it is read.
 *
 * **The clock has two hands, because a timer only fires when the event loop
 * turns** ([ADR-0093](../../docs/adr/0093-a-clocked-line-ticks-where-its-caller-never-yields.md)).
 * A caller waiting on I/O — a LIST page, a snapshot file `find` streams in —
 * turns the loop on every read, so the timer alone keeps it live and it never
 * calls `tick()`. A caller whose work is synchronous never turns it: the walk is a
 * plain loop over `readdirSync`, and the fused pass is `async` functions whose
 * work is `lstatSync`, `readFileSync` and `crypto.hash`, so every `await` is a
 * microtask and a timer set beside them fires never. That caller calls `tick()`
 * once per item, and the line redraws when the interval is due. One clock read
 * and a compare per call (~50ns, measured), so it is affordable per directory
 * entry. Both hands keep to one "last drawn" moment: a tick within an interval
 * of the timer's draw does not draw, and a tick that draws restarts the timer,
 * so neither hand draws within `every` of the other.
 *
 * `due` gates every redraw because `update`'s argument is evaluated before
 * `update` can decline it: off a terminal (and without `logLines`) nothing is
 * ever written, so composing the line would be `Intl` and Temporal work done
 * every interval and thrown away for the length of the pass. This is the hot-path
 * idiom `due` documents, asked in one place so no caller has to remember it.
 *
 * `done(text)` exists because disposal cannot tell it is unwinding from a throw.
 * A pass that aborts — the walk on a duplicate path, a LIST that fails, a backup
 * the user stopped — must not have a closing frame drawn over its last one,
 * reading as a step that finished. So disposal only stops the clock and closes
 * the line, and the caller states the one fact only it knows. The text is the
 * caller's because a closing frame need not say what a running one does: the
 * fused pass drops the file it had in hand, since at the end there is none.
 *
 * Use it with `using`, so an abort still stops the clock and leaves the cursor on
 * a fresh line.
 * @param {NodeJS.WriteStream} stream - Usually `process.stderr`
 * @param {() => string} compose - The line as it stands right now. Called only
 *   when a redraw is due and can be written
 * @param {object} options
 * @param {number} options.every - Milliseconds between redraws, on either hand
 * @param {string} [options.opening] - Drawn at once, before the first interval;
 *   absent, the first frame is `compose()`'s
 * @returns {{ tick: () => void, done: (text: string) => void } & Disposable}
 */
export function clockedLine(stream, compose, { every, opening }) {
  const progress = createProgress(stream);
  let live = true;
  let drawnAt = performance.now();
  const redraw = () => {
    drawnAt = performance.now();
    if (progress.due()) {
      progress.update(compose());
    }
  };

  if (progress.due()) {
    progress.update(opening ?? compose());
  }
  // Unconditional on its interval, not gated on `drawnAt` like `tick`: a timer
  // fires a little *early* as often as late, and gating it on a full interval
  // would skip every such firing — halving the cadence of exactly the callers
  // this hand exists for. `unref` so a pending tick can never hold the process
  // open.
  const start = () => {
    const timer = setInterval(redraw, every);
    timer.unref();
    return timer;
  };
  let ticking = start();
  const stop = () => {
    live = false;
    clearInterval(ticking);
  };

  return {
    tick() {
      if (live && performance.now() - drawnAt >= every) {
        // Restart the timer from this draw. Left on its own schedule it would
        // fire however much of an interval remained, and draw again that soon.
        clearInterval(ticking);
        ticking = start();
        redraw();
      }
    },
    /**
     * The pass finished: stop the clock and draw `text` as the final frame. On a
     * terminal it replaces the line in place, and an update the pacing holds is
     * still drawn when the line closes, so it always lands. Off one it writes
     * nothing, like every other frame — a caller whose closing frame is worth a
     * log line writes that itself (see {@link countedPass}).
     * @param {string} text
     */
    done(text) {
      stop();
      progress.update(text);
    },
    [Symbol.dispose]() {
      stop();
      progress[Symbol.dispose]();
    },
  };
}

/**
 * Run a **counted pass**: one line that names what is happening, then carries a
 * running count and the elapsed time, then stays on screen as that step's tally
 * ([ADR-0076](../../docs/adr/0076-one-progress-line-driven-by-a-clock.md)) — a
 * {@link clockedLine} with that one shape. The walk's per-directory
 * `Finding files in '~/src'… 1,204 in 3 secs`, the store scan's
 * `Scanning existing objects in 's3://b'… 312,004 in 12 secs`, and `find`'s two
 * passes over the local snapshots are its callers.
 *
 * **The count is pulled on the line's clock, never pushed by the caller.** That
 * is the whole point rather than a style choice: the walk used to redraw inside
 * its own `for (const path of walkFiles(…))` loop, so the line could only move
 * when the caller reached the next iteration — and `walkFiles` blocks on
 * `readdirSync` per directory, on `resolveFileType`'s `lstatSync` fallback, and
 * yields nothing at all while descending a subtree it keeps no file from. The
 * count *and its clock* froze in exactly the places a user most needs to see the
 * run is alive. A synchronous caller still owes the clock its `tick()` — the
 * walk calls it per entry visited, kept or not, which is what reaches into that
 * subtree — but `tick()` only asks whether a redraw is due; what the line says,
 * and the count it reads, stay here.
 *
 * Use it with `using`, so an abort still leaves the cursor on a fresh line.
 * @param {NodeJS.WriteStream} stream - Usually `process.stderr`
 * @param {string} label - What the pass is doing, conventionally ending in `…`.
 *   Drawn bare before the first count: with a redraw a second away, a slow or
 *   cold step would otherwise sit blank and look hung, and a leading "0" would
 *   be worse than nothing.
 * @param {() => number} count - Read on every redraw for what has been got
 *   through so far. A thunk, not a number, so the pass samples whatever has
 *   really landed at the moment it draws.
 * @returns {{ tick: () => void, done: () => void } & Disposable}
 */
export function countedPass(stream, label, count) {
  const start = Temporal.Now.instant();
  const line = () =>
    `${label} ${formatCount(count())} in ${secondsSince(start)}`;
  const clocked = clockedLine(stream, line, {
    every: COUNTED_TICK_MS,
    opening: label,
  });

  return {
    tick: clocked.tick,
    /**
     * The pass finished: draw its true final tally, whatever the last redraw
     * happened to show. Always drawn, so a step too quick to trigger a single
     * redraw still gets its line. On a terminal it replaces the line in place
     * and disposal supplies the closing newline; off one it is the single plain
     * line a redirected log keeps — which is why this is not `statusLine`, whose
     * own newline disposal would then follow with a second.
     */
    done() {
      const summary = line();
      clocked.done(summary);
      if (!isInteractive(stream)) {
        stream.write(`${summary}\n`);
      }
    },
    [Symbol.dispose]() {
      clocked[Symbol.dispose]();
    },
  };
}
