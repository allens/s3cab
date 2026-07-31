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
  it("pads the count to its total, so the columns after it hold still", () => {
    // No label: the pass announced itself once, before the line started.
    const line = progressLine(run);
    assert.equal(line, " 4,182/58,310 in      0s");
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
    assert.ok(
      line.endsWith("Uploading 2.4GB (55%) D:\\Videos\\holiday.MOV"),
      `got ${line}`,
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
