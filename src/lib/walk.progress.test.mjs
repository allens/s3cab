import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtempDisposable } from "node:fs/promises";
import { join } from "node:path";
import { describe, it, mock } from "node:test";

// The walk's progress line **driven**: that `walkDirs` ticks the line's clock
// once for every entry it visits. The walk is synchronous end to end, so the
// line's timer never fires during it and the tick is the only thing that moves
// it (ADR-0093) — a walk that stopped ticking would freeze its line from the
// bare label to the tally, with every `walk.test.mjs` assertion still green.
//
// Its own file (ADR-0049's dotted aspect) because it replaces `progress.mjs`
// wholesale, which the walk's other tests must not see. Whether a tick redraws
// only once its interval is due is `progress.test.mjs`'s; this counts the ticks.

let ticks = 0;

mock.module("./progress.mjs", {
  exports: {
    countedPass: () => ({
      tick: () => ticks++,
      done() {},
      [Symbol.dispose]() {},
    }),
  },
});

const { walkDirs } = await import("./walk.mjs");

describe("the walk's progress line", () => {
  it("ticks for every entry visited, excluded ones included", async () => {
    // A subtree the walk keeps nothing from is the stall the line exists to
    // report — so an excluded file has to move the clock as surely as a kept
    // one. Two kept files, one directory, five files excluded inside it: eight
    // entries, eight ticks.
    await using dir = await mkdtempDisposable(join("test", ".tmp"));
    writeFileSync(join(dir.path, "one.txt"), "1");
    writeFileSync(join(dir.path, "two.txt"), "2");
    mkdirSync(join(dir.path, "logs"));
    for (let i = 1; i <= 5; i++) {
      writeFileSync(join(dir.path, "logs", `${i}.log`), "log");
    }
    ticks = 0;

    const { files, excluded } = walkDirs([dir.path], ["**/*.log"]);

    assert.equal(files.length, 2, "the two .txt files are kept");
    assert.equal(excluded.length, 5, "every .log file is excluded");
    assert.equal(ticks, 2 + 1 + 5);
  });
});
