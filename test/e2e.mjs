import assert from "node:assert";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { mkdtempDisposable } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";

// Drive the real CLI entry as a subprocess. (The packaged native binary is a
// separate, not-yet-wired build target; the source entry is what runs today.)
const CLI = "src/cli.mjs";

/**
 * Run the s3cab CLI as a child process.
 * @param {...string} args
 */
function run(...args) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8" });
}

describe("cli (e2e)", () => {
  it("tree lists the files in a directory", async () => {
    await using dir = await mkdtempDisposable(join("test", ".tmp"));
    writeFileSync(join(dir.path, "alpha.txt"), "a");
    writeFileSync(join(dir.path, "beta.txt"), "b");

    const { status, stdout } = run("tree", dir.path);

    assert.strictEqual(status, 0);
    assert.match(stdout, /alpha\.txt/);
    assert.match(stdout, /beta\.txt/);
  });

  it("exits 127 on an unknown command", () => {
    const { status, stderr } = run("definitely-not-a-command");

    assert.strictEqual(status, 127);
    assert.match(stderr, /Unknown command/);
  });
});
