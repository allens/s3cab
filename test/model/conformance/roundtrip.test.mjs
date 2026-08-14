import assert from "node:assert/strict";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { mkdtempDisposable } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { backup } from "../../../src/commands/backup.mjs";
import { restore } from "../../../src/commands/restore.mjs";
import { verify } from "../../../src/commands/verify.mjs";
import { writeSet } from "../../../src/lib/sets.mjs";
import { useTempHome } from "../../helpers/temp-home.mjs";
import { checkStore } from "../harness/invariants.mjs";
import { RepoModel, captureTree, sha256 } from "../harness/model.mjs";
import { RealS3, bucket } from "./real-s3.mjs";

// Tier 2's flagship: the Tier 1 invariants — restore byte-identity, the
// content-addressed store shape, verify agreeing with an independent read of
// the bucket — held against **real S3**, through the real commands, with the
// real clock. The model reads the bucket through its own SDK client and its
// own zstd/TSV parser (real-s3.mjs, model.mjs), so nothing under test
// verifies itself.

const real = new RealS3();

/** @type {NodeJS.ProcessEnv} */
let savedEnv;
/** @type {number} */
let savedExitCode;
beforeEach(async () => {
  savedEnv = { ...process.env };
  savedExitCode = /** @type {number} */ (process.exitCode ?? 0);
  await real.wipe(bucket);
});
afterEach(async () => {
  for (const key of Object.keys(process.env)) {
    if (!(key in savedEnv)) {
      delete process.env[key];
    }
  }
  Object.assign(process.env, savedEnv);
  process.exitCode = savedExitCode;
  await real.wipe(bucket);
});

/**
 * Snapshot names are minute-precision, so two backups in one wall-clock
 * minute collide ("already backed up"). Sleep past the boundary — the honest
 * cost of testing against the real clock.
 */
async function nextMinute() {
  await sleep(60_000 - (Date.now() % 60_000) + 500);
}

describe("conformance: backup/restore round-trip on real S3", () => {
  it(
    "round-trips a tree with a multipart-sized file, byte-identically",
    { timeout: 600_000 },
    async (t) => {
      await using dir = await mkdtempDisposable(join("test", ".tmp"));
      const root = dir.path;
      useTempHome(root);
      mkdirSync(join(root, "data", "sub"), { recursive: true });
      const data = realpathSync.native(join(root, "data"));
      const big = Buffer.alloc(16 * 1024 * 1024 + 1, 7);
      writeFileSync(join(data, "big.bin"), big);
      writeFileSync(join(data, "small.txt"), "small file contents");
      writeFileSync(join(data, "sub", "nested.txt"), "nested contents");
      writeFileSync(join(data, "empty.dat"), Buffer.alloc(0));
      writeSet("conf", { dirs: [data], bucket });

      process.exitCode = 0;
      const result = await backup("conf");
      assert.equal(result.errors, 0);
      assert.equal(process.exitCode, 0);
      assert.equal(result.uploaded, 4);

      // The big object really went up multipart: its ETag carries a part count.
      if (real.capabilities.has("multipart")) {
        const head = await real.head(bucket, `objects/${sha256(big)}`);
        assert.match(
          /** @type {string} */ (head.ETag),
          /-\d+"$/,
          "an object above the part size must have a multipart ETag",
        );
      } else {
        t.diagnostic(
          "backend does not declare multipart — ETag shape unchecked",
        );
      }

      // Byte-identity through a real download, including the multipart body.
      const out = join(root, "out");
      mkdirSync(out, { recursive: true });
      process.exitCode = 0;
      await restore([], {
        set: "conf",
        snapshot: result.snapshot,
        output: out,
      });
      assert.equal(process.exitCode, 0);
      const restored = captureTree([join(out, "data")]);
      const original = captureTree([data]);
      assert.equal(restored.size, original.size);
      for (const [file, bytes] of original) {
        const got = /** @type {Buffer} */ (restored.get(file));
        assert.ok(got !== undefined, `missing ${file}`);
        assert.ok(got.equals(bytes), `${file} differs after the round-trip`);
      }

      // The store the backup left is a legal repository by the model's own
      // independent read, and verify agrees with the model's verdict.
      const model = new RepoModel(bucket, real);
      assert.deepEqual(await checkStore(model), []);
      process.exitCode = 0;
      await verify(bucket);
      assert.equal(process.exitCode, 0);
    },
  );

  it(
    "an incremental backup dedups against the store and both snapshots restore",
    { timeout: 600_000 },
    async () => {
      await using dir = await mkdtempDisposable(join("test", ".tmp"));
      const root = dir.path;
      useTempHome(root);
      mkdirSync(join(root, "data"), { recursive: true });
      const data = realpathSync.native(join(root, "data"));
      writeFileSync(join(data, "kept.txt"), "unchanged across snapshots");
      writeFileSync(join(data, "mutating.txt"), "first version");
      writeSet("conf", { dirs: [data], bucket });

      const first = await backup("conf");
      assert.equal(first.errors, 0);
      const firstTree = captureTree([data]);

      writeFileSync(join(data, "mutating.txt"), "second version");
      await nextMinute();
      const second = await backup("conf");
      assert.equal(second.errors, 0);
      assert.equal(
        second.uploaded,
        1,
        "only the changed file's object goes up — identical content stored once",
      );

      // The older snapshot still restores its exact tree (immutability), and
      // the newer one restores the mutation.
      const outFirst = join(root, "out-first");
      mkdirSync(outFirst, { recursive: true });
      process.exitCode = 0;
      await restore([], {
        set: "conf",
        snapshot: first.snapshot,
        output: outFirst,
      });
      assert.equal(process.exitCode, 0);
      const restoredFirst = captureTree([join(outFirst, "data")]);
      for (const [file, bytes] of firstTree) {
        const got = /** @type {Buffer} */ (restoredFirst.get(file));
        assert.ok(
          got?.equals(bytes),
          `${file} differs from the first snapshot`,
        );
      }
      const outSecond = join(root, "out-second");
      mkdirSync(outSecond, { recursive: true });
      process.exitCode = 0;
      await restore([], {
        set: "conf",
        snapshot: second.snapshot,
        output: outSecond,
      });
      assert.equal(process.exitCode, 0);
      const mutated = captureTree([join(outSecond, "data")]).get(
        "data/mutating.txt",
      );
      assert.equal(mutated?.toString(), "second version");

      const model = new RepoModel(bucket, real);
      assert.deepEqual(await checkStore(model), []);
    },
  );
});
