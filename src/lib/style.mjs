import { styleText } from "node:util";

// The one shared TTY/decoration gate (clig.dev): in-place animation (progress
// bars, `\r` counters) is gated on the stream being an interactive terminal,
// and *styling* (bold and colours) additionally honours the NO_COLOR convention
// (https://no-color.org — set and non-empty disables) and TERM=dumb. Every
// consumer routes through here — the upload progress bar and restore counter
// (animation), the help renderer's bold headings, and the compare/verify
// section colours (styling) — so redirected output and CI logs never see escape
// codes, decided once.
//
// The decorators wrap `node:util`'s `styleText` (a builtin — ADR-0005/0006 — no
// hand-rolled escapes) with `validateStream: false`, because *this* module owns
// the gate: callers decide whether to decorate (via `styleEnabled`, or the
// dispatcher's `color` flag threaded into a renderer), so `styleText` must not
// second-guess them by re-checking a stream. Colours end with SGR `39`/`22`
// (foreground/bold reset, not a full `0`), so `bold(red(x))` nests cleanly.
/** @param {Parameters<typeof styleText>[0]} format */
const decorate =
  (format) =>
  /** @param {string} text */
  (text) =>
    styleText(format, text, { validateStream: false });

/**
 * Whether a stream is an interactive terminal — the gate for in-place
 * animation. Non-interactive consumers get plain line-per-update output (or a
 * single summary line) instead.
 * @param {{ isTTY?: boolean }} stream - e.g. `process.stderr`
 * @returns {boolean}
 */
export const isInteractive = (stream) => Boolean(stream.isTTY);

/**
 * Whether decorated text (bold; colors when they arrive) may be written to a
 * stream: interactive, `NO_COLOR` unset-or-empty, and `TERM` not `dumb`.
 * @param {{ isTTY?: boolean }} stream - e.g. `process.stdout`
 * @returns {boolean}
 */
export const styleEnabled = (stream) =>
  isInteractive(stream) && !process.env.NO_COLOR && process.env.TERM !== "dumb";

// Bold — the help renderer's headings. Callers gate on `styleEnabled`.
export const bold = decorate("bold");

// Foreground colours for the compare/verify section headers (ADR-0043). Callers
// gate on `styleEnabled` (or a renderer's `color` flag) and colour *headers
// only* — a wall of coloured items is fatiguing (the compare rendering rules).
export const green = decorate("green");
export const cyan = decorate("cyan");
export const yellow = decorate("yellow");
export const red = decorate("red");
