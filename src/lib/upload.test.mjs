import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { mkdtempDisposable } from "node:fs/promises";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";
import { writeSnapshot } from "../../test/helpers/write-snapshot.mjs";
import { planUpload, uploadSnapshot } from "./upload.mjs";

/** @import { SnapshotEntries } from "./snapshot-file.mjs" */

const mkTmpDir = async () => mkdtempDisposable(join("test", ".tmp"));

/**
 * Build a snapshot lookup from a path→hash map — only the hash matters to
 * `planUpload`, so size/mtime are filler.
 * @param {Record<string, string>} pathToHash
 * @returns {SnapshotEntries}
 */
const lookup = (pathToHash) =>
  new Map(
    Object.entries(pathToHash).map(([path, hash]) => [
      path,
      { hash, size: 0, mtime: "" },
    ]),
  );

describe("planUpload", () => {
  it("plans hashes in the target but not in the baseline", async () => {
    const target = lookup({ "a.txt": "h1", "b.txt": "h2", "c.txt": "h3" });
    const baseline = lookup({ "a.txt": "h1" });
    const plan = await planUpload(target, { baseline });
    assert.deepEqual([...plan.keys()].sort(), ["h2", "h3"]);
  });

  it("plans everything when nothing is known to be stored", async () => {
    const target = lookup({ "a.txt": "h1", "b.txt": "h2" });
    // No sources at all, and an empty baseline, read the same.
    const bare = await planUpload(target);
    assert.deepEqual([...bare.keys()].sort(), ["h1", "h2"]);
    const empty = await planUpload(target, { baseline: new Map() });
    assert.deepEqual([...empty.keys()].sort(), ["h1", "h2"]);
  });

  it("plans a hash under several paths once — the first path wins", async () => {
    const target = lookup({ "a.txt": "h1", "copy.txt": "h1", "b.txt": "h2" });
    const plan = await planUpload(target);
    assert.deepEqual(
      plan,
      new Map([
        ["h1", "a.txt"],
        ["h2", "b.txt"],
      ]),
    );
  });

  it("matches on content — a file that only moved or was renamed is not re-uploaded", async () => {
    const target = lookup({ "new/place.txt": "h1" });
    const baseline = lookup({ "old/place.txt": "h1" });
    const plan = await planUpload(target, { baseline });
    assert.equal(plan.size, 0);
  });

  it("plans nothing when every target hash is already in the baseline", async () => {
    const target = lookup({ "a.txt": "h1", "b.txt": "h2" });
    const baseline = lookup({ x: "h1", y: "h2", z: "h3" });
    const plan = await planUpload(target, { baseline });
    assert.equal(plan.size, 0);
  });

  it("streams listed store hashes out of the plan (the first-backup LIST diff)", async () => {
    const target = lookup({ "a.txt": "h1", "b.txt": "h2", "c.txt": "h3" });
    // An async iterable, as listObjectHashes yields — including hashes the
    // target never references (other sets' objects in the shared store).
    async function* listed() {
      yield "h2";
      yield "h-other-set";
    }
    const plan = await planUpload(target, { listed: listed() });
    assert.deepEqual(
      plan,
      new Map([
        ["h1", "a.txt"],
        ["h3", "c.txt"],
      ]),
    );
  });

  it("accepts a plain array for listed, and applies baseline and listed together", async () => {
    const target = lookup({ "a.txt": "h1", "b.txt": "h2", "c.txt": "h3" });
    const baseline = lookup({ "old.txt": "h1" });
    const plan = await planUpload(target, { baseline, listed: ["h3"] });
    assert.deepEqual(plan, new Map([["h2", "b.txt"]]));
  });
});

// The snapshot→upload staleness guard: a planned file that changed (or vanished)
// since the snapshot must abort the run, never store its current bytes under the
// snapshot's old-content hash (proposals/bugs.md). These stay hermetic — the
// guard fires *before* any S3 call, so with a `--since` baseline (no store LIST)
// and a drifted file, `uploadSnapshot` rejects without touching the bucket. The
// dummy bucket would fail loudly with an unrelated error if a PUT were ever
// reached, so matching the stale message proves the abort came from the guard.
describe("uploadSnapshot drift guard", () => {
  /**
   * Snapshot one real file as the upload target, with an empty baseline so the
   * file is planned (its hash isn't in the baseline). Returns the file path and
   * the shared `uploadSnapshot` args (with `since`, so no store LIST runs).
   * @param {string} dirPath - A temp dir to build the fixture in
   */
  const planOneFile = async (dirPath) => {
    const contentDir = resolve(dirPath, "content");
    mkdirSync(contentDir, { recursive: true });
    const file = join(contentDir, "photo.raw");
    writeFileSync(file, "original bytes");

    const snapshotDir = join(dirPath, "snapshots");
    mkdirSync(snapshotDir, { recursive: true });
    const target = "2025-01-15T1030";
    const baseline = "2025-01-15T1020";
    await writeSnapshot(snapshotDir, baseline, []); // empty → target file planned
    await writeSnapshot(snapshotDir, target, [file]);

    return {
      file,
      args: {
        bucket: "unused-drift-guard-bucket",
        set: "drifty",
        snapshotDir,
        name: target,
        since: baseline,
      },
    };
  };

  it("aborts when a planned file changed since the snapshot", async () => {
    await using dir = await mkTmpDir();
    const { file, args } = await planOneFile(dir.path);

    // Rewrite with different-length content: size drifts even if the filesystem
    // mtime resolution were too coarse to catch the edit on its own.
    writeFileSync(file, "different, longer bytes");

    await assert.rejects(() => uploadSnapshot(args), /changed or was removed/);
  });

  it("aborts when a planned file was removed since the snapshot", async () => {
    await using dir = await mkTmpDir();
    const { file, args } = await planOneFile(dir.path);

    rmSync(file);

    await assert.rejects(() => uploadSnapshot(args), /changed or was removed/);
  });
});
