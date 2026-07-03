// The one shared TTY/decoration gate (clig.dev): in-place animation (progress
// bars, `\r` counters) is gated on the stream being an interactive terminal,
// and *styling* (bold, and colors when they arrive) additionally honours the
// NO_COLOR convention (https://no-color.org — set and non-empty disables) and
// TERM=dumb. Every consumer routes through here — the upload progress bar and
// restore counter (animation), and the help renderer's bold headings (styling)
// — so redirected output and CI logs never see escape codes, decided once.

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

/**
 * Wrap text in ANSI bold. Callers gate on `styleEnabled` — this just decorates
 * (`22` ends bold without resetting other attributes, unlike `0`).
 * @param {string} text
 * @returns {string}
 */
export const bold = (text) => `\x1b[1m${text}\x1b[22m`;
