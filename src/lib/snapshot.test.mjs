import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { progressLine } from "./snapshot.mjs";

// The fused pass's one progress line (ADR-0069). `progressLine` takes the width
// and the activities' state rather than reading a terminal or a clock of its
// own, so both the wording and the trimming are assertable off a TTY.

const start = Temporal.Now.instant();
const run = { current: 4182, total: 58310, start };

/**
 * A transfer that began long enough ago to be worth reporting.
 * @param {{ path: string, loaded: number, total: number }} current
 */
const sending = (current) => ({
  sent: 1_200_000_000,
  current: { startedAt: performance.now() - 2000, ...current },
});

/**
 * A hash that began long enough ago to be worth reporting.
 * @param {string} path
 * @param {number} size
 * @param {number} done - Bytes read so far
 */
const hashing = (path, size, done) => ({
  path,
  size,
  startedAt: performance.now() - 2000,
  read: () => done,
});

describe("progressLine", () => {
  it("pads the widest activity to the same column as the shortest", () => {
    // What the padding is *for*: `Uploading 999.9MB (100%)` is the longest the
    // detail gets, and it must not push the path further right than `Hashing 1B`
    // does. It used to, because the text carried its own leading separator and
    // so overflowed the pad width.
    const widest = progressLine({
      ...run,
      state: sending({
        path: "/a.jpg",
        loaded: 999_900_000,
        total: 999_900_000,
      }),
      width: 200,
    });
    const shortest = progressLine({
      ...run,
      // Same run stats, so only the activity differs between the two lines.
      state: { sent: 1_200_000_000, current: null },
      hashing: hashing("/a.jpg", 1, 0),
      width: 200,
    });
    assert.equal(widest.indexOf("/a.jpg"), shortest.indexOf("/a.jpg"));
  });

  it("pads the count to its total, so the columns after it hold still", () => {
    // No label: the pass announced itself once, before the line started.
    const line = progressLine(run);
    assert.equal(line, " 4,182/58,310 in      0s");
  });

  it("shows how far along it is in bytes, which is what the wait is made of", () => {
    const line = progressLine({
      ...run,
      bytesDone: 900_000_000,
      bytesTotal: 2_400_000_000,
    });
    assert.equal(line, " 4,182/58,310   37% of   2.4GB in      0s");
  });

  it("claims no percentage on a first run, which has no baseline to size it", () => {
    // The denominator is the previous snapshot's sizes, so a first backup has
    // none. Counting bytes read against a total of nothing would be 100% from
    // the first file — worse than saying nothing, so it says nothing.
    const line = progressLine({
      ...run,
      bytesDone: 900_000_000,
      bytesTotal: 0,
    });
    assert.equal(line, " 4,182/58,310 in      0s");
  });

  it("grows the total rather than promise a finish it cannot deliver", () => {
    // New files aren't in the baseline, so a pass can read more than the total
    // predicted. The estimate corrects itself upward — the percentage slows
    // down, and never goes past 100.
    const line = progressLine({
      ...run,
      bytesDone: 3_000_000_000,
      bytesTotal: 2_400_000_000,
    });
    assert.equal(line, " 4,182/58,310  100% of   3.0GB in      0s");
  });

  it("holds the columns after it still as the percentage gains a digit", () => {
    const early = progressLine({
      ...run,
      bytesDone: 24_000_000,
      bytesTotal: 2_400_000_000,
      state: { sent: 1_200_000_000, current: null },
    });
    const late = progressLine({
      ...run,
      bytesDone: 2_400_000_000,
      bytesTotal: 2_400_000_000,
      state: { sent: 1_200_000_000, current: null },
    });
    assert.equal(early.indexOf("Uploaded"), late.indexOf("Uploaded"));
  });

  it("adds the bytes gone up when the pass is also sending", () => {
    const line = progressLine({
      ...run,
      state: { sent: 1_200_000_000, current: null },
    });
    assert.equal(line, " 4,182/58,310  Uploaded   1.2GB in      0s");
  });

  it("names a multipart upload with its size and a parenthetical percentage", () => {
    const line = progressLine({
      ...run,
      state: sending({
        path: "D:\\Videos\\holiday.MOV",
        loaded: 1_320_000_000,
        total: 2_400_000_000,
      }),
    });
    assert.match(
      line,
      /Uploading 2\.4GB \(55%\)\s+D:\\Videos\\holiday\.MOV$/,
      line,
    );
  });

  it("claims no percentage for a single PUT, which reports only at the end", () => {
    // Below the multipart threshold `loaded` stays 0 for the whole transfer, so
    // "0%" would dress up "nothing has come back yet" as a measurement.
    const line = progressLine({
      ...run,
      state: sending({
        path: "D:\\Pictures\\P1060735.JPG",
        loaded: 0,
        total: 1_500_000,
      }),
    });
    assert.ok(!line.includes("%"), `got ${line}`);
    assert.match(line, /Uploading 1\.5MB\s+D:\\Pictures\\P1060735\.JPG$/, line);
  });

  it("names a slow hash the same way, from the bytes read so far", () => {
    const line = progressLine({
      ...run,
      hashing: hashing("D:\\Scans\\big.psd", 1_800_000_000, 864_000_000),
    });
    assert.match(line, /Hashing 1\.8GB \(48%\)\s+D:\\Scans\\big\.psd$/, line);
  });

  it("reports nothing for work that has not been going a second", () => {
    // The rule that keeps tens of thousands of fast files from flickering past:
    // a row earns its name only by taking long enough to read.
    const justStarted = {
      sent: 0,
      current: {
        path: "D:\\Pictures\\quick.jpg",
        loaded: 0,
        total: 1_500_000,
        startedAt: performance.now(),
      },
    };
    const line = progressLine({ ...run, state: justStarted });
    assert.equal(line, " 4,182/58,310  Uploaded      0B in      0s");
  });

  it("prefers the upload when both are somehow in flight", () => {
    const line = progressLine({
      ...run,
      state: sending({
        path: "D:\\Videos\\holiday.MOV",
        loaded: 1_320_000_000,
        total: 2_400_000_000,
      }),
      hashing: hashing("D:\\Scans\\big.psd", 1_800_000_000, 864_000_000),
    });
    assert.ok(line.includes("Uploading"), `got ${line}`);
    assert.ok(!line.includes("Hashing"), `got ${line}`);
  });

  it("keeps the end of a path too long for the line", () => {
    const line = progressLine({
      ...run,
      state: sending({
        path: "D:\\OneDrive\\Pictures\\Australia 2016\\IMG_20160117_104801.jpg",
        loaded: 1_100_000,
        total: 2_200_000,
      }),
      width: 110,
    });
    assert.ok(
      line.length < 110,
      `expected under 110 columns, got ${line.length}`,
    );
    assert.ok(
      line.endsWith("IMG_20160117_104801.jpg"),
      `expected the file name to survive, got ${line}`,
    );
  });

  it("drops the path rather than print a stub of it, and keeps the figures", () => {
    const line = progressLine({
      ...run,
      state: sending({
        path: "/some/very/long/path.jpg",
        loaded: 0,
        total: 1_500_000,
      }),
      width: 65,
    });
    assert.ok(
      line.length < 65,
      `expected under 65 columns, got ${line.length}`,
    );
    // Ending on the figures is itself the proof no path stub followed them.
    assert.match(line, /Uploading 1\.5MB$/, line);
  });

  it("keeps the figures at the width where they fit exactly without a path", () => {
    // The boundary the two budgets exist for: one more column than this sheds
    // nothing, one fewer sheds the detail, and budgeting both layouts against
    // the wider one would shed it here — where it fits.
    const state = sending({
      path: "/some/very/long/path.jpg",
      loaded: 0,
      total: 1_500_000,
    });
    const exact = progressLine({ ...run, state, width: 60 });
    assert.match(exact, /Uploading 1\.5MB$/, exact);
    assert.equal(exact.length, 59);
    const narrower = progressLine({ ...run, state, width: 59 });
    assert.match(narrower, /in\s+0s$/, narrower);
  });

  it("sheds the whole detail when even the figures will not fit", () => {
    const line = progressLine({
      ...run,
      state: sending({
        path: "/some/very/long/path.jpg",
        loaded: 0,
        total: 1_500_000,
      }),
      width: 55,
    });
    assert.ok(
      line.length < 55,
      `expected under 55 columns, got ${line.length}`,
    );
    assert.match(line, /in\s+0s$/, line);
  });
});
