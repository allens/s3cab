import assert from "node:assert/strict";
import {
  mkdirSync,
  realpathSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { mkdtempDisposable } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { describe, it, mock } from "node:test";
import * as walk from "./walk.mjs";

/** @import { TestContext } from "node:test" */
/** @import { BackupSet } from "./sets.mjs" */

// A member directory that is a link, pointed elsewhere once the walk has read
// it. Its own file (ADR-0049's dotted aspect) because the moment has to be made
// real: `walkSet` is wrapped so the link moves the instant the walk returns,
// the only point between the walk and the snapshot's `@SET DIR` rows.

/** Runs once the real walk returns. */
let afterWalk = () => {};
mock.module("./walk.mjs", {
  exports: {
    ...walk,
    walkSet: (/** @type {BackupSet} */ set) => {
      const found = walk.walkSet(set);
      afterWalk();
      return found;
    },
  },
});
const { readSnapshot } = await import("./snapshot-file.mjs");
const { generateSnapshot } = await import("./snapshot.mjs");

describe("a member directory that is a link, pointed elsewhere during the walk", () => {
  it("records the folder the walk read as its @SET DIR, so every row stays under it", async (/** @type {TestContext} */ t) => {
    t.mock.method(console, "warn", () => {});
    await using dir = await mkdtempDisposable(join("test", ".tmp"));
    const base = resolve(dir.path);
    const first = join(base, "first");
    const second = join(base, "second");
    const link = join(base, "photos");
    const snapshotsDir = join(base, "snapshots");
    for (const folder of [first, second, snapshotsDir]) {
      mkdirSync(folder);
    }
    writeFileSync(join(first, "a.jpg"), "a");
    writeFileSync(join(second, "b.jpg"), "b");
    // A junction needs no privilege on Windows; elsewhere it's a plain link.
    symlinkSync(first, link, "junction");
    afterWalk = () => {
      unlinkSync(link);
      symlinkSync(second, link, "junction");
    };

    const pass = await generateSnapshot({
      name: "photos",
      dirs: [link],
      bucket: "b",
      dir: base,
      snapshotsDir,
      dirsPath: join(base, "dirs.txt"),
      excludePath: join(base, "exclude.txt"),
      envPath: join(base, "env"),
      claimPath: join(base, "claim"),
    });

    const walked = realpathSync.native(first);
    assert.deepEqual(pass.roots, [walked]);
    const { dirs, entries, refused } = await readSnapshot(
      snapshotsDir,
      pass.name,
    );
    assert.deepEqual(dirs, [walked + sep]);
    assert.deepEqual([...entries.keys()], [join(walked, "a.jpg")]);
    assert.deepEqual([...refused.keys()], []);
  });
});
