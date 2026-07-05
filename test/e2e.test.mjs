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

/**
 * Create a local backup set directly on disk, without running `setup`. `setup`
 * now requires a bucket and touches S3 (the collision claim, ADR-0024/0026), so
 * the offline-engine e2e cases (tree/snapshot/list) seed the set's files —
 * the set store *is* those files — instead of going online.
 *
 * Every set is bound to a bucket (ADR-0026), enforced by `readSet`, so the env
 * always pins one even for the offline cases that never use it — a placeholder
 * by default, or the given bucket where the case asserts on it (the `list`
 * set listing).
 * @param {string} home
 * @param {string} name
 * @param {string[]} dirs
 * @param {string} [bucket]
 */
function seedSet(home, name, dirs, bucket = "seed-bucket") {
  const setDir = join(home, ".s3cab", "sets", name);
  mkdirSync(setDir, { recursive: true });
  writeFileSync(join(setDir, "dirs.txt"), dirs.join("\n") + "\n");
  writeFileSync(join(setDir, "env"), `S3CAB_BUCKET=${bucket}\n`);
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

    seedSet(home, "files", [data]);
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

    seedSet(home, "files", [data]);

    // First snapshot of the sole set (no name needed). Human output is the
    // default now (ADR-0043): a first snapshot collapses to a one-line count
    // (every file is "added" against an empty baseline), rendered end-to-end
    // through the dispatcher.
    const snap = runWithHome(home, "snapshot");
    assert.strictEqual(snap.status, 0, snap.stderr);
    assert.match(snap.stdout, /First snapshot: 1 file/);

    // The snapshot is now listed under the set (compact: `files:` then the time).
    const listed = runWithHome(home, "list");
    assert.strictEqual(listed.status, 0, listed.stderr);
    assert.match(listed.stdout, /files:\n\s+\d{4}-\d{2}-\d{2}T\d{4}/);
  });

  it("the global --json flag emits the structured result and is stripped before exec", async () => {
    // --json is dispatcher-owned (ADR-0043): merged into every command's parse
    // (never an "unknown option"), and stripped before exec (the command still
    // runs). It emits today's structured value — for a compare/snapshot result
    // that's the absolute-path CompareResult, not the human collapse line.
    await using dir = await mkdtempDisposable(join("test", ".tmp"));
    const home = join(dir.path, "home");
    const data = join(dir.path, "data");
    mkdirSync(home);
    mkdirSync(data);
    writeFileSync(join(data, "alpha.txt"), "a");
    seedSet(home, "files", [data]);

    const snap = runWithHome(home, "snapshot", "--json");
    assert.strictEqual(snap.status, 0, snap.stderr);
    const result = JSON.parse(snap.stdout);
    assert.equal(result.since, null); // first snapshot
    assert.equal(result.added.length, 1);
    assert.match(result.added[0].path, /alpha\.txt$/);
    assert.equal(result.added[0].size, 1); // "a"
  });

  it("list <set> shows the set's backup target in detail", async () => {
    await using dir = await mkdtempDisposable(join("test", ".tmp"));
    const home = join(dir.path, "home");
    const photos = join(dir.path, "photos");
    mkdirSync(home);
    mkdirSync(photos);

    seedSet(home, "photos", [photos], "my-bucket");

    const listed = runWithHome(home, "list", "photos");

    assert.strictEqual(listed.status, 0, listed.stderr);
    assert.match(listed.stdout, /name: photos/);
    assert.match(listed.stdout, /bucket: my-bucket/);
  });

  it("verify is a real command (no longer a planned stub)", () => {
    // verify was the last registry stub; --help must now render its usage, not
    // the "(not yet available)" marker.
    const { status, stdout } = run("verify", "--help");

    assert.strictEqual(status, 0);
    assert.match(stdout, /Usage: s3cab verify/);
    assert.match(stdout, /<bucket>/); // the bucket operand (ADR-0042)
    assert.doesNotMatch(stdout, /not yet available/);
  });

  it("verify without a bucket is a usage error, before any S3 touch", async () => {
    // verify's operand is the bucket (ADR-0042); omitting it must fail fast with
    // the missing-argument usage error (exit 2), never reaching S3.
    await using dir = await mkdtempDisposable(join("test", ".tmp"));
    const home = join(dir.path, "home");
    mkdirSync(home);

    const { status, stderr } = runWithHome(home, "verify");

    assert.strictEqual(status, 2);
    assert.match(stderr, /Missing required argument: <bucket>/);
  });

  it("delete without a set is a usage error, before any S3 touch", async () => {
    await using dir = await mkdtempDisposable(join("test", ".tmp"));
    const home = join(dir.path, "home");
    mkdirSync(home);

    const { status, stderr } = runWithHome(home, "delete");
    assert.strictEqual(status, 2);
    assert.match(stderr, /Missing required argument: <set>/);
  });

  it("delete without --snapshot is a usage error, before any S3 touch", async () => {
    // The snapshot check runs before the set is resolved, so this fails fast even
    // with no set on disk.
    await using dir = await mkdtempDisposable(join("test", ".tmp"));
    const home = join(dir.path, "home");
    mkdirSync(home);

    const { status, stderr } = runWithHome(home, "delete", "photos");
    assert.strictEqual(status, 2);
    assert.match(stderr, /Missing required argument: --snapshot/);
  });

  it("cleanup without a bucket is a usage error, before any S3 touch", async () => {
    await using dir = await mkdtempDisposable(join("test", ".tmp"));
    const home = join(dir.path, "home");
    mkdirSync(home);

    const { status, stderr } = runWithHome(home, "cleanup");
    assert.strictEqual(status, 2);
    assert.match(stderr, /Missing required argument: <bucket>/);
  });

  it("setup without --bucket is rejected (a set is bound to a bucket at creation)", async () => {
    // Creating a set now requires a bucket and touches S3 (the collision claim,
    // ADR-0024/0026); the full create → backup → list cloud round-trip is
    // covered by the gated lib tests (S3CAB_TEST_BUCKET). Offline, `setup`
    // without --bucket must fail fast with the usage error, before any S3 touch.
    await using dir = await mkdtempDisposable(join("test", ".tmp"));
    const home = join(dir.path, "home");
    const data = join(dir.path, "data");
    mkdirSync(home);
    mkdirSync(data);

    const { status, stderr } = runWithHome(home, "setup", "files", data);
    assert.strictEqual(status, 2); // usage error (missing required option)
    assert.match(stderr, /Missing required argument: --bucket/);
  });

  it("setup rejects an invalid set name with the rule and a suggestion", async () => {
    await using dir = await mkdtempDisposable(join("test", ".tmp"));
    const home = join(dir.path, "home");
    const photos = join(dir.path, "photos");
    mkdirSync(home);
    mkdirSync(photos);

    const { status, stderr } = runWithHome(home, "setup", "My Photos", photos);

    assert.strictEqual(status, 2); // bad input value (validation error)
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

  it("help <command> shows that command's usage on stdout", () => {
    const { status, stdout } = run("help", "compare");

    assert.strictEqual(status, 0);
    assert.match(stdout, /Usage: s3cab compare/);
    assert.match(stdout, /--since/);
  });

  it("help auth prints the auth command's help, credential guide included", () => {
    // The auth topic folded into the command (ADR-0041); the error messages'
    // "Run 's3cab help auth'" pointers must keep landing on the guide.
    const { status, stdout } = run("help", "auth");

    assert.strictEqual(status, 0);
    assert.match(stdout, /Usage: s3cab auth/);
    assert.match(stdout, /standard AWS SDK credential chain/);
  });

  it("prints the AWS profile + endpoint in use on the first S3 touch (stderr)", async () => {
    // `hashes` touches S3 (listObjects → client()), where the notice is emitted.
    // A bogus endpoint + AWS_MAX_ATTEMPTS=1 makes the request fail instantly
    // (ECONNREFUSED, no retries) right *after* the notice prints — so this
    // asserts the real wiring without needing real credentials or a live bucket.
    // Dummy static keys are supplied so credential resolution doesn't probe the
    // IMDS endpoint (a multi-second timeout); the notice still reports the
    // profile, which it reads straight from AWS_PROFILE.
    await using dir = await mkdtempDisposable(join("test", ".tmp"));
    const home = join(dir.path, "home");
    mkdirSync(home);

    const { stderr } = spawnSync(
      process.execPath,
      [CLI, "hashes", "some-bucket"],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          HOME: home,
          USERPROFILE: home,
          AWS_PROFILE: "work",
          AWS_ENDPOINT_URL: "http://127.0.0.1:1",
          AWS_REGION: "us-east-1",
          AWS_MAX_ATTEMPTS: "1",
          AWS_ACCESS_KEY_ID: "test",
          AWS_SECRET_ACCESS_KEY: "test",
        },
      },
    );

    assert.match(
      stderr,
      /Using AWS profile: work, endpoint: http:\/\/127\.0\.0\.1:1/,
    );
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
