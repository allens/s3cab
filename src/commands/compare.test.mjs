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
const OLDEST = "2023-12-31T0101";
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

  it("compares latest against its predecessor by default", async () => {
    await using dir = await mkTmpDir();

    await writeSnapshot(dir.path, OLDEST, [
      new File(["contentsA"], "fileA.txt"),
    ]);

    await writeSnapshot(dir.path, PREVIOUS, [
      new File(["contentsA"], "fileA.txt"),
      new File(["contentsB"], "fileB.txt"),
    ]);

    await writeSnapshot(dir.path, CURRENT, [
      new File(["contentsA"], "fileA.txt"),
      new File(["contentsB"], "fileB.txt"),
      new File(["contentsC"], "fileC.txt"),
    ]);

    // No options: latest vs the snapshot immediately before it — were the
    // baseline OLDEST instead, fileB would show as added too.
    assert.deepStrictEqual(await compare(dir.path), {
      added: ["fileC.txt"],
      moved: [],
      modified: [],
      deleted: [],
    });

    // Explicit until: the default baseline is *its* predecessor, not the
    // latest snapshot (the step-2 inversion bug) and not an empty baseline.
    assert.deepStrictEqual(await compare(dir.path, { until: PREVIOUS }), {
      added: ["fileB.txt"],
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

  it("shows rotation as modified plus a copy of the old content", async () => {
    await using dir = await mkTmpDir();

    // Rotation / copy-then-edit: app.log's old content now lives at
    // app.log.1, and app.log itself changed. Only *deleted* paths can be
    // move sources, so this is deliberately NOT reported as a move: from two
    // snapshots, "copied then edited" and "renamed away then recreated" are
    // indistinguishable, and modified-plus-copy is the reading that is
    // verifiably true from the data either way (git's rename detection draws
    // the same line). The == annotation refers to the previous snapshot:
    // app.log.1 holds what app.log *used to* contain.
    await writeSnapshot(dir.path, PREVIOUS, [new File(["old"], "app.log")]);

    await writeSnapshot(dir.path, CURRENT, [
      new File(["new"], "app.log"),
      new File(["old"], "app.log.1"),
    ]);

    const result = await compare(dir.path);

    assert.deepStrictEqual(result, {
      added: ["app.log.1 == app.log"],
      moved: [],
      modified: ["app.log"],
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

  it("pairs simultaneous moves by basename", async () => {
    await using dir = await mkTmpDir();

    // Both files are empty, so they share one hash — pairing must still line
    // up x with x and y with y rather than cross-pairing arbitrarily.
    await writeSnapshot(dir.path, PREVIOUS, [
      new File([""], "olddir/x.txt"),
      new File([""], "olddir/y.txt"),
    ]);

    await writeSnapshot(dir.path, CURRENT, [
      new File([""], "newdir/x.txt"),
      new File([""], "newdir/y.txt"),
    ]);

    const result = await compare(dir.path);

    assert.deepStrictEqual(result, {
      added: [],
      modified: [],
      deleted: [],
      moved: [
        `olddir${sep}x.txt →→ newdir${sep}x.txt`,
        `olddir${sep}y.txt →→ newdir${sep}y.txt`,
      ],
    });
  });

  it("prefers a same-directory move source when basenames differ", async () => {
    await using dir = await mkTmpDir();

    await writeSnapshot(dir.path, PREVIOUS, [
      new File(["contents1"], "dir1/old.txt"),
      new File(["contents1"], "dir2/old.txt"),
    ]);

    await writeSnapshot(dir.path, CURRENT, [
      new File(["contents1"], "dir1/new.txt"),
      new File(["contents1"], "dir2/new.txt"),
    ]);

    const result = await compare(dir.path);

    assert.deepStrictEqual(result, {
      added: [],
      modified: [],
      deleted: [],
      moved: [
        `dir1${sep}old.txt → dir1${sep}new.txt`,
        `dir2${sep}old.txt → dir2${sep}new.txt`,
      ],
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
