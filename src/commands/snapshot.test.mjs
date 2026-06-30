import assert from "node:assert/strict";
import {
  cpSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join, normalize, resolve } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { writeSet } from "../lib/sets.mjs";
import { snapshot } from "./snapshot.mjs";
import { useTempHome } from "../../test/helpers/temp-home.mjs";

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

// The set store derives its paths from s3cabDir(); point S3CAB_HOME at a temp
// dir (via the shared useTempHome) so a snapshot can't touch the real `~/.s3cab`,
// and restore the environment after each test.
/** @type {NodeJS.ProcessEnv} */
let savedEnv;
beforeEach(() => {
  savedEnv = { ...process.env };
});
afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in savedEnv)) delete process.env[key];
  }
  Object.assign(process.env, savedEnv);
});

describe("snapshot", () => {
  it("errors for a set whose directory no longer exists", async () => {
    const workDir = copyFixtureToWorkDir("before", "snapshot > missing-dir");
    useTempHome(workDir());
    mkdirSync(workDir("data"));
    writeFileSync(workDir("data", "x.txt"), "x");
    writeSet("photos", {
      dirs: [realpathSync.native(workDir("data"))],
      bucket: "b",
    });
    rmSync(workDir("data"), { recursive: true, force: true });

    await assert.rejects(snapshot("photos", { rehash: true }));
  });

  it("reports changes between snapshots", async (t) => {
    let mockIsoDateTime = "2025-01-15T10:30:00";

    // Temporal.Now.plainDateTimeISO() drives the snapshot name and header.
    t.mock.method(Temporal.Now, "plainDateTimeISO", () =>
      Temporal.PlainDateTime.from(mockIsoDateTime),
    );

    const workDir = copyFixtureToWorkDir("before", t.fullName);
    useTempHome(workDir());
    writeSet("photos", { dirs: [realpathSync.native(workDir())], bucket: "b" });

    await snapshot("photos", { rehash: true });

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

    const { added, modified, deleted, moved } = await snapshot("photos", {
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

  it("writes the set identity and a #DIR line per member directory", async (t) => {
    t.mock.method(Temporal.Now, "plainDateTimeISO", () =>
      Temporal.PlainDateTime.from("2025-02-01T09:00:00"),
    );

    const workDir = copyFixtureToWorkDir("before", t.fullName);
    const home = useTempHome(workDir());
    writeSet("photos", { dirs: [realpathSync.native(workDir())], bucket: "b" });

    await snapshot("photos", { rehash: true, debug: true });

    // --debug leaves an uncompressed copy beside the snapshot; read its header.
    const decompressed = readFileSync(
      join(home, ".s3cab", "sets", "photos", "snapshots", ".snapshot.tsv"),
      "utf8",
    );
    const [snapshotLine, dirLine] = decompressed
      .split("\n")
      .filter((line) => line.startsWith("#"));
    assert.ok(snapshotLine && dirLine, "expected #SNAPSHOT and #DIR headers");

    assert.match(snapshotLine, /^#SNAPSHOT\s+2025-02-01T09:00\s+photos\s*$/);
    assert.match(dirLine, /^#DIR\s/);
    assert.ok(dirLine.includes(realpathSync.native(workDir())));
  });

  it("refuses a same-minute snapshot unless overwriting under debug", async (t) => {
    t.mock.method(Temporal.Now, "plainDateTimeISO", () =>
      Temporal.PlainDateTime.from("2025-03-01T12:00:00"),
    );

    const workDir = copyFixtureToWorkDir("before", t.fullName);
    useTempHome(workDir());
    writeSet("photos", { dirs: [realpathSync.native(workDir())], bucket: "b" });

    await snapshot("photos", { rehash: true });

    // Same minute, same name → refused rather than silently overwriting.
    await assert.rejects(snapshot("photos", { rehash: true }), /same minute/);

    // …but debug mode (S3CAB_DEBUG) is allowed to overwrite while iterating.
    await snapshot("photos", { rehash: true, debug: true });
  });
});
