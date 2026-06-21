import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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

/**
 * Run the s3cab CLI with homedir() pointed at a temp home (USERPROFILE on
 * Windows, HOME on POSIX — set both), so set-store commands can't touch the
 * real `~/.s3cab`.
 * @param {string} home
 * @param {...string} args
 */
function runWithHome(home, ...args) {
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: "utf8",
    env: { ...process.env, HOME: home, USERPROFILE: home },
  });
}

describe("cli (e2e)", () => {
  it("tree lists a set's files", async () => {
    await using dir = await mkdtempDisposable(join("test", ".tmp"));
    const home = join(dir.path, "home");
    const data = join(dir.path, "data");
    mkdirSync(home);
    mkdirSync(data);
    writeFileSync(join(data, "alpha.txt"), "a");
    writeFileSync(join(data, "beta.txt"), "b");

    runWithHome(home, "setup", "files", data);
    const { status, stdout } = runWithHome(home, "tree", "files");

    assert.strictEqual(status, 0);
    assert.match(stdout, /alpha\.txt/);
    assert.match(stdout, /beta\.txt/);
  });

  it("snapshot → list round-trip on a set", async () => {
    await using dir = await mkdtempDisposable(join("test", ".tmp"));
    const home = join(dir.path, "home");
    const data = join(dir.path, "data");
    mkdirSync(home);
    mkdirSync(data);
    writeFileSync(join(data, "alpha.txt"), "a");

    const created = runWithHome(home, "setup", "files", data);
    assert.strictEqual(created.status, 0, created.stderr);

    // First snapshot of the sole set (no name needed): everything is added.
    const snap = runWithHome(home, "snapshot");
    assert.strictEqual(snap.status, 0, snap.stderr);
    const result = JSON.parse(snap.stdout);
    assert.deepStrictEqual(result.added, ["alpha.txt"]);

    // The snapshot is now listed under the set.
    const listed = runWithHome(home, "list");
    assert.strictEqual(listed.status, 0, listed.stderr);
    assert.match(listed.stdout, /\d{4}-\d{2}-\d{2}T\d{4}/);
  });

  it("backup on a bucket-less set stops with the bind-bucket command", async () => {
    // The cloud round-trip (backup → list --remote → status) needs a real
    // bucket and is covered by the gated lib tests (S3CAB_TEST_BUCKET). Here,
    // without S3: a set with no bucket can't be backed up, and `backup` points
    // at the exact command to bind one.
    await using dir = await mkdtempDisposable(join("test", ".tmp"));
    const home = join(dir.path, "home");
    const data = join(dir.path, "data");
    mkdirSync(home);
    mkdirSync(data);

    const created = runWithHome(home, "setup", "files", data);
    assert.strictEqual(created.status, 0, created.stderr);

    const { status, stderr } = runWithHome(home, "backup");
    assert.strictEqual(status, 1);
    assert.match(stderr, /no bucket bound/);
    assert.match(stderr, /s3cab setup files --bucket/);
  });

  it("setup → sets round-trip: create a backup set, then list it", async () => {
    await using dir = await mkdtempDisposable(join("test", ".tmp"));
    const home = join(dir.path, "home");
    const photos = join(dir.path, "photos");
    mkdirSync(home);
    mkdirSync(photos);

    const created = runWithHome(home, "setup", "photos", photos);

    assert.strictEqual(created.status, 0, created.stderr);
    const set = JSON.parse(created.stdout);
    assert.strictEqual(set.name, "photos");

    const listed = runWithHome(home, "sets");

    assert.strictEqual(listed.status, 0, listed.stderr);
    assert.match(
      listed.stdout,
      /photos\s+\(no bucket — local only\)\s+\(1 folder\)/,
    );
  });

  it("setup rejects an invalid set name with the rule and a suggestion", async () => {
    await using dir = await mkdtempDisposable(join("test", ".tmp"));
    const home = join(dir.path, "home");
    const photos = join(dir.path, "photos");
    mkdirSync(home);
    mkdirSync(photos);

    const { status, stderr } = runWithHome(home, "setup", "My Photos", photos);

    assert.strictEqual(status, 1);
    assert.match(stderr, /lowercase letters, digits, and hyphens/);
    assert.match(stderr, /Try: my-photos/);
  });

  it("exits 127 on an unknown command", () => {
    const { status, stderr } = run("definitely-not-a-command");

    assert.strictEqual(status, 127);
    assert.match(stderr, /Unknown command/);
  });

  it("the removed login command is gone from the CLI surface", () => {
    // Deliberately deleted (see docs/specs/auth.md History) — must not come back.
    const { status } = run("login");

    assert.strictEqual(status, 127);

    const { stdout } = run("--help");
    assert.doesNotMatch(stdout, /login|credential-process/);
  });

  it("--version prints the package version", () => {
    const { status, stdout } = run("--version");

    assert.strictEqual(status, 0);
    assert.strictEqual(stdout.trim(), VERSION);
  });

  it("--help lists the available commands on stdout", () => {
    const { status, stdout } = run("--help");

    assert.strictEqual(status, 0);
    assert.match(stdout, /Snapshots:/); // day-to-day group first…
    assert.match(stdout, /Advanced:/); // …plumbing last
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
    assert.match(stdout, /standard AWS SDK credential chain/);
  });

  it("help exclude prints the exclude-rules topic on stdout", () => {
    const { status, stdout } = run("help", "exclude");

    assert.strictEqual(status, 0);
    assert.match(stdout, /Excluding files/);
    assert.match(stdout, /exclude\.txt/);
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
