import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { planUpload } from "./upload.mjs";

/** @import { SnapshotEntries } from "./snapshot-file.mjs" */

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
