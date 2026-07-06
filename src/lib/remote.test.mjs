import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { remoteSnapshotsPrefix, uploadCandidates } from "./remote.mjs";

/**
 * Build a snapshot lookup from a path→hash map — only the hash matters to
 * `uploadCandidates`, so size/mtime are filler.
 * @param {Record<string, string>} pathToHash
 * @returns {import("./snapshot-file.mjs").SnapshotEntries}
 */
const lookup = (pathToHash) =>
  new Map(
    Object.entries(pathToHash).map(([path, hash]) => [
      path,
      { hash, size: 0, mtime: "" },
    ]),
  );

describe("remoteSnapshotsPrefix", () => {
  it("places a set's snapshots under snapshots/<set>/", () => {
    assert.equal(remoteSnapshotsPrefix("photos"), "snapshots/photos/");
  });
});

describe("uploadCandidates", () => {
  it("returns hashes in target but not in remote", () => {
    const target = lookup({ "a.txt": "h1", "b.txt": "h2", "c.txt": "h3" });
    const remote = lookup({ "a.txt": "h1" });
    assert.deepEqual([...uploadCandidates(target, remote)].sort(), [
      "h2",
      "h3",
    ]);
  });

  it("treats an empty remote (a set's first backup) as: everything is a candidate", () => {
    const target = lookup({ "a.txt": "h1", "b.txt": "h2" });
    assert.deepEqual([...uploadCandidates(target, new Map())].sort(), [
      "h1",
      "h2",
    ]);
  });

  it("counts a hash under several paths once", () => {
    const target = lookup({ "a.txt": "h1", "copy.txt": "h1", "b.txt": "h2" });
    assert.deepEqual([...uploadCandidates(target, new Map())].sort(), [
      "h1",
      "h2",
    ]);
  });

  it("matches on content — a file that only moved or was renamed is not re-uploaded", () => {
    const target = lookup({ "new/place.txt": "h1" });
    const remote = lookup({ "old/place.txt": "h1" });
    assert.deepEqual([...uploadCandidates(target, remote)], []);
  });

  it("returns nothing when every target hash is already present remotely", () => {
    const target = lookup({ "a.txt": "h1", "b.txt": "h2" });
    const remote = lookup({ x: "h1", y: "h2", z: "h3" });
    assert.deepEqual([...uploadCandidates(target, remote)], []);
  });
});
