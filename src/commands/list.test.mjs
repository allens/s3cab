import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { mkdtempDisposable } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { writeSet } from "../lib/sets.mjs";
import { list, listSnapshotNames } from "./list.mjs";
import { useTempHome } from "../../test/helpers/temp-home.mjs";

const mkTmpDir = async () => mkdtempDisposable(join("test", ".tmp"));

// These exercise the storage core `listSnapshotNames(snapshotDir)` directly —
// the temp dir stands in for a set's `~/.s3cab/sets/<set>/snapshots/`. The set
// resolution `list` wraps it in is covered in e2e.

/**
 * @param {string} snapshotDir
 * @param {string[]} names
 */
function makeSnapshots(snapshotDir, names) {
  for (const name of names) {
    writeFileSync(join(snapshotDir, name), "");
  }
}

describe("listSnapshotNames", () => {
  it("returns empty array when the snapshot directory does not exist", async () => {
    await using dir = await mkTmpDir();
    assert.deepEqual(listSnapshotNames(join(dir.path, "nope")), []);
  });

  it("returns empty array for an empty snapshot directory", async () => {
    await using dir = await mkTmpDir();
    assert.deepEqual(listSnapshotNames(dir.path), []);
  });

  it("lists snapshot names newest-first", async () => {
    await using dir = await mkTmpDir();
    makeSnapshots(dir.path, [
      "2025-01-14T0830.tsv.zst",
      "2025-01-15T1030.tsv.zst",
      "2025-01-13T1200.tsv.zst",
    ]);
    assert.deepEqual(listSnapshotNames(dir.path), [
      "2025-01-15T1030",
      "2025-01-14T0830",
      "2025-01-13T1200",
    ]);
  });

  it("ignores non-snapshot files", async () => {
    await using dir = await mkTmpDir();
    makeSnapshots(dir.path, [
      "2025-01-15T1030.tsv.zst",
      "not-a-snapshot.txt",
      ".snapshot.tsv.zst",
    ]);
    assert.deepEqual(listSnapshotNames(dir.path), ["2025-01-15T1030"]);
  });

  it("latest returns the newest snapshot name", async () => {
    await using dir = await mkTmpDir();
    makeSnapshots(dir.path, [
      "2025-01-14T0830.tsv.zst",
      "2025-01-15T1030.tsv.zst",
    ]);
    assert.equal(
      listSnapshotNames(dir.path, { latest: true }),
      "2025-01-15T1030",
    );
  });

  it("latest returns undefined when no snapshots exist", async () => {
    await using dir = await mkTmpDir();
    assert.equal(listSnapshotNames(dir.path, { latest: true }), undefined);
  });
});

// The `list` command's --remote path lists S3, so its real coverage is the
// gated remote.test.mjs (listRemoteSnapshots) + the e2e suite. Without S3, the
// testable bit is that --remote routes through the cloud-set front door:
// bucket-less sets stop with the bind-bucket command. Temp-home pattern as in
// sets.test.mjs.
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

describe("list --remote", () => {
  it("stops with the bind-bucket command for a bucket-less set", async () => {
    await using dir = await mkTmpDir();
    useTempHome(dir.path);
    writeSet("photos", { dirs: [join(dir.path, "photos")] });

    await assert.rejects(
      () => list("photos", { remote: true }),
      /no bucket bound[\s\S]*s3cab setup photos --bucket/,
    );
  });
});
