// A terminal recording in asciinema's cast v2 format
// (https://docs.asciinema.org/manual/asciicast/v2/): a JSON header line, then
// one `[seconds, "o", text]` line per write to the terminal. The timing is
// made up — each command typed at an even pace, its output a line at a time —
// so the same steps always make the same recording.

/**
 * A command typed at the prompt, and everything it printed.
 * @typedef {{ command: string, output: string }} Step
 */

/** The docs' own prompt (README.md's transcripts). */
export const PROMPT = "> ";

// Milliseconds: before the first prompt, per key typed, from the last key to
// Enter, per line of output, and after a command's output, for reading it.
const START = 500;
const KEY = 50;
const ENTER = 400;
const LINE = 60;
const READ = 1500;

// The terminal's rows: enough for one command's report at a time, the way a
// real terminal scrolls the one before it away.
const ROWS = 16;

/**
 * The whole session as the terminal ends up showing it.
 * @param {Step[]} steps
 */
export const transcript = (steps) =>
  steps
    .map(({ command, output }) => `${PROMPT}${command}\n${output}`)
    .join("") + PROMPT;

/**
 * The cast of `steps`, as wide as its longest line.
 * @param {string} title
 * @param {Step[]} steps
 * @returns {string}
 */
export function cast(title, steps) {
  const lines = transcript(steps).split("\n");
  const header = {
    version: 2,
    width: Math.max(80, ...lines.map((line) => [...line].length)),
    height: Math.min(lines.length, ROWS),
    title,
  };
  /** @type {[number, "o", string][]} */
  const events = [];
  // Whole milliseconds, so no time is a float sum's rounding.
  let at = 0;
  /**
   * @param {number} after
   * @param {string} text
   */
  const write = (after, text) => {
    at += after;
    // A terminal moves to a new line on CR LF.
    events.push([at / 1000, "o", text.replaceAll("\n", "\r\n")]);
  };
  for (const [i, { command, output }] of steps.entries()) {
    write(i === 0 ? START : READ, PROMPT);
    for (const key of command) {
      write(KEY, key);
    }
    write(ENTER, "\n");
    for (const line of output.split(/(?<=\n)/)) {
      write(LINE, line);
    }
  }
  write(READ, PROMPT);
  return [header, ...events]
    .map((line) => `${JSON.stringify(line)}\n`)
    .join("");
}
