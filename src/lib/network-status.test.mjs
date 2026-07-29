import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { enterNetworkWait, leaveNetworkWait } from "./network-status.mjs";

/**
 * A stand-in for `process.stderr` that records every write, with a settable
 * `isTTY` so the terminal gate can be exercised both ways. Mirrors the fake in
 * progress.test.mjs — `readline`'s cursor moves only ever call `.write`.
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
    output: () => writes.join(""),
  };
}

const WINDOW = 120_000;
/** The escape byte readline's cursor moves start with. */
const ESC = "";

// The module holds one outage's state, so every test here balances its enters
// and leaves — which returns the count to zero and leaves the next test a clean
// slate. That is also the invariant the relay relies on (its `finally`), so
// testing it this way exercises the real contract rather than a reset hatch.
describe("network wait reporting", () => {
  it("announces the outage once, however many requests are waiting", () => {
    // The case this exists for: 32 multipart parts in flight all fail at once.
    const { stream, output } = fakeStream(false);
    for (let part = 0; part < 32; part++) {
      enterNetworkWait(stream, WINDOW);
    }
    const announcements = output().match(/Connection lost/g) ?? [];
    assert.equal(
      announcements.length,
      1,
      "32 concurrent parts must not print 32 lines",
    );
    for (let part = 0; part < 32; part++) {
      leaveNetworkWait(stream, { recovered: true });
    }
  });

  it("reports recovery only once the last request is through", () => {
    const { stream, output } = fakeStream(false);
    enterNetworkWait(stream, WINDOW);
    enterNetworkWait(stream, WINDOW);

    leaveNetworkWait(stream, { recovered: true });
    assert.ok(
      !output().includes("Back online"),
      "one request finishing does not mean the outage is over",
    );

    leaveNetworkWait(stream, { recovered: true });
    assert.match(output(), /Back online after .+ — continuing\./);
  });

  it("says nothing about recovery when nothing got through", () => {
    // The run is about to fail; its error explains why. Claiming "back online"
    // here would simply be false.
    const { stream, output } = fakeStream(false);
    enterNetworkWait(stream, WINDOW);
    leaveNetworkWait(stream, { recovered: false });
    assert.match(output(), /Connection lost/);
    assert.ok(!output().includes("Back online"));
  });

  it("counts a partial recovery as recovery", () => {
    // One part failing while the others got through still means the link came
    // back — the failure gets reported on its own terms.
    const { stream, output } = fakeStream(false);
    enterNetworkWait(stream, WINDOW);
    enterNetworkWait(stream, WINDOW);
    leaveNetworkWait(stream, { recovered: true });
    leaveNetworkWait(stream, { recovered: false });
    assert.match(output(), /Back online/);
  });

  it("starts a fresh outage after the previous one closed", () => {
    const { stream, output } = fakeStream(false);
    enterNetworkWait(stream, WINDOW);
    leaveNetworkWait(stream, { recovered: true });
    enterNetworkWait(stream, WINDOW);
    leaveNetworkWait(stream, { recovered: true });
    assert.equal(
      (output().match(/Connection lost/g) ?? []).length,
      2,
      "a second drop is news again",
    );
  });

  it("names the caller's own window, so the sentence can't drift", () => {
    const { stream, output } = fakeStream(false);
    enterNetworkWait(stream, 120_000);
    leaveNetworkWait(stream, { recovered: true });
    assert.match(output(), /up to 2 minutes/);

    const short = fakeStream(false);
    enterNetworkWait(short.stream, 30_000);
    leaveNetworkWait(short.stream, { recovered: true });
    assert.match(short.output(), /up to 30 seconds/);
  });

  it("clears the progress bar's line on a terminal, and only there", () => {
    const tty = fakeStream(true);
    enterNetworkWait(tty.stream, WINDOW);
    leaveNetworkWait(tty.stream, { recovered: true });

    const plain = fakeStream(false);
    enterNetworkWait(plain.stream, WINDOW);
    leaveNetworkWait(plain.stream, { recovered: true });

    assert.ok(tty.output().endsWith("\n"), "the line must be retained");
    // Both write the same words; only the terminal also gets the cursor-reset
    // and clear-line sequences that wipe whatever the bar left behind. Compared
    // by length rather than matched literally: asserting on raw escape bytes is
    // brittle and drags control characters into the source.
    assert.ok(
      tty.output().length > plain.output().length,
      "a terminal should also get the cursor/clear sequences",
    );
    assert.ok(
      !plain.output().includes(ESC),
      "a redirected log gets no cursor games",
    );
  });
});
