import assert from "node:assert/strict";
import { mkdtempDisposable } from "node:fs/promises";
import { join, sep } from "node:path";
import { describe, it } from "node:test";
import { writeSnapshot } from "../lib/snapshot-file.mjs";
import { compare } from "./compare.mjs";

const mkTmpDir = async () => mkdtempDisposable(join("test", ".tmp"));

describe("compare", () => {
  it("shows added file", async () => {
    await using dir = await mkTmpDir();

    await writeSnapshot(dir.path, "current", [
      new File(["contents1"], "file1.txt"),
    ]);

    const result = await compare(dir.path, { until: "current" });

    assert.deepStrictEqual(result, {
      added: ["file1.txt"],
      moved: [],
      modified: [],
      deleted: [],
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
});
