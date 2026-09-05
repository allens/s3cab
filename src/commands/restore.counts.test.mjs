import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import { s3Seam } from "../../test/helpers/s3-seam.mjs";

// Offline tests for the two counts `restore` puts in front of a user: the
// progress line's running tally, and the refusal when a snapshot's paths aren't
// absolute here. Both are text, so everything around them is faked at the lib
// seam (docs/design/testing.md) — including the restore *planner*, whose own
// behaviour is unit-tested in lib/restore.test.mjs. Faking it is what keeps a
// four-figure plan free of four-figure disk writes: every step is a `skip`, so
// the loop does nothing but count. Argument validation lives in
// restore.test.mjs, the missing-object degrade in restore.missing-object.test.mjs.
// Module-mock ordering (objects.test.mjs) applies: mocks first, then a dynamic
// import of the command.

const BUCKET = "my-backups";

/** The snapshot under test — replaced per test, since each wants its own paths. */
/** @type {{ entries: Map<string, { size: number, mtime: string, hash: string }>, dirs: string[] }} */
let snapshot = { entries: new Map(), dirs: [] };
/** Every line the command handed to the progress display, in order. */
/** @type {string[]} */
let lines = [];

mock.module("../lib/env.mjs", {
  exports: {
    loadSet: (/** @type {string} */ name) => ({ name, bucket: BUCKET }),
  },
});
mock.module("../lib/remote.mjs", {
  exports: {
    listRemoteSnapshots: async () => ["2026-07-19T1200"],
    readRemoteSnapshot: async () => snapshot,
  },
});
mock.module("../lib/restore.mjs", {
  exports: {
    selectEntries: (/** @type {Iterable<string>} */ keys) => [...keys],
    reroot: () => (/** @type {string} */ path) => path,
    // A plan of pure skips: the command's loop counts them and touches nothing.
    planRestore: (/** @type {Map<string, unknown>} */ entries) =>
      [...entries.keys()].map((dest) => ({
        action: "skip",
        dest,
        hash: "aaa",
      })),
  },
});
mock.module("../lib/progress.mjs", {
  exports: {
    createProgress: () => ({
      // Always due, so every redraw is captured rather than sampled by a clock.
      due: () => true,
      update: (/** @type {string} */ line) => lines.push(line),
      [Symbol.dispose]() {},
    }),
  },
});
mock.module("../lib/deletion-record.mjs", {
  exports: { readDeletionRecords: async () => new Map() },
});
// Not seams under test — no plan here ever fetches — but they stand between the
// command and the SDK, so leaving them real drags the whole auth chain in.
mock.module("../lib/objects.mjs", {
  exports: { getObject: async () => assert.fail("a skip must not fetch") },
});
mock.module("../lib/s3.mjs", { exports: s3Seam() });

const { restore } = await import("./restore.mjs");

/** A snapshot of `count` files under `dir`, named `f1`…`fN`. */
const filesUnder = (
  /** @type {string} */ dir,
  /** @type {number} */ count,
) => ({
  entries: new Map(
    Array.from({ length: count }, (_, i) => [
      `${dir}/f${i + 1}.txt`,
      { size: 3, mtime: "2026-07-01T10:00:00.000Z", hash: "aaa" },
    ]),
  ),
  dirs: [dir],
});

describe("restore's progress counter", () => {
  it("groups the counts and pads the running one, so the line holds still", async () => {
    // The same shape the backup pass's `progressLine` draws, for the same
    // reason: left to grow, the count shifts everything after it sideways each
    // time it gains a digit — five times over a six-figure restore.
    snapshot = filesUnder("/data", 1204);
    lines = [];

    await restore([], { set: "photos", output: "/out" });

    assert.equal(lines[0], "Restoring     1/1,204…");
    assert.equal(lines.at(-1), "Restoring 1,204/1,204…");
    // Every line is the same width — which is the whole point of the padding.
    const widths = new Set(lines.map((line) => line.length));
    assert.equal(widths.size, 1);
  });
});

describe("restore's refusal when a snapshot's paths aren't absolute here", () => {
  it("counts them, and agrees with itself about one", async () => {
    snapshot = {
      entries: new Map([
        ["data/f1.txt", { size: 3, mtime: "2026-07-01T10:00Z", hash: "aaa" }],
      ]),
      dirs: ["data"],
    };

    await assert.rejects(restore([], { set: "photos" }), {
      message: /has 1 path that isn't absolute on this system/,
    });
  });

  it("counts them, and agrees with itself about many", async () => {
    snapshot = filesUnder("data", 1204);

    await assert.rejects(restore([], { set: "photos" }), {
      message: /has 1,204 paths that aren't absolute on this system/,
    });
  });
});
