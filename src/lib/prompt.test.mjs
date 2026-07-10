import assert from "node:assert/strict";
import { PassThrough, Readable, Writable } from "node:stream";
import { describe, it } from "node:test";
import {
  promptHidden,
  promptLine,
  promptYesNo,
  stdinLines,
} from "./prompt.mjs";

// The prompts take injectable streams (their test seam), so parsing is
// exercised without a real terminal. A sink swallows the prompt text.
const sink = () => new Writable({ write: (_c, _e, cb) => cb() });

/**
 * Drive one answer through the prompt.
 * @param {string} answer
 */
const ask = (answer) =>
  promptYesNo("Delete it?", {
    input: Readable.from([`${answer}\n`]),
    output: sink(),
  });

describe("promptYesNo", () => {
  it("treats y / yes (any case) as yes", async () => {
    for (const answer of ["y", "yes", "Y", "YES", " y ", "Yes"]) {
      assert.equal(await ask(answer), true, answer);
    }
  });

  it("treats anything else — including empty — as no (default No)", async () => {
    for (const answer of ["", "n", "no", "nope", "ye", "sure", "1"]) {
      assert.equal(await ask(answer), false, JSON.stringify(answer));
    }
  });

  it("treats a closed stdin (EOF, no answer) as no", async () => {
    assert.equal(
      await promptYesNo("Delete it?", {
        input: Readable.from([]),
        output: sink(),
      }),
      false,
    );
  });
});

describe("promptLine", () => {
  it("returns the first line, trimmed", async () => {
    const line = await promptLine("Name: ", {
      input: Readable.from(["  alpha  \nbeta\n"]),
      output: sink(),
    });
    assert.equal(line, "alpha");
  });

  it("yields '' on a closed stdin (EOF) instead of hanging", async () => {
    const line = await promptLine("Name: ", {
      input: Readable.from([]),
      output: sink(),
    });
    assert.equal(line, "");
  });
});

describe("stdinLines", () => {
  it("reads the requested number of lines through one interface", async () => {
    // One shared interface is load-bearing: two promptLine calls would lose the
    // second line to the first interface's discarded buffer.
    const lines = await stdinLines(2, {
      input: Readable.from(["AKIAEXAMPLE\n  secret  \nextra\n"]),
    });
    assert.deepEqual(lines, ["AKIAEXAMPLE", "secret"]);
  });

  it("returns what it got when stdin ends early", async () => {
    const lines = await stdinLines(2, { input: Readable.from(["only-one\n"]) });
    assert.deepEqual(lines, ["only-one"]);
  });
});

describe("promptHidden", () => {
  /**
   * A fake TTY stream: a PassThrough with the raw-mode knobs promptHidden
   * drives, recording their calls.
   * @param {string[]} chunks
   */
  function fakeTty(chunks) {
    const tty = new PassThrough();
    const calls = { raw: /** @type {boolean[]} */ ([]) };
    Object.assign(tty, {
      setRawMode(/** @type {boolean} */ on) {
        calls.raw.push(on);
        return tty;
      },
    });
    for (const chunk of chunks) {
      tty.write(chunk);
    }
    return {
      tty: /** @type {import("node:tty").ReadStream} */ (
        /** @type {unknown} */ (tty)
      ),
      calls,
    };
  }

  it("collects keystrokes without echoing, until Enter", async () => {
    const { tty, calls } = fakeTty(["hun", "ter2\r"]);
    /** @type {string[]} */
    const written = [];
    const output = new Writable({
      write: (chunk, _e, cb) => {
        written.push(String(chunk));
        cb();
      },
    });

    const value = await promptHidden("Secret: ", { input: tty, output });

    assert.equal(value, "hunter2");
    // Nothing echoed beyond the prompt and the closing newline.
    assert.deepEqual(written, ["Secret: ", "\n"]);
    // Raw mode was switched on, then restored.
    assert.deepEqual(calls.raw, [true, false]);
  });

  it("applies backspace to the unseen buffer", async () => {
    const { tty } = fakeTty(["abcd\u007f\u007fef\r"]);
    const value = await promptHidden("Secret: ", {
      input: tty,
      output: sink(),
    });
    assert.equal(value, "abef");
  });
});
