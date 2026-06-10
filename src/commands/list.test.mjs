import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtempDisposable } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import { list } from "./list.mjs";

const mkTmpDir = async () => mkdtempDisposable(join("test", ".tmp"));

function makeSnapshots(base, names) {
  const snapshotDir = join(base, ".s3cab", "snapshots");
  mkdirSync(snapshotDir, { recursive: true });
  for (const name of names) {
    writeFileSync(join(snapshotDir, name), "");
  }
}

describe("list", () => {
  it("returns empty array when no snapshot directory exists", async () => {
    await using dir = await mkTmpDir();
    assert.deepEqual(list(dir.path), []);
  });

  it("returns empty array for an empty snapshot directory", async () => {
    await using dir = await mkTmpDir();
    mkdirSync(join(dir.path, ".s3cab", "snapshots"), { recursive: true });
    assert.deepEqual(list(dir.path), []);
  });

  it("lists snapshot names newest-first", async () => {
    await using dir = await mkTmpDir();
    makeSnapshots(dir.path, [
      "2025-01-14T0830.tsv.zst",
      "2025-01-15T1030.tsv.zst",
      "2025-01-13T1200.tsv.zst",
    ]);
    assert.deepEqual(list(dir.path), [
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
    assert.deepEqual(list(dir.path), ["2025-01-15T1030"]);
  });

  it("latest returns the newest snapshot name", async () => {
    await using dir = await mkTmpDir();
    makeSnapshots(dir.path, [
      "2025-01-14T0830.tsv.zst",
      "2025-01-15T1030.tsv.zst",
    ]);
    assert.equal(list(dir.path, { latest: true }), "2025-01-15T1030");
  });

  it("latest returns undefined when no snapshots exist", async () => {
    await using dir = await mkTmpDir();
    assert.equal(list(dir.path, { latest: true }), undefined);
  });
});
