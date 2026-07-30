import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { progressLine } from "./snapshot.mjs";

// The fused pass's one progress line (ADR-0069). `progressLine` takes the width
// rather than reading the terminal, so the trimming is assertable off a TTY.

const start = Temporal.Now.instant();

describe("progressLine", () => {
  it("counts files, and says nothing about sending when nothing is sent", () => {
    const line = progressLine({
      label: "Generating snapshot file…",
      current: 4182,
      total: 58310,
      start,
    });
    assert.equal(
      line,
      "Generating snapshot file… 4,182 of 58,310 files in 0 sec",
    );
  });

  it("adds the bytes gone up when the pass is also sending", () => {
    const line = progressLine({
      label: "Backing up…",
      current: 4182,
      total: 58310,
      start,
      state: { sent: 1_200_000_000, current: null },
    });
    assert.equal(
      line,
      "Backing up… 4,182 of 58,310 files · 1.2GB sent in 0 sec",
    );
  });

  it("suffixes the file on the wire with its own progress", () => {
    const line = progressLine({
      label: "Backing up…",
      current: 4182,
      total: 58310,
      start,
      state: {
        sent: 1_200_000_000,
        current: { path: "D:\\Pictures\\ragged.jpg", loaded: 55, total: 100 },
      },
    });
    assert.match(line, /55% of 100B D:\\Pictures\\ragged\.jpg$/);
  });

  it("claims no percentage until a byte has been reported", () => {
    // A sub-multipart file is one PUT, reported once at the end — so `loaded` is
    // 0 for its whole transfer, and "0%" would be a measurement we don't have.
    const line = progressLine({
      label: "Backing up…",
      current: 151602,
      total: 265753,
      start,
      state: {
        sent: 60_100_000,
        current: {
          path: "D:\\Pictures\\P1060735.JPG",
          loaded: 0,
          total: 1_500_000,
        },
      },
    });
    assert.ok(!line.includes("%"), `got ${line}`);
    assert.ok(line.endsWith("1.5MB D:\\Pictures\\P1060735.JPG"), `got ${line}`);
  });

  it("keeps the end of a path too long for the line", () => {
    const line = progressLine({
      label: "Backing up…",
      current: 1,
      total: 1,
      start,
      state: {
        sent: 0,
        current: {
          path: "D:\\OneDrive\\Pictures\\Australia 2016\\IMG_20160117_104801.jpg",
          loaded: 0,
          total: 100,
        },
      },
      width: 100,
    });
    assert.ok(
      line.length < 100,
      `expected under 100 columns, got ${line.length}`,
    );
    assert.ok(
      line.endsWith("IMG_20160117_104801.jpg"),
      `expected the file name to survive, got ${line}`,
    );
    assert.match(line, /…/, "expected an ellipsis marking the trimmed head");
  });

  it("drops the path rather than print a stub of it, and keeps the figures", () => {
    const line = progressLine({
      label: "Backing up…",
      current: 1,
      total: 1,
      start,
      state: {
        sent: 0,
        current: { path: "/some/very/long/path.jpg", loaded: 0, total: 100 },
      },
      width: 60,
    });
    assert.ok(
      line.length < 60,
      `expected under 60 columns, got ${line.length}`,
    );
    // Ending on the figures is itself the proof no path stub followed them.
    assert.ok(line.endsWith("100B"), `got ${line}`);
  });
});
