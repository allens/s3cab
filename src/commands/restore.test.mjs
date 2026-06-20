import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { mkdtempDisposable } from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { remoteSnapshotsPrefix } from "../lib/remote.mjs";
import { deleteObject } from "../lib/s3.mjs";
import { resolveRemoteSet, setSnapshotsDir } from "../lib/sets.mjs";
import { readSnapshot } from "../lib/snapshot-file.mjs";
import { backup } from "./backup.mjs";
import { restore } from "./restore.mjs";
import { setup } from "./setup.mjs";
import { useTempHome } from "../../test/helpers/temp-home.mjs";

// The pure restore-planning functions (selectEntries, reroot, planRestore) are
// unit-tested in lib/restore.test.mjs. This file covers the restore command
// itself end-to-end.

// The backup → restore round trip against a real bucket (docs/specs/backup.md slice
// 4). Gated on S3CAB_TEST_BUCKET (+ ambient AWS credentials) like the other S3
// suites: restore inherently needs the cloud (the object content lives only in
// `objects/`), so there is no offline form of this test. Credentials must come
// from the environment (CI/OIDC) because useTempHome redirects HOME away from
// any ~/.aws config to isolate the set store and objects cache.
const TEST_BUCKET = process.env.S3CAB_TEST_BUCKET;
const skip = TEST_BUCKET
  ? false
  : "set S3CAB_TEST_BUCKET (and AWS credentials) to run S3 integration tests";

const mkTmpDir = async () => mkdtempDisposable(join("test", ".tmp"));

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

const sha256 = (/** @type {string} */ path) =>
  createHash("sha256").update(readFileSync(path)).digest("hex");

describe("backup → restore round trip (real bucket)", { skip }, () => {
  it("recovers files byte-identically, skips existing, and overwrites on request", async () => {
    await using dir = await mkTmpDir();
    useTempHome(dir.path);
    const bucket = /** @type {string} */ (TEST_BUCKET);
    const setName = `rt${Date.now()}`; // lowercase + digits: a valid set name

    // A small tree with a nested folder; unique content → unique object hashes,
    // so the shared objects/ store stays isolated and teardown deletes exactly
    // what this run made.
    const srcDir = join(dir.path, "Photos");
    mkdirSync(join(srcDir, "2024"), { recursive: true });
    const beach = join(srcDir, "beach.jpg");
    const ski = join(srcDir, "2024", "ski.jpg");
    writeFileSync(beach, `beach ${setName}`);
    writeFileSync(ski, `ski ${setName}`);

    await setup(setName, [srcDir], { bucket });
    const { snapshot } = await backup(setName);

    // The snapshot is the source of truth for what restore should reproduce
    // (its keys are the original absolute paths; realpath may differ from the
    // join above, so assert against the snapshot, not the literal paths).
    const { entries } = await readSnapshot(setSnapshotsDir(setName), snapshot);
    const hashes = [...new Set([...entries.values()].map((p) => p.hash))];

    try {
      // Wipe the originals, then restore to their original locations.
      rmSync(srcDir, { recursive: true, force: true });
      const r1 = await restore(setName);
      assert.equal(r1.snapshot, snapshot);
      assert.equal(r1.skipped.length, 0);
      assert.equal(r1.restored.length, entries.size);
      for (const [path, props] of entries) {
        assert.equal(sha256(path), props.hash, `content of ${path}`);
        assert.equal(
          statSync(path).mtime.getTime(),
          new Date(props.mtime).getTime(),
          `mtime of ${path}`,
        );
      }

      // A second restore touches nothing — every file now exists.
      const r2 = await restore(setName);
      assert.equal(r2.restored.length, 0);
      assert.equal(r2.skipped.length, entries.size);

      // --overwrite replaces a locally changed file with the backed-up content.
      const first = [...entries][0];
      assert.ok(first, "snapshot has at least one entry");
      const [firstPath, firstProps] = first;
      writeFileSync(firstPath, "locally changed since the backup");
      const r3 = await restore(setName, [], { overwrite: true });
      assert.equal(r3.skipped.length, 0);
      assert.equal(sha256(firstPath), firstProps.hash);

      // --output re-roots the same backup under a chosen folder, as
      // <output>/<source-basename>/… — independent of the originals.
      const outDir = join(dir.path, "restored");
      const r4 = await restore(setName, [], { output: outDir });
      assert.equal(r4.skipped.length, 0);
      assert.equal(r4.restored.length, entries.size);
      const wantHashes = new Set([...entries.values()].map((p) => p.hash));
      for (const dest of r4.restored) {
        assert.ok(dest.startsWith(resolve(outDir)), `${dest} under ${outDir}`);
        assert.ok(
          dest.includes("Photos"),
          `${dest} keeps the source folder name`,
        );
        assert.ok(wantHashes.has(sha256(dest)), `content of ${dest}`);
      }
    } finally {
      for (const hash of hashes) {
        await deleteObject(`s3://${bucket}/objects/${hash}`);
      }
      const { namespace } = resolveRemoteSet(setName);
      await deleteObject(
        `s3://${bucket}/${remoteSnapshotsPrefix(namespace)}${snapshot}.tsv.zst`,
      );
    }
  });
});
