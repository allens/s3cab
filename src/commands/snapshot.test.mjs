import assert from "node:assert/strict";
import {
  cpSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join, normalize, resolve } from "node:path";
import { describe, it } from "node:test";
import { snapshot } from "./snapshot.mjs";

/**
 * @param {string} fixtureName
 * @param {string} testName
 */
function copyFixtureToWorkDir(fixtureName, testName) {
  const fixtureDir = resolve("./test/fixtures", fixtureName);
  if (!readdirSync(fixtureDir).length) {
    throw new Error(`Fixture "${fixtureName}" does not exist or is empty`);
  }
  const tmpDir = resolve("./test/.tmp", ...testName.split(" > "));
  rmSync(tmpDir, { recursive: true, force: true });
  mkdirSync(tmpDir, { recursive: true });
  cpSync(fixtureDir, tmpDir, {
    recursive: true,
    force: true,
    preserveTimestamps: true,
  });
  /** @param {string[]} parts */
  function inWorkDir(...parts) {
    return join(tmpDir, ...parts);
  }
  return inWorkDir;
}

describe("snapshot", () => {
  it("throws ENOENT for a non-existent directory", async () => {
    const dir = "./test/fixtures/snapshot-dir-does-not-exist";

    await assert.rejects(snapshot(dir, { rehash: true }), { code: "ENOENT" });
  });

  it("reports changes between snapshots", async (t) => {
    let mockIsoDateTime = "2025-01-15T10:30:00";

    // Temporal.Now.plainDateTimeISO()
    t.mock.method(Temporal.Now, "plainDateTimeISO", () =>
      Temporal.PlainDateTime.from(mockIsoDateTime),
    );

    const workDir = copyFixtureToWorkDir("before", t.fullName);

    await snapshot(workDir(), { rehash: true });

    mockIsoDateTime = "2025-01-15T10:31:00";

    mkdirSync(workDir("dir"));

    // Delete
    unlinkSync(workDir("delete.txt"));

    // Modify
    writeFileSync(workDir("modify.txt"), `modified`);

    // Add
    writeFileSync(workDir("added.txt"), `added`);

    // Rename
    renameSync(workDir("rename.txt"), workDir("renamed.txt"));

    // Move
    renameSync(workDir("move.txt"), workDir("dir", "move.txt"));

    const { added, modified, deleted, moved } = await snapshot(workDir(), {
      rehash: false,
    });

    assert.deepStrictEqual(added, [normalize("./added.txt")]);
    assert.deepStrictEqual(modified, [normalize("./modify.txt")]);
    assert.deepStrictEqual(deleted, [normalize("./delete.txt")]);

    assert.deepStrictEqual(moved, [
      `${normalize("./move.txt")} →→ ${normalize("./dir/move.txt")}`,
      `${normalize("./rename.txt")} → ${normalize("./renamed.txt")}`,
    ]);
  });
});
