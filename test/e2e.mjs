import assert from "node:assert";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtempDisposable } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";

// Drive the real CLI entry as a subprocess.
const CLI = "src/s3cab.mjs";

// The packaged SEA executable, built on demand by `npm run build:win` /
// `build:linux`. Its path
// is read from this host's static SEA config (sea/<target>.json) so this test
// can't drift from the build config. It's a ~100 MB artifact that doesn't exist
// in a normal checkout, so the smoke test below skips itself unless the binary
// has actually been built.
// Map Node's process.platform to our sea/ target labels: "win"/"macos" read better
// than the raw "win32"/"darwin" in release-asset and config names.
const PLATFORM =
  process.platform === "win32"
    ? "win"
    : process.platform === "darwin"
      ? "macos"
      : process.platform;
const HOST_TARGET = `${PLATFORM}-${process.arch}`;
const EXE = JSON.parse(readFileSync(`sea/${HOST_TARGET}.json`, "utf8")).output;

// package.json version is the single source of truth; `--version` must echo it.
const VERSION = JSON.parse(readFileSync("package.json", "utf8")).version;

/**
 * Run the s3cab CLI as a child process.
 * @param {...string} args
 */
function run(...args) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8" });
}

/**
 * Run the packaged native executable as a child process.
 * @param {...string} args
 */
function runExe(...args) {
  return spawnSync(EXE, args, { encoding: "utf8" });
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

  it("--version prints the package version", () => {
    const { status, stdout } = run("--version");

    assert.strictEqual(status, 0);
    assert.strictEqual(stdout.trim(), VERSION);
  });

  it("--help lists the available commands on stdout", () => {
    const { status, stdout } = run("--help");

    assert.strictEqual(status, 0);
    assert.match(stdout, /Commands:/);
    assert.match(stdout, /snapshot/);
  });

  it("<command> --help shows that command's usage on stdout", () => {
    const { status, stdout } = run("compare", "--help");

    assert.strictEqual(status, 0);
    assert.match(stdout, /--since/);
  });

  it("help auth prints the credential-resolution topic on stdout", () => {
    const { status, stdout } = run("help", "auth");

    assert.strictEqual(status, 0);
    assert.match(stdout, /Authentication/);
    assert.match(stdout, /s3cab login/);
  });

  // Smoke test the packaged SEA executable: it boots, runs the ESM main, and
  // produces correct output. Skipped unless `npm run build:win` / `build:linux`
  // has built it.
  it(
    "packaged exe runs and computes a file's properties",
    {
      skip: existsSync(EXE)
        ? false
        : `${EXE} not built (run \`npm run build:win\` / \`build:linux\`)`,
    },
    async () => {
      await using dir = await mkdtempDisposable(join("test", ".tmp"));
      const file = join(dir.path, "hello.txt");
      writeFileSync(file, "hello");

      const { status, stdout } = runExe("prop", file);

      assert.strictEqual(status, 0);
      // SHA-256 of "hello".
      assert.match(
        stdout,
        /2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824/,
      );
    },
  );
});
