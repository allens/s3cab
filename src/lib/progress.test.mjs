import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createProgress, statusLine } from "./progress.mjs";

/**
 * A stand-in for `process.stderr` that records every write, with a settable
 * `isTTY` so the TTY gate can be exercised both ways without a real terminal.
 * `readline`'s cursor moves only ever call `.write` on it, so the narrow fake
 * suffices — cast to the full stream type for the interface.
 * @param {boolean} isTTY
 */
function fakeStream(isTTY) {
  /** @type {string[]} */
  const writes = [];
  const stream = {
    isTTY,
    /** @param {string} text */
    write(text) {
      writes.push(text);
      return true;
    },
  };
  return {
    stream: /** @type {NodeJS.WriteStream} */ (/** @type {unknown} */ (stream)),
    writes,
    output: () => writes.join(""),
  };
}

describe("createProgress", () => {
  it("on a terminal, draws each update in place and closes with one newline", () => {
    const { stream, writes, output } = fakeStream(true);
    const progress = createProgress(stream);

    progress.update("first");
    progress.update("second");
    const beforeDispose = output();
    assert.ok(beforeDispose.includes("first"));
    assert.ok(beforeDispose.includes("second"));
    assert.ok(!beforeDispose.includes("\n"), "no newline until disposed");

    progress[Symbol.dispose]();
    assert.equal(writes.at(-1), "\n");
  });

  it("on a terminal with no updates, writes nothing at all", () => {
    const { stream, writes } = fakeStream(true);
    const progress = createProgress(stream);
    progress[Symbol.dispose]();
    assert.deepEqual(writes, []);
  });

  it("parks the cursor at the given column after an update", () => {
    const { stream, output } = fakeStream(true);
    const progress = createProgress(stream);
    progress.update("bar", { cursor: 5 });
    // readline.cursorTo(stream, 5) emits column 5+1 → the last thing written.
    assert.ok(output().endsWith("\x1b[6G"));
    progress[Symbol.dispose]();
  });

  it("off a terminal, stays silent by default", () => {
    const { stream, writes } = fakeStream(false);
    const progress = createProgress(stream);
    progress.update("nope");
    progress.update("still nope");
    progress[Symbol.dispose]();
    assert.deepEqual(writes, []);
  });

  it("off a terminal with logLines, writes one plain line per update and no closing newline", () => {
    const { stream, writes } = fakeStream(false);
    const progress = createProgress(stream, { logLines: true });
    progress.update("Restoring 50/200...");
    progress.update("Restoring 100/200...");
    progress[Symbol.dispose]();
    assert.deepEqual(writes, [
      "Restoring 50/200...\n",
      "Restoring 100/200...\n",
    ]);
  });
});

describe("statusLine", () => {
  it("clears the bar's line first on a terminal, and retains its own", () => {
    // A bar leaves its line un-terminated; a status line has to land over it
    // rather than after it.
    const { stream, output } = fakeStream(true);
    statusLine(stream, "Connection lost");
    assert.match(output(), /Connection lost\n$/);
    assert.ok(
      output().length > "Connection lost\n".length,
      "expected the cursor/clear sequences before the text",
    );
  });

  it("off a terminal is just the plain line", () => {
    const { stream, output } = fakeStream(false);
    statusLine(stream, "Connection lost");
    assert.equal(output(), "Connection lost\n");
  });
});
