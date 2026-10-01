import assert from "node:assert/strict";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { mkdtempDisposable } from "node:fs/promises";
import { join } from "node:path";
import { describe, it, mock } from "node:test";

/** @import { TestContext } from "node:test" */
/** @import { BackupSet } from "./sets.mjs" */
/** @import { SnapshotRow } from "./snapshot-file.mjs" */

// The fused pass's progress line **driven**, rather than composed by hand. The
// sibling `snapshot.test.mjs` asserts what `progressLine` *says* for a given
// state; this asserts that the pass hands it a true one — that `getProps`
// publishes the file it has in hand and `withProgress` reads it back on the same
// draw that reports the count.
//
// Its own file (ADR-0049's dotted aspect) because that wiring needs a running
// pipeline and a fake clock, neither of which the pure-composition tests want.
// It is worth the scaffolding because the wiring is invisible from either end:
// it is only ever observable through a timer-driven redraw, and it shipped
// broken once for exactly that reason — `currentFile` was cleared in a
// `finally`, and since a redraw lands *between* rows, every draw saw `null` and
// the detail column stayed empty for a whole run (ADR-0076, amended 2026-09-13).
// A `progressLine` test stays green through that; this one does not.
//
// Two seams make it deterministic, and neither is a clock the production code
// has to know about:
//
//   - `node:test`'s fake `setInterval`, ticked from inside the pass's own
//     `through` transform — the fusion seam `backup` already uses (ADR-0069).
//     A tick from there lands where a real redraw lands: a row hashed, its path
//     published, the count advanced, nothing in flight.
//   - a `createProgress` stub that records every line instead of pacing them,
//     the same stub `commands/restore.counts.test.mjs` uses.
//
// `performance.now()` is left alone, which is what holds the pass on its
// bare-path branch: these files hash in microseconds, so nothing here earns the
// one-second labelled measurement and the path is all the detail there is.
//
// **What this does not reach**, so nobody reads it as covering more than it
// does: the pass's *timing*. A tick driven from `through` lands where the row
// puts it, never where the wall clock would, so the 250ms cadence, the 100ms
// concession that lets it fire at all, and `lib/progress.mjs`'s own redraw
// pacing are all still unasserted — and so is the concession's placement
// *after* the row rather than before it, whose only symptom is a draw landing
// in the gap between the count advancing and the file being published. Catching
// that needs a timer that fires on its own, which is the real clock.

/** `snapshot.mjs`'s redraw interval — one tick, one draw. */
const TICK_MS = 250;

/** Every line the pass handed the display, in order. */
/** @type {string[]} */
let lines = [];

mock.module("./progress.mjs", {
  exports: {
    createProgress: () => ({
      due: () => true,
      update: (/** @type {string} */ line) => lines.push(line),
      clear() {},
      [Symbol.dispose]() {},
    }),
    // The *walk's* counted line, which is a different line and not under test.
    // Stubbed only because mocking a module replaces the whole of it, and
    // `walk.mjs` imports this from here.
    countedPass: () => ({ done() {}, [Symbol.dispose]() {} }),
  },
});

const { generateSnapshot } = await import("./snapshot.mjs");

/**
 * A three-file set under `root`, with its snapshot store outside the walked
 * directory so the file being written is not itself walked.
 * @param {string} root
 * @returns {BackupSet}
 */
function threeFileSet(root) {
  const data = join(root, "data");
  const snapshotsDir = join(root, "snapshots");
  mkdirSync(data);
  mkdirSync(snapshotsDir);
  for (const name of ["one.txt", "two.txt", "three.txt"]) {
    writeFileSync(join(data, name), name);
  }
  return {
    name: "photos",
    dirs: [realpathSync.native(data)],
    bucket: "b",
    dir: root,
    snapshotsDir,
    dirsPath: join(root, "dirs.txt"),
    excludePath: join(root, "exclude.txt"),
    envPath: join(root, "env"),
  };
}

describe("the fused pass's progress line", () => {
  it("names the file the count is pointing at, on every draw", async (/** @type {TestContext} */ t) => {
    t.mock.method(console, "warn", () => {});
    await using dir = await mkdtempDisposable(join("test", ".tmp"));
    lines = [];
    /** @type {string[]} each row's path, in the order the pass produced them */
    const rowPaths = [];

    mock.timers.enable({ apis: ["setInterval"] });
    try {
      await generateSnapshot(threeFileSet(dir.path), {
        through: async function* (
          /** @type {Iterable<SnapshotRow> | AsyncIterable<SnapshotRow>} */ rows,
        ) {
          for await (const [path, props] of rows) {
            rowPaths.push(path);
            // Where `backup` would be sending this object, the test advances the
            // clock instead: one redraw, with this file just hashed.
            mock.timers.tick(TICK_MS);
            yield /** @type {SnapshotRow} */ ([path, props]);
          }
        },
      });
    } finally {
      mock.timers.reset();
    }

    assert.equal(rowPaths.length, 3, "expected one row per walked file");
    // The pass draws once before pulling a single path, so the rest are our
    // ticks and the two lists line up index for index.
    const [opening, ...drawn] = lines;
    assert.ok(opening, "the pass should draw before pulling a path");
    assert.ok(
      !opening.includes(dir.path),
      `the opening draw has no file in hand yet: ${opening}`,
    );
    assert.equal(drawn.length, rowPaths.length, "one draw per row");

    for (const [index, path] of rowPaths.entries()) {
      const line = drawn[index];
      assert.ok(line, `no draw for row ${index + 1}`);
      assert.ok(
        line.startsWith(`${index + 1}/3`),
        `draw ${index + 1} reported the wrong count: ${line}`,
      );
      // The whole point: the name and the number describe the same file, and
      // the name is still there a row later — the pass keeps it rather than
      // clearing it, which is what makes a draw between rows say anything.
      assert.ok(
        line.endsWith(path),
        `draw ${index + 1} should have named ${path}, got: ${line}`,
      );
    }
  });
});
