import assert from "node:assert/strict";
import { mkdirSync, realpathSync, symlinkSync } from "node:fs";
import { mkdtempDisposable } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { describe, it } from "node:test";
import { readSnapshot } from "./snapshot-file.mjs";
import { generateSnapshot } from "./snapshot.mjs";

/** @import { TestContext } from "node:test" */

// How a pass spells a folder link it records as an `#error`. `backup` matches
// the pass's paths against the previous snapshot's `#error` rows to decide what
// to suggest excluding, so the two spellings have to agree.

describe("a pass over a link to a folder outside the backup", () => {
  it("spells its path as the #error row does, separator and all", async (/** @type {TestContext} */ t) => {
    t.mock.method(console, "warn", () => {});
    await using dir = await mkdtempDisposable(join("test", ".tmp"));
    const data = join(dir.path, "data");
    const away = join(dir.path, "away");
    const snapshotsDir = join(dir.path, "snapshots");
    mkdirSync(data);
    mkdirSync(away);
    mkdirSync(snapshotsDir);
    // A junction on Windows, which needs no Developer Mode; a symlink elsewhere.
    symlinkSync(resolve(away), join(data, "shared"), "junction");

    const pass = await generateSnapshot({
      name: "photos",
      dirs: [resolve(data)],
      bucket: "b",
      dir: dir.path,
      snapshotsDir,
      dirsPath: join(dir.path, "dirs.txt"),
      excludePath: join(dir.path, "exclude.txt"),
      envPath: join(dir.path, "env"),
      claimPath: join(dir.path, "claim"),
    });

    const root = realpathSync.native(data);
    assert.deepEqual(
      pass.errors.map(({ path }) => path),
      [join(root, "shared") + sep],
    );
    const { errors } = await readSnapshot(snapshotsDir, pass.name);
    assert.deepEqual(
      pass.errors,
      [...errors].map(([path, reason]) => ({ path, reason })),
    );
  });
});
