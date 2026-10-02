import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { setTimeout } from "node:timers/promises";
import {
  clockedLine,
  countedPass,
  createProgress,
  statusLine,
} from "./progress.mjs";

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

describe("countedPass", () => {
  // The clock is mocked (`setInterval` only, so the real promisified
  // `setTimeout` below still sleeps) because ticking at the true 1-second
  // cadence would put whole seconds into the suite. The short real sleeps are
  // not the tick — they clear `createProgress`' own MIN_REDRAW_MS pacing, which
  // would otherwise hold each tick's update as pending and hide the redraw this
  // is here to observe.
  const PAST_REDRAW_INTERVAL = 150;

  it("paints the label bare, before there is any count to show", () => {
    const { stream, output } = fakeStream(true);
    const pass = countedPass(stream, "Finding files in '~/src'…", () => 0);
    assert.ok(output().includes("Finding files in '~/src'…"));
    // A leading "0" would be worse than nothing on a slow or cold step.
    assert.ok(
      !output().includes(" 0 in "),
      "expected no count in the first paint",
    );
    pass[Symbol.dispose]();
  });

  it("redraws on its timer for a caller waiting on I/O, which never ticks", async (t) => {
    // The store LIST and `find`'s passes spend their time awaiting I/O — a LIST
    // round trip, a snapshot file streamed in — which turns the event loop on
    // every read, so the timer alone keeps their line moving, and they never
    // call `tick()`. Here the caller never
    // touches the pass again after creating it; the awaited sleeps are the turn.
    t.mock.timers.enable({ apis: ["setInterval"] });
    const { stream, output } = fakeStream(true);
    let found = 0;
    const pass = countedPass(stream, "Finding files…", () => found);

    found = 1204;
    await setTimeout(PAST_REDRAW_INTERVAL);
    t.mock.timers.tick(1000);
    assert.match(output(), /1,204/, "expected the first tick to draw");

    found = 265716;
    await setTimeout(PAST_REDRAW_INTERVAL);
    t.mock.timers.tick(1000);
    assert.match(output(), /265,716/, "expected the clock to keep drawing");

    pass[Symbol.dispose]();
  });

  it("done draws the true tally even when no redraw ever fired", () => {
    // A step too quick to trigger a single tick still gets its line, and the
    // figure is the count at the end rather than whatever a redraw last showed.
    const { stream, output } = fakeStream(true);
    const pass = countedPass(stream, "Scanning…", () => 7);
    pass.done();
    pass[Symbol.dispose]();
    assert.match(output(), /Scanning… 7 in /);
  });

  it("an aborted pass gets no tally — the line just closes", () => {
    // `done` is never called when the walk throws on a duplicate path or the
    // store scan's LIST fails. A tally drawn from disposal would print
    // "… 1,204 in 3 secs" directly above the error saying the pass failed.
    const { stream, output } = fakeStream(true);
    const pass = countedPass(stream, "Finding files…", () => 1204);
    pass[Symbol.dispose]();
    assert.ok(output().includes("Finding files…"), "the bare label was drawn");
    assert.ok(
      !output().includes("1,204"),
      "expected no tally for an aborted pass",
    );
  });

  it("stops ticking once done, so nothing redraws over the tally", async (t) => {
    t.mock.timers.enable({ apis: ["setInterval"] });
    const { stream, output } = fakeStream(true);
    let count = 5;
    const pass = countedPass(stream, "Scanning…", () => count);
    pass.done();

    count = 999;
    await setTimeout(PAST_REDRAW_INTERVAL);
    t.mock.timers.tick(5000);
    pass[Symbol.dispose]();
    assert.ok(
      !output().includes("999"),
      "expected the clock to stop with the pass",
    );
  });

  it("off a terminal, the tally is the only thing written", () => {
    // No animation, no bare label, no closing newline from disposal — one plain
    // line, which is the whole record a redirected log or CI keeps of the step.
    const { stream, writes } = fakeStream(false);
    const pass = countedPass(
      stream,
      "Scanning existing objects…",
      () => 312004,
    );
    pass.done();
    pass[Symbol.dispose]();
    assert.equal(writes.length, 1);
    assert.match(
      writes[0] ?? "",
      /^Scanning existing objects… 312,004 in .+\n$/,
    );
  });

  it("composes nothing on a tick that cannot be written", async (t) => {
    // Off a terminal `update` declines the draw — but its argument is built
    // first, so an ungated tick would do Intl and Temporal work once a second
    // for the whole pass and discard it. The count thunk is the witness: it is
    // only ever read to compose a line.
    t.mock.timers.enable({ apis: ["setInterval"] });
    const { stream, writes } = fakeStream(false);
    let reads = 0;
    const pass = countedPass(stream, "Scanning…", () => {
      reads++;
      return 5;
    });

    t.mock.timers.tick(10_000);
    assert.equal(reads, 0, "expected no line to be composed");

    // …and the tally still lands, since off a terminal that one line is the
    // whole record of the step.
    pass.done();
    pass[Symbol.dispose]();
    assert.equal(reads, 1);
    assert.equal(writes.length, 1);
  });

  it("off a terminal, an aborted pass writes nothing", () => {
    const { stream, writes } = fakeStream(false);
    const pass = countedPass(stream, "Finding files…", () => 42);
    pass[Symbol.dispose]();
    assert.deepEqual(writes, []);
  });
});

describe("clockedLine", () => {
  it("keeps drawing on tick() while its caller never yields to the event loop", (t) => {
    // The fault this hand exists for (ADR-0093): the walk is a synchronous loop
    // and the fused pass is synchronous work in `async` clothing, so neither
    // lets a timer fire. Mocking `setInterval` and never advancing it makes the
    // timer dead here too — every frame after the opening one is the tick's.
    // The spin is real time, because `mock.timers` does not move
    // `performance.now()`; it is short because the interval is.
    t.mock.timers.enable({ apis: ["setInterval"] });
    const { stream, writes } = fakeStream(true);
    let items = 0;
    const line = clockedLine(stream, () => `item ${items}`, { every: 120 });

    const until = performance.now() + 400;
    while (performance.now() < until) {
      items++;
      line.tick();
    }
    line[Symbol.dispose]();

    const frames = writes.filter((text) => text.startsWith("item "));
    assert.ok(
      frames.length >= 3,
      `expected the opening frame and at least two ticked ones, got ${JSON.stringify(frames)}`,
    );
  });

  it("a tick that draws restarts the timer, so the timer never draws an interval early", async (t) => {
    // The fused pass mixes the hands: rows tick, and an upload's awaited I/O
    // lets the timer fire. Left on its own schedule, a timer firing after a
    // tick's draw would redraw sooner than `every` — `createProgress` lets
    // anything past its own 100ms floor through. The mocked clock and the real
    // one are separate here: the tick's gate reads `performance.now()`, the
    // timer only moves when the test moves it.
    t.mock.timers.enable({ apis: ["setInterval"] });
    const { stream } = fakeStream(true);
    let composed = 0;
    const line = clockedLine(stream, () => `${++composed}`, {
      every: 200,
      opening: "Starting…",
    });

    // Most of an interval passes on the timer's clock…
    t.mock.timers.tick(150);
    // …while the caller, never yielding, ticks until one is due on the real one.
    const until = performance.now() + 5000;
    while (composed === 0 && performance.now() < until) {
      line.tick();
    }
    assert.equal(composed, 1, "expected a tick to draw");

    // Clear `createProgress`' floor, so a timer draw now would be let through.
    await setTimeout(150);
    t.mock.timers.tick(100);
    assert.equal(
      composed,
      1,
      "expected no timer draw within `every` of the tick's",
    );

    t.mock.timers.tick(100);
    assert.equal(composed, 2, "expected the timer to draw a full interval on");
    line[Symbol.dispose]();
  });

  it("a tick inside the interval composes nothing", (t) => {
    // Called once per directory entry, so the common case has to be a clock
    // read and a compare — never a line built and declined.
    t.mock.timers.enable({ apis: ["setInterval"] });
    const { stream } = fakeStream(true);
    let composed = 0;
    const line = clockedLine(stream, () => `${++composed}`, {
      every: 60_000,
      opening: "Starting…",
    });
    for (let i = 0; i < 1000; i++) {
      line.tick();
    }
    line[Symbol.dispose]();
    assert.equal(composed, 0);
  });

  it("off a terminal, a tick composes nothing", (t) => {
    // The same gate the timer has: nothing would be written, so nothing is built.
    t.mock.timers.enable({ apis: ["setInterval"] });
    const { stream, writes } = fakeStream(false);
    let composed = 0;
    const line = clockedLine(stream, () => `${++composed}`, { every: 0 });
    line.tick();
    line[Symbol.dispose]();
    assert.equal(composed, 0);
    assert.deepEqual(writes, []);
  });

  it("done is the last frame: a tick after it draws nothing over it", (t) => {
    t.mock.timers.enable({ apis: ["setInterval"] });
    const { stream, output } = fakeStream(true);
    const line = clockedLine(stream, () => "still running", {
      every: 0,
      opening: "Starting…",
    });
    line.done("finished");
    line.tick();
    line[Symbol.dispose]();
    assert.ok(output().includes("finished"));
    assert.ok(!output().includes("still running"));
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
