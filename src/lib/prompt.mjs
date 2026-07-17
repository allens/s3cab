import { createInterface } from "node:readline/promises";

/** @import { Readable, Writable } from "node:stream" */
/** @import { ReadStream } from "node:tty" */

// s3cab's interactive prompts: the y/N confirmation the destructive commands
// use (`delete`, `cleanup --delete`) and the line/hidden-line readers behind
// `provider --keys` (ADR-0047 — secrets are never taken via flags, so the
// prompt/stdin pair is the sanctioned entry). The clig.dev rules the cli-design
// skill distils: **prompt only when stdin is a terminal** (the caller gates on
// `isInteractive`), **never *require* it** (a non-interactive run reads stdin
// lines or proceeds on explicit flags instead of blocking), and **write the
// prompt to stderr** so stdout stays data-only.

/**
 * Read one line, optionally preceded by a prompt. The prompt is written to
 * **stderr** and the reply read from stdin; EOF (a closed/empty stdin) yields
 * `""` rather than hanging. One line per call only — closing the readline
 * interface discards anything it buffered past the first line, so reading
 * *several* piped lines needs {@link stdinLines}, not repeated calls.
 * @param {string} question - The prompt text
 * @param {object} [streams] - Overridable I/O (defaults wired to the process),
 *   the seam that lets a test drive the prompt without a real terminal.
 * @param {Readable} [streams.input] - Where the answer is read (default stdin)
 * @param {Writable} [streams.output] - Where the prompt is written (default stderr)
 * @returns {Promise<string>} The line, trimmed
 */
export async function promptLine(
  question,
  { input = process.stdin, output = process.stderr } = {},
) {
  if (question) {
    output.write(question);
  }
  // `terminal: false` keeps readline in cooked mode: it never echoes or writes to
  // any stream itself (the terminal handles the visible keystroke echo natively),
  // so stdout stays data-only even on a TTY — the prompt already went to `output`.
  const rl = createInterface({ input, terminal: false });
  try {
    // The line iterator resolves on the first line *or completes on EOF* (a
    // closed stdin), where `rl.question` would hang waiting for input that never
    // comes — so a piped/empty stdin cleanly yields "".
    const { value } = await rl[Symbol.asyncIterator]().next();
    return (value ?? "").trim();
  } finally {
    rl.close();
  }
}

/**
 * Read the first `count` lines from a non-interactive stdin through ONE
 * readline interface — the script-facing input path (e.g.
 * `printf '%s\n%s\n' "$ID" "$SECRET" | s3cab provider --keys`). A single
 * interface is load-bearing: closing one discards its buffered remainder, so
 * two `promptLine` calls would lose every line after the first. EOF short:
 * missing lines are simply absent from the result.
 * @param {number} count - How many lines to read
 * @param {object} [streams] - Overridable input, the test seam.
 * @param {Readable} [streams.input]
 * @returns {Promise<string[]>} Up to `count` lines, each trimmed
 */
export async function stdinLines(count, { input = process.stdin } = {}) {
  const rl = createInterface({ input, terminal: false });
  /** @type {string[]} */
  const lines = [];
  try {
    for await (const line of rl) {
      lines.push(line.trim());
      if (lines.length === count) {
        break;
      }
    }
  } finally {
    rl.close();
  }
  return lines;
}

/**
 * Ask a yes/No question at the terminal and return the answer, defaulting to No.
 * Only "y" or "yes" (case-insensitive) is a yes, so anything else — including an
 * empty line or a closed stdin — is No (a stray Enter/EOF cancels rather than
 * deletes). Call only when stdin is interactive (`isInteractive(process.stdin)`);
 * a non-interactive caller must decide without prompting.
 * @param {string} question - The question, without the trailing "[y/N]"
 * @param {Parameters<typeof promptLine>[1]} [streams]
 * @returns {Promise<boolean>} Whether the user answered yes
 */
export async function promptYesNo(question, streams) {
  const answer = await promptLine(`${question} [y/N] `, streams);
  return /^y(es)?$/i.test(answer);
}

/**
 * Read one line with the terminal echo off — for secrets. Sudo-style: raw mode,
 * nothing rendered per keystroke (no `*` masking), backspace edits the unseen
 * buffer, Enter finishes, Ctrl-C exits with the conventional SIGINT code (130)
 * after restoring the terminal. Call only when stdin is an interactive terminal
 * (raw mode needs a TTY); the non-interactive path is `promptLine("")`.
 * @param {string} question - The prompt text (written to stderr)
 * @param {object} [streams] - Overridable I/O, the test seam.
 * @param {ReadStream} [streams.input]
 * @param {Writable} [streams.output]
 * @returns {Promise<string>} The line, trimmed
 */
export function promptHidden(
  question,
  { input = process.stdin, output = process.stderr } = {},
) {
  return new Promise((resolve) => {
    output.write(question);
    input.setRawMode(true);
    input.resume();
    let value = "";
    /** @param {Buffer | string} chunk */
    const onData = (chunk) => {
      for (const char of chunk.toString("utf8")) {
        if (char === "\r" || char === "\n") {
          input.off("data", onData);
          input.setRawMode(false);
          input.pause();
          output.write("\n");
          resolve(value.trim());
          return;
        }
        if (char === "\u0003") {
          // Ctrl-C: raw mode swallows the signal, so restore the terminal and
          // exit as an interrupt would.
          input.setRawMode(false);
          output.write("\n");
          process.exit(130);
        }
        if (char === "\u007f" || char === "\b") {
          value = value.slice(0, -1);
        } else {
          value += char;
        }
      }
    };
    input.on("data", onData);
  });
}
