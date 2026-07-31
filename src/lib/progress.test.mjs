import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { setTimeout } from "node:timers/promises";
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
  it("on a terminal, draws in place and closes with one newline", () => {
    const { stream, writes, output } = fakeStream(true);
    const progress = createProgress(stream);

    progress.update("first");
    const beforeDispose = output();
    assert.ok(beforeDispose.includes("first"));
    assert.ok(!beforeDispose.includes("\n"), "no newline until disposed");

    progress[Symbol.dispose]();
    assert.equal(writes.at(-1), "\n");
  });

  it("writes the text before clearing, so the line is never blanked", () => {
    // The flicker fix: clearing to end-of-line *after* the text leaves the same
    // end state with no empty-line window for the terminal to repaint.
    const { stream, writes } = fakeStream(true);
    const progress = createProgress(stream);
    progress.update("counting");
    progress[Symbol.dispose]();
    const text = writes.indexOf("counting");
    const clear = writes.findIndex((write) => write.includes("\x1b[0K"));
    assert.ok(text !== -1 && clear !== -1, "expected both a write and a clear");
    assert.ok(text < clear, "expected the text to be written before the clear");
  });

  it("holds an update that arrives inside the redraw interval", () => {
    const { stream, output } = fakeStream(true);
    const progress = createProgress(stream);

    progress.update("first");
    progress.update("second");
    assert.ok(!output().includes("second"), "expected the second to be held");

    // …and releases it when the line closes, so the final state always lands.
    progress[Symbol.dispose]();
    assert.ok(output().includes("second"));
  });

  it("draws again once the redraw interval has passed", async () => {
    const { stream, output } = fakeStream(true);
    const progress = createProgress(stream);

    progress.update("first");
    assert.equal(progress.due(), false);
    await setTimeout(150);
    assert.equal(progress.due(), true);

    progress.update("second");
    assert.ok(output().includes("second"));
    progress[Symbol.dispose]();
  });

  it("clear wipes the line and leaves nothing behind on disposal", () => {
    const { stream, writes, output } = fakeStream(true);
    const progress = createProgress(stream);

    progress.update("uploading");
    progress.clear();
    progress[Symbol.dispose]();
    // The text was written, then cleared — and with nothing left standing there
    // is no closing newline either, so the next line starts at column 0.
    assert.ok(output().includes("uploading"));
    assert.ok(!output().includes("\n"), "expected no retained line");
    assert.ok(writes.at(-1)?.includes("\x1b[0K"), "expected a trailing clear");
  });

  it("clear drops a held update, so disposal cannot resurrect it", () => {
    const { stream, output } = fakeStream(true);
    const progress = createProgress(stream);

    progress.update("first");
    progress.update("held"); // inside the redraw interval
    progress.clear();
    progress[Symbol.dispose]();
    assert.ok(!output().includes("held"));
  });

  it("clear is a no-op off a terminal — a log does not retract lines", () => {
    const { stream, writes } = fakeStream(false);
    const progress = createProgress(stream, { logLines: true });
    progress.update("Uploaded a.jpg");
    progress.clear();
    progress[Symbol.dispose]();
    assert.deepEqual(writes, ["Uploaded a.jpg\n"]);
  });

  it("is never due off a terminal, so a hot-path caller skips its rendering", () => {
    const { stream } = fakeStream(false);
    const progress = createProgress(stream);
    assert.equal(progress.due(), false);
    // …but a logged run still is, since those updates do get written.
    const logged = createProgress(fakeStream(false).stream, { logLines: true });
    assert.equal(logged.due(), true);
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

  it("off a terminal with logLines, writes plain lines and no closing newline", () => {
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
