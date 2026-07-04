import { createInterface } from "node:readline/promises";

// s3cab's first (and, for now, only) interactive prompt — the y/N confirmation
// the destructive commands use (`delete`, and later `cleanup --delete`). The
// clig.dev rules the cli-design skill distils (docs/design/backup.md): **prompt
// only when stdin is a terminal** (the caller gates on `isInteractive`), **never
// *require* it** (a non-interactive run proceeds on the explicit flag/args
// instead of blocking), and **write the prompt to stderr** so stdout stays
// data-only. Defaulting to No means a stray Enter/EOF cancels rather than deletes.

/**
 * Ask a yes/No question at the terminal and return the answer, defaulting to No.
 * The prompt is written to **stderr** and the reply read from stdin; only "y" or
 * "yes" (case-insensitive) is a yes, so anything else — including an empty line
 * or a closed stdin — is No. Call only when stdin is interactive
 * (`isInteractive(process.stdin)`); a non-interactive caller must decide without
 * prompting (clig.dev: never block a script on a prompt).
 * @param {string} question - The question, without the trailing "[y/N]"
 * @param {object} [streams] - Overridable I/O (defaults wired to the process),
 *   the seam that lets a test drive the prompt without a real terminal.
 * @param {import("node:stream").Readable} [streams.input] - Where the answer is read (default stdin)
 * @param {import("node:stream").Writable} [streams.output] - Where the prompt is written (default stderr)
 * @returns {Promise<boolean>} Whether the user answered yes
 */
export async function promptYesNo(
  question,
  { input = process.stdin, output = process.stderr } = {},
) {
  output.write(`${question} [y/N] `);
  // `terminal: false` keeps readline in cooked mode: it never echoes or writes to
  // any stream itself (the terminal handles the visible keystroke echo natively),
  // so stdout stays data-only even on a TTY — we've already written the prompt to
  // `output` (stderr) above.
  const rl = createInterface({ input, terminal: false });
  try {
    // The line iterator resolves on the first line *or completes on EOF* (a
    // closed stdin), where `rl.question` would hang waiting for input that never
    // comes — so a piped/empty stdin cleanly defaults to No.
    const { value } = await rl[Symbol.asyncIterator]().next();
    return /^y(es)?$/i.test((value ?? "").trim());
  } finally {
    rl.close();
  }
}
