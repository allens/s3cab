import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { mkdtempDisposable } from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { remoteSnapshotsPrefix } from "../../src/lib/remote.mjs";
import { deleteObject, putText } from "../../src/lib/s3.mjs";
import { readSnapshot } from "../../src/lib/snapshot-file.mjs";
import { backup } from "../../src/commands/backup.mjs";
import { restore } from "../../src/commands/restore.mjs";
import { setup } from "../../src/commands/setup.mjs";
import { useTempHome } from "../helpers/temp-home.mjs";
import { bucket, cleanupSetMarker } from "../helpers/integration.mjs";

// The backup → restore round trip against a real bucket (docs/design/backup.md
// slice 4) — the single most valuable integration test. Restore inherently needs
// the cloud (the object content lives only in `objects/`), so there is no offline
// form. The gate/harness lives in the shared integration helper; useTempHome
// redirects only S3CAB_HOME (leaving HOME/~/.aws visible for credentials).

const mkTmpDir = async () => mkdtempDisposable(join("test", ".tmp"));

/** @type {NodeJS.ProcessEnv} */
let savedEnv;
beforeEach(() => {
  savedEnv = { ...process.env };
});
afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in savedEnv)) {
      delete process.env[key];
    }
  }
  Object.assign(process.env, savedEnv);
});

const sha256 = (/** @type {string} */ path) =>
  createHash("sha256").update(readFileSync(path)).digest("hex");

describe("backup → restore round trip (real bucket)", () => {
  it("recovers files byte-identically, skips existing, and overwrites on request", async () => {
    await using dir = await mkTmpDir();
    useTempHome(dir.path);
    const setName = `rt${Date.now()}`; // lowercase + digits: a valid set name

    // A small tree with a nested directory; unique content → unique object hashes,
    // so the shared objects/ store stays isolated and teardown deletes exactly
    // what this run made.
    const srcDir = join(dir.path, "Photos");
    mkdirSync(join(srcDir, "2024"), { recursive: true });
    const beach = join(srcDir, "beach.jpg");
    const ski = join(srcDir, "2024", "ski.jpg");
    writeFileSync(beach, `beach ${setName}`);
    writeFileSync(ski, `ski ${setName}`);

    const set = await setup([srcDir], { set: setName, bucket });
    assert.ok(set); // creating a set returns it
    const { snapshot } = await backup(setName);

    // The snapshot is the source of truth for what restore should reproduce
    // (its keys are the original absolute paths; realpath may differ from the
    // join above, so assert against the snapshot, not the literal paths).
    const { entries } = await readSnapshot(set.snapshotsDir, snapshot);
    const hashes = [...new Set([...entries.values()].map((p) => p.hash))];

    try {
      // Wipe the originals, then restore to their original locations.
      rmSync(srcDir, { recursive: true, force: true });
      const r1 = await restore([], { set: setName });
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
      const r2 = await restore([], { set: setName });
      assert.equal(r2.restored.length, 0);
      assert.equal(r2.skipped.length, entries.size);

      // --overwrite replaces a locally changed file with the backed-up content.
      const first = [...entries][0];
      assert.ok(first, "snapshot has at least one entry");
      const [firstPath, firstProps] = first;
      writeFileSync(firstPath, "locally changed since the backup");
      const r3 = await restore([], { set: setName, overwrite: true });
      assert.equal(r3.skipped.length, 0);
      assert.equal(sha256(firstPath), firstProps.hash);

      // --output re-roots the same backup under a chosen directory, as
      // <output>/<source-basename>/… — independent of the originals.
      const outDir = join(dir.path, "restored");
      const r4 = await restore([], { set: setName, output: outDir });
      assert.equal(r4.skipped.length, 0);
      assert.equal(r4.restored.length, entries.size);
      const wantHashes = new Set([...entries.values()].map((p) => p.hash));
      for (const dest of r4.restored) {
        assert.ok(dest.startsWith(resolve(outDir)), `${dest} under ${outDir}`);
        assert.ok(
          dest.includes("Photos"),
          `${dest} keeps the source directory name`,
        );
        assert.ok(wantHashes.has(sha256(dest)), `content of ${dest}`);
      }
    } finally {
      for (const hash of hashes) {
        await deleteObject(`s3://${bucket}/objects/${hash}`);
      }
      await deleteObject(
        `s3://${bucket}/${remoteSnapshotsPrefix(setName)}${snapshot}.tsv.zst`,
      );
      // setup() also claimed the set's remote marker — clean it up too.
      await cleanupSetMarker(setName);
    }
  });

  it("skips a file whose object is gone from the bucket and restores the rest", async () => {
    // The mocked unit tests (src/commands/restore.missing-object.test.mjs) fake
    // getObject outright, so only a real bucket proves what this depends on: that
    // a GET on an absent key surfaces as `NoSuchKey` all the way out through
    // getStream → writeFileAtomic, rather than as some wrapped stream error. That
    // is the mock-vs-real gap #171's ABORT_ERR fell into.
    await using dir = await mkTmpDir();
    useTempHome(dir.path);
    const setName = `rtm${Date.now()}`;

    const srcDir = join(dir.path, "Photos");
    mkdirSync(srcDir, { recursive: true });
    writeFileSync(join(srcDir, "kept.jpg"), `kept ${setName}`);
    writeFileSync(join(srcDir, "gone.jpg"), `gone ${setName}`);

    const set = await setup([srcDir], { set: setName, bucket });
    assert.ok(set);
    const { snapshot } = await backup(setName);

    const { entries } = await readSnapshot(set.snapshotsDir, snapshot);
    const hashes = [...new Set([...entries.values()].map((p) => p.hash))];
    const gonePath = [...entries.keys()].find((p) => p.endsWith("gone.jpg"));
    assert.ok(gonePath, "the snapshot recorded gone.jpg");
    const goneHash = /** @type {string} */ (entries.get(gonePath)?.hash);

    const savedExitCode = process.exitCode;
    try {
      // Remove exactly one object behind the snapshot's back — an out-of-band
      // deletion, the case a lifecycle rule or a hand-tidied bucket produces.
      await deleteObject(`s3://${bucket}/objects/${goneHash}`);
      rmSync(srcDir, { recursive: true, force: true });

      const result = await restore([], { set: setName });

      assert.deepEqual(result.missing, [gonePath], "the casualty is reported");
      assert.equal(result.restored.length, entries.size - 1);
      assert.equal(process.exitCode, 1, "a partial restore exits non-zero");
      // The point of the whole change: everything else is on disk anyway.
      for (const dest of result.restored) {
        assert.equal(
          sha256(dest),
          entries.get(dest)?.hash,
          `content of ${dest}`,
        );
      }
    } finally {
      process.exitCode = savedExitCode; // never leak it to the runner
      for (const hash of hashes) {
        await deleteObject(`s3://${bucket}/objects/${hash}`);
      }
      await deleteObject(
        `s3://${bucket}/${remoteSnapshotsPrefix(setName)}${snapshot}.tsv.zst`,
      );
      await cleanupSetMarker(setName);
    }
  });

  it("skips a file whose object is corrupt and restores the rest", async () => {
    // Clean-room run 3's finding A1. The digest check runs after a real S3 body
    // has streamed to completion — the teardown path mocks can't exercise — so
    // only a real bucket proves the next file's GET still works, and that the
    // known-bad bytes don't survive as a temp beside the restored tree.
    await using dir = await mkTmpDir();
    useTempHome(dir.path);
    const setName = `rtc${Date.now()}`;

    const srcDir = join(dir.path, "Photos");
    mkdirSync(srcDir, { recursive: true });
    writeFileSync(join(srcDir, "a-intact.jpg"), `a ${setName}`);
    writeFileSync(join(srcDir, "b-corrupt.jpg"), `b ${setName}`);
    writeFileSync(join(srcDir, "c-intact.jpg"), `c ${setName}`);

    const set = await setup([srcDir], { set: setName, bucket });
    assert.ok(set);
    const { snapshot } = await backup(setName);

    const { entries } = await readSnapshot(set.snapshotsDir, snapshot);
    const hashes = [...new Set([...entries.values()].map((p) => p.hash))];
    const badPath = [...entries.keys()].find((p) =>
      p.endsWith("b-corrupt.jpg"),
    );
    assert.ok(badPath, "the snapshot recorded b-corrupt.jpg");
    const badHash = /** @type {string} */ (entries.get(badPath)?.hash);

    const savedExitCode = process.exitCode;
    try {
      // Right key, wrong bytes — damage no s3cab command produces.
      await putText(
        `s3://${bucket}/objects/${badHash}`,
        "not the bytes this key promises",
      );
      rmSync(srcDir, { recursive: true, force: true });

      const result = await restore([], { set: setName });

      assert.deepEqual(result.corrupt, [badPath], "the casualty is reported");
      assert.deepEqual(result.missing, []);
      assert.equal(result.restored.length, entries.size - 1);
      assert.equal(process.exitCode, 1, "a partial restore exits non-zero");
      for (const dest of result.restored) {
        assert.equal(
          sha256(dest),
          entries.get(dest)?.hash,
          `content of ${dest}`,
        );
      }
      // Nothing for the corrupt file: no file, no temp holding its bytes.
      assert.deepEqual(readdirSync(srcDir).sort(), [
        "a-intact.jpg",
        "c-intact.jpg",
      ]);
    } finally {
      process.exitCode = savedExitCode; // never leak it to the runner
      for (const hash of hashes) {
        await deleteObject(`s3://${bucket}/objects/${hash}`);
      }
      await deleteObject(
        `s3://${bucket}/${remoteSnapshotsPrefix(setName)}${snapshot}.tsv.zst`,
      );
      await cleanupSetMarker(setName);
    }
  });
});
