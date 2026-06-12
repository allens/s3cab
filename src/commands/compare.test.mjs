import assert from "node:assert/strict";
import { mkdtempDisposable } from "node:fs/promises";
import { join, sep } from "node:path";
import { describe, it } from "node:test";
import { writeSnapshot } from "../lib/snapshot-file.mjs";
import { compare } from "./compare.mjs";

const mkTmpDir = async () => mkdtempDisposable(join("test", ".tmp"));

// list() only reports datestamped `.tsv.zst` snapshots, so tests that lean
// on the default since/until resolution use real-looking names — lexical
// order is chronological order.
const PREVIOUS = "2024-01-01T0101";
const CURRENT = "2024-01-02T0101";

describe("compare", () => {
  it("shows added file (first snapshot compares against an empty baseline)", async () => {
    await using dir = await mkTmpDir();

    await writeSnapshot(dir.path, CURRENT, [
      new File(["contents1"], "file1.txt"),
    ]);

    const result = await compare(dir.path);

    assert.deepStrictEqual(result, {
      added: ["file1.txt"],
      moved: [],
      modified: [],
      deleted: [],
    });
  });

  it("shows modified file and ignores a file whose mtime alone changed", async () => {
    await using dir = await mkTmpDir();

    await writeSnapshot(dir.path, PREVIOUS, [
      new File(["contents1"], "file1.txt", { lastModified: 1700000000000 }),
      new File(["same"], "file2.txt", { lastModified: 1700000000000 }),
    ]);

    // file1 changes content; file2 keeps its content but is touched.
    await writeSnapshot(dir.path, CURRENT, [
      new File(["contents2"], "file1.txt", { lastModified: 1800000000000 }),
      new File(["same"], "file2.txt", { lastModified: 1800000000000 }),
    ]);

    const result = await compare(dir.path);

    assert.deepStrictEqual(result, {
      added: [],
      moved: [],
      modified: ["file1.txt"],
      deleted: [],
    });
  });

  it("shows deleted file", async () => {
    await using dir = await mkTmpDir();

    await writeSnapshot(dir.path, PREVIOUS, [
      new File(["contents1"], "file1.txt"),
      new File(["contents2"], "file2.txt"),
    ]);

    await writeSnapshot(dir.path, CURRENT, [
      new File(["contents1"], "file1.txt"),
    ]);

    const result = await compare(dir.path);

    assert.deepStrictEqual(result, {
      added: [],
      moved: [],
      modified: [],
      deleted: ["file2.txt"],
    });
  });

  it("shows renamed file", async () => {
    await using dir = await mkTmpDir();

    await writeSnapshot(dir.path, "previous", [
      new File(["contents1"], "oldname.txt"),
    ]);

    await writeSnapshot(dir.path, "current", [
      new File(["contents1"], "newname.txt"),
    ]);

    const result = await compare(dir.path, {
      since: "previous",
      until: "current",
    });

    assert.deepStrictEqual(result, {
      added: [],
      modified: [],
      moved: ["oldname.txt → newname.txt"],
      deleted: [],
    });
  });

  it("shows moved file", async () => {
    await using dir = await mkTmpDir();

    await writeSnapshot(dir.path, "previous", [
      new File(["contents1"], "olddir/file1.txt"),
    ]);

    await writeSnapshot(dir.path, "current", [
      new File(["contents1"], "newdir/file1.txt"),
    ]);

    const result = await compare(dir.path, {
      since: "previous",
      until: "current",
    });

    assert.deepStrictEqual(result, {
      added: [],
      modified: [],
      deleted: [],
      moved: [`olddir${sep}file1.txt →→ newdir${sep}file1.txt`],
    });
  });

  it("shows moved file and ignores persisting file with same content", async () => {
    await using dir = await mkTmpDir();

    // file.A persists across both snapshots with the same content as the moved file.
    // The algorithm must not mistake file.A as the move source.
    await writeSnapshot(dir.path, "previous", [
      new File(["contents1"], "file.A"),
      new File(["contents1"], "olddir/file1.txt"),
    ]);

    await writeSnapshot(dir.path, "current", [
      new File(["contents1"], "file.A"),
      new File(["contents1"], "newdir/file1.txt"),
    ]);

    const result = await compare(dir.path, {
      since: "previous",
      until: "current",
    });

    assert.deepStrictEqual(result, {
      added: [],
      modified: [],
      deleted: [],
      moved: [`olddir${sep}file1.txt →→ newdir${sep}file1.txt`],
    });
  });

  it("shows moved and a copy", async () => {
    await using dir = await mkTmpDir();

    await writeSnapshot(dir.path, "previous", [
      new File(["contents1"], "file.A"),
      new File(["contents1"], "file.B"),
    ]);

    await writeSnapshot(dir.path, "current", [
      new File(["contents1"], "file.A"),
      new File(["contents1"], "file.X"),
      new File(["contents1"], "file.Y"),
    ]);

    const result = await compare(dir.path, {
      since: "previous",
      until: "current",
    });

    assert.deepStrictEqual(result, {
      added: ["file.Y == file.A"],
      modified: [],
      deleted: [],
      moved: ["file.B → file.X"],
    });
  });

  it("shows moved file with multiple existing copies", async () => {
    await using dir = await mkTmpDir();

    await writeSnapshot(dir.path, "previous", [
      new File(["contents1"], "file.A"),
      new File(["contents1"], "file.B"),
      new File(["contents1"], "file.C"),
    ]);

    await writeSnapshot(dir.path, "current", [
      new File(["contents1"], "file.A"),
      new File(["contents1"], "file.B"),
      new File(["contents1"], "file.X"),
      new File(["contents1"], "file.Y"),
      new File(["contents1"], "file.Z"),
    ]);

    const result = await compare(dir.path, {
      since: "previous",
      until: "current",
    });

    assert.deepStrictEqual(result, {
      added: ["file.Y == file.A,file.B", "file.Z == file.A,file.B"],
      modified: [],
      deleted: [],
      moved: ["file.C → file.X"],
    });
  });

  it("shows added files", async () => {
    await using dir = await mkTmpDir();

    await writeSnapshot(dir.path, "previous", [
      new File(["contents1"], "file.A"),
      new File(["contents1"], "file.B"),
    ]);

    await writeSnapshot(dir.path, "current", [
      new File(["contents1"], "file.A"),
      new File(["contents1"], "file.B"),
      new File(["contents1"], "file.X"),
      new File(["contents1"], "file.Y"),
      new File(["contents1"], "file.Z"),
    ]);

    const result = await compare(dir.path, {
      since: "previous",
      until: "current",
    });

    assert.deepStrictEqual(result, {
      added: [
        "file.X == file.A,file.B",
        "file.Y == file.A,file.B",
        "file.Z == file.A,file.B",
      ],
      modified: [],
      deleted: [],
      moved: [],
    });
  });

  it("rejects an explicit snapshot name that does not exist", async () => {
    await using dir = await mkTmpDir();

    await writeSnapshot(dir.path, "current", [
      new File(["contents1"], "file1.txt"),
    ]);

    await assert.rejects(
      compare(dir.path, { since: "nope", until: "current" }),
      /Snapshot 'nope' not found/,
    );

    await assert.rejects(
      compare(dir.path, { since: "current", until: "nope" }),
      /Snapshot 'nope' not found/,
    );
  });

  it("requires an explicit since when until is not a listed snapshot", async () => {
    await using dir = await mkTmpDir();

    await writeSnapshot(dir.path, PREVIOUS, [
      new File(["contents1"], "file1.txt"),
    ]);

    // Readable as a snapshot, but its name isn't datestamped so list() — and
    // therefore the default-predecessor rule — can't see it.
    await writeSnapshot(dir.path, "debug", [
      new File(["contents1"], "file1.txt"),
      new File(["contents2"], "file2.txt"),
    ]);

    await assert.rejects(
      compare(dir.path, { until: "debug" }),
      /not in the snapshot list/,
    );

    assert.deepStrictEqual(
      await compare(dir.path, { since: PREVIOUS, until: "debug" }),
      {
        added: ["file2.txt"],
        moved: [],
        modified: [],
        deleted: [],
      },
    );
  });

  it("accepts full snapshot filenames", async () => {
    await using dir = await mkTmpDir();

    await writeSnapshot(dir.path, PREVIOUS, [
      new File(["contents1"], "file1.txt"),
    ]);

    await writeSnapshot(dir.path, CURRENT, [
      new File(["contents1"], "file1.txt"),
      new File(["contents2"], "file2.txt"),
    ]);

    const result = await compare(dir.path, { until: CURRENT + ".tsv.zst" });

    assert.deepStrictEqual(result, {
      added: ["file2.txt"],
      moved: [],
      modified: [],
      deleted: [],
    });
  });
});
