import assert from "node:assert/strict";
import crypto from "node:crypto";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { mkdtempDisposable } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { useTempHome } from "../helpers/temp-home.mjs";
import { MINUTE_MS, VirtualClock, clockHolder } from "./harness/clock.mjs";
import { FakeS3, backendHolder } from "./harness/fake-s3.mjs";
import { backup, restore, writeSet } from "./harness/seam.mjs";

// The harness's own smoke test: proves the two module mocks actually intercept
// the transitive imports (`../lib/s3.mjs` from src/commands, `./format.mjs`
// from src/lib — resolved-URL keyed, registered here as harness-relative
// specifiers), that commands run in-process against the fake, and that the
// virtual clock mints the snapshot names. Everything else in test/model/
// builds on exactly this wiring; if this file fails, fix it first.

const BUCKET = "model-bucket";
const sha = (/** @type {string} */ content) =>
  crypto.hash("sha256", Buffer.from(content), "hex");

/** @type {NodeJS.ProcessEnv} */
let savedEnv;
/** @type {number} */
let savedExitCode;
beforeEach(() => {
  savedEnv = { ...process.env };
  savedExitCode = /** @type {number} */ (process.exitCode ?? 0);
  clockHolder.current = new VirtualClock(Date.UTC(2026, 0, 5));
  backendHolder.current = new FakeS3();
});
afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in savedEnv)) {
      delete process.env[key];
    }
  }
  Object.assign(process.env, savedEnv);
  process.exitCode = savedExitCode;
});

/**
 * A set of three files, two sharing content, homed in a disposable dir.
 * @param {string} root
 * @returns {string} the data directory (canonicalized)
 */
const oneSet = (root) => {
  const data = join(root, "data");
  mkdirSync(data, { recursive: true });
  writeFileSync(join(data, "a.txt"), "alpha");
  writeFileSync(join(data, "b.txt"), "beta");
  writeFileSync(join(data, "copy.txt"), "alpha");
  useTempHome(root);
  const dir = realpathSync.native(data);
  writeSet("photos", { dirs: [dir], bucket: BUCKET });
  return dir;
};

describe("model harness smoke", () => {
  it("backs up through the fake with virtual-clock snapshot names", async () => {
    await using dir = await mkdtempDisposable(join("test", ".tmp"));
    oneSet(dir.path);

    const result = await backup("photos");

    // The virtual clock named the snapshot: the fixed origin, in UTC.
    assert.equal(result.snapshot, "2026-01-05T0000");

    // The fake holds exactly the two distinct objects plus the manifest, and
    // the op log shows objects first, snapshot last (the commit-point order).
    const fake = backendHolder.current;
    const listing = await fake.listAll(BUCKET);
    const keys = listing.map(({ key }) => key);
    assert.deepEqual(keys, [
      `objects/${sha("alpha")}`,
      `objects/${sha("beta")}`,
      "sets/photos/dirs.txt", // the set claim backup publishes alongside
      "snapshots/photos/2026-01-05T0000.tsv.zst",
    ]);
    // Objects strictly before the manifest (the commit point); the set claim
    // may land after it, and did.
    const putKeys = fake.log
      .filter(({ op }) => op === "PUT")
      .map(({ uri }) => uri.slice(`s3://${BUCKET}/`.length));
    const manifestAt = putKeys.indexOf(
      "snapshots/photos/2026-01-05T0000.tsv.zst",
    );
    assert.ok(manifestAt >= 0, "manifest was PUT");
    for (const key of putKeys.filter((k) => k.startsWith("objects/"))) {
      assert.ok(putKeys.indexOf(key) < manifestAt, `${key} before manifest`);
    }

    // Stored object bytes match their names — the content-address invariant.
    const alpha = await fake.getBytes(BUCKET, `objects/${sha("alpha")}`);
    assert.equal(alpha?.toString(), "alpha");
  });

  it("takes a second snapshot after the clock advances a minute", async () => {
    await using dir = await mkdtempDisposable(join("test", ".tmp"));
    const data = oneSet(dir.path);

    await backup("photos");
    writeFileSync(join(data, "b.txt"), "gamma");
    clockHolder.current.advance(MINUTE_MS);

    const result = await backup("photos");

    assert.equal(result.snapshot, "2026-01-05T0001");
    // Only the changed content went up.
    assert.equal(result.uploaded, 1);
    const stored = await backendHolder.current.listAll(BUCKET);
    assert.equal(
      stored.filter(({ key }) => key.startsWith("objects/")).length,
      3,
    );
  });

  it("restores byte-identically into an output directory", async () => {
    await using dir = await mkdtempDisposable(join("test", ".tmp"));
    oneSet(dir.path);
    await backup("photos");

    const out = join(dir.path, "out");
    await restore([], { set: "photos", output: out });

    assert.equal(process.exitCode, 0);
    const restoredRoot = join(out, "data");
    assert.equal(readFileSync(join(restoredRoot, "a.txt"), "utf8"), "alpha");
    assert.equal(readFileSync(join(restoredRoot, "b.txt"), "utf8"), "beta");
    assert.equal(readFileSync(join(restoredRoot, "copy.txt"), "utf8"), "alpha");
  });
});
