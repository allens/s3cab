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
// pipeline and a stubbed line, neither of which the pure-composition tests want.
// It is worth the scaffolding because the wiring is invisible from either end:
// it shipped broken once — `currentFile` was cleared in a `finally`, and since a
// redraw lands *between* rows, every draw saw `null` and the detail column
// stayed empty for a whole run (ADR-0076, amended 2026-09-13). A `progressLine`
// test stays green through that; this one does not.
//
// One seam makes it deterministic: a `clockedLine` stub that draws on *every*
// `tick()` rather than once an interval, and keeps the text `done` was handed.
// So each row is exactly one draw, and the closing frame is captured apart from
// the running ones. `performance.now()` is left alone, which is what holds the
// pass on its bare-path branch: these files hash in microseconds, so nothing
// here earns the one-second labelled measurement and the path is all the detail
// there is.
//
// **What this does not reach**, and where it is reached instead: whether a tick
// redraws only once its interval is due, and that it does so with no timer able
// to fire, is `progress.test.mjs`'s (`clockedLine`); that a Ctrl+C is *heard*
// mid-pass at all — the event-loop turn `propsRows` concedes — is
// `snapshot-file.test.mjs`'s real-signal test (ADR-0093).

/** Every running frame the pass drew, in order, the opening one first. */
/** @type {string[]} */
let lines = [];
/** The closing frame, if the pass drew one. */
/** @type {string | undefined} */
let closing;

/**
 * Clear the last pass's frames. A function rather than two assignments in each
 * test, because the type checker would read `closing = undefined` there as
 * holding for the rest of the test — it cannot see the pass setting it.
 */
function forgetFrames() {
  lines = [];
  closing = undefined;
}

mock.module("./progress.mjs", {
  exports: {
    clockedLine: (
      /** @type {unknown} */ _stream,
      /** @type {() => string} */ compose,
    ) => {
      // The real line's opening frame, when it is given no `opening` text.
      lines.push(compose());
      return {
        tick: () => lines.push(compose()),
        done: (/** @type {string} */ text) => (closing = text),
        [Symbol.dispose]() {},
      };
    },
    // The *walk's* counted line, which is a different line and not under test.
    // Stubbed only because mocking a module replaces the whole of it, and
    // `walk.mjs` imports this from here.
    countedPass: () => ({ tick() {}, done() {}, [Symbol.dispose]() {} }),
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

/**
 * A `through` that records each row's path, in the order the pass produced them.
 * @param {string[]} into
 */
const recording = (into) =>
  async function* (
    /** @type {Iterable<SnapshotRow> | AsyncIterable<SnapshotRow>} */ rows,
  ) {
    for await (const row of rows) {
      into.push(row[0]);
      yield row;
    }
  };

describe("the fused pass's progress line", () => {
  it("names the file the count is pointing at, on every tick", async (/** @type {TestContext} */ t) => {
    t.mock.method(console, "warn", () => {});
    await using dir = await mkdtempDisposable(join("test", ".tmp"));
    forgetFrames();
    /** @type {string[]} */
    const rowPaths = [];

    await generateSnapshot(threeFileSet(dir.path), {
      through: recording(rowPaths),
    });

    assert.equal(rowPaths.length, 3, "expected one row per walked file");
    // The pass draws once before pulling a single path, then ticks once per
    // row, so the two lists line up index for index.
    const [opening, ...drawn] = lines;
    assert.ok(opening, "the pass should draw before pulling a path");
    assert.ok(
      !opening.includes(dir.path),
      `the opening draw has no file in hand yet: ${opening}`,
    );
    assert.equal(drawn.length, rowPaths.length, "one tick per row");

    for (const [index, path] of rowPaths.entries()) {
      const line = drawn[index];
      assert.ok(line, `no draw for row ${index + 1}`);
      assert.ok(
        line.startsWith(`${index + 1}/3`),
        `draw ${index + 1} reported the wrong count: ${line}`,
      );
      // The whole point: the name and the number describe the same file — the
      // tick comes *after* the row, so the count has not run ahead of the name
      // — and the name is still there once the row is done, because the pass
      // keeps it rather than clearing it.
      assert.ok(
        line.endsWith(path),
        `draw ${index + 1} should have named ${path}, got: ${line}`,
      );
    }
  });

  it("closes on the true figures alone, naming no file", async (/** @type {TestContext} */ t) => {
    // The last tick shows the last file, which is the file the pass had *just*
    // finished. The closing frame is drawn once nothing is in hand, so it has
    // nothing to name — and the count it carries is the whole set, whatever
    // the last tick showed.
    t.mock.method(console, "warn", () => {});
    await using dir = await mkdtempDisposable(join("test", ".tmp"));
    forgetFrames();

    await generateSnapshot(threeFileSet(dir.path));

    assert.ok(closing, "a pass that ran to its end draws a closing frame");
    assert.ok(closing.startsWith("3/3"), `expected every file: ${closing}`);
    assert.ok(
      !closing.includes(dir.path),
      `the closing frame names no file: ${closing}`,
    );
  });

  it("draws no closing frame for a pass that failed", async (/** @type {TestContext} */ t) => {
    // A closing frame says the pass finished. Drawn over a failure it would read
    // as a step that completed, directly above the error saying it did not; the
    // last tick's frame — where it got to — is the honest thing to leave.
    t.mock.method(console, "warn", () => {});
    await using dir = await mkdtempDisposable(join("test", ".tmp"));
    forgetFrames();

    await assert.rejects(
      generateSnapshot(threeFileSet(dir.path), {
        // One row through, so the line is open and mid-pass when it fails.
        through: async function* (
          /** @type {Iterable<SnapshotRow> | AsyncIterable<SnapshotRow>} */ rows,
        ) {
          for await (const row of rows) {
            yield row;
            throw new Error("the uploader fell over");
          }
        },
      }),
      /fell over/,
    );
    assert.ok(lines.length >= 1, "the line was open when the pass failed");
    assert.equal(closing, undefined);
  });

  it("says it is stopping from the draw after the interrupt, not when the pass ends", async (/** @type {TestContext} */ t) => {
    // The complaint this answers: Ctrl+C on a 280,000-file backup looked like it
    // had done nothing, so it was pressed again — and a second press force-quits
    // (ADR-0067), which is how a run ends up hard-killed with its work file
    // stranded. The handler's message alone was not enough, because the line
    // under it carried on repainting exactly as before.
    //
    // The signal is raised from inside `through`, which is where the park
    // handler is installed and listening: the pass is mid-row, as it is when a
    // real Ctrl+C arrives.
    t.mock.method(console, "warn", () => {});
    await using dir = await mkdtempDisposable(join("test", ".tmp"));
    forgetFrames();

    await assert.rejects(
      generateSnapshot(threeFileSet(dir.path), {
        through: async function* (
          /** @type {Iterable<SnapshotRow> | AsyncIterable<SnapshotRow>} */ rows,
        ) {
          for await (const row of rows) {
            // One press per row, and the pass stops after the first: a second
            // would force-quit the test runner.
            process.emit("SIGINT");
            yield row;
          }
        },
      }),
      /[Ss]topped/,
      "a parked pass reports the stop rather than succeeding",
    );

    const [opening, ...drawn] = lines;
    assert.ok(opening, "the pass should draw before pulling a path");
    assert.ok(
      !opening.includes("Stopping"),
      `nothing was stopping when the pass opened: ${opening}`,
    );
    // Every draw after the press says so — and there is at least one, which is
    // the point: the user sees the stop while the pass is still finishing the
    // file it has in hand, not only once the run is over.
    assert.ok(drawn.length >= 1, "expected a draw after the interrupt");
    for (const [index, line] of drawn.entries()) {
      assert.ok(
        line.includes("Stopping…"),
        `draw ${index + 1} after the interrupt should say so, got: ${line}`,
      );
    }
    // A stopped pass did not finish, so it keeps the frame it stopped on.
    assert.equal(closing, undefined);
  });
});
