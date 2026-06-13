import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtempDisposable } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { describe, it } from "node:test";
import {
  stringifySnapshot,
  withSnapshotFile,
  writeSnapshot,
} from "../lib/snapshot-file.mjs";
import { compareSnapshots } from "./compare.mjs";

const mkTmpDir = async () => mkdtempDisposable(join("test", ".tmp"));

// These exercise the storage core `compareSnapshots(snapshotDir, dirs, …)`
// directly — the snapshots are written into the temp dir and the temp dir is
// the (single) member root, so displayed paths come out relative to it, just
// as `compare`'s set wrapper would render them. The set-resolution wiring is
// covered in e2e.
//
// listSnapshotNames() only reports datestamped `.tsv.zst` snapshots, so tests
// that lean on the default since/until resolution use real-looking names —
// lexical order is chronological order.
const OLDEST = "2023-12-31T0101";
const PREVIOUS = "2024-01-01T0101";
const CURRENT = "2024-01-02T0101";

describe("compare", () => {
  it("shows added file (first snapshot compares against an empty baseline)", async () => {
    await using dir = await mkTmpDir();

    await writeSnapshot(dir.path, CURRENT, [
      new File(["contents1"], "file1.txt"),
    ]);

    const result = await compareSnapshots(dir.path, [dir.path]);

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
    const latestResult = await compareSnapshots(dir.path, [dir.path]);
    assert.deepStrictEqual(latestResult, {
      added: ["fileC.txt"],
      moved: [],
      modified: [],
      deleted: [],
    });

    // Explicit until: the default baseline is *its* predecessor, not the
    // latest snapshot (the step-2 inversion bug) and not an empty baseline.
    const previousResult = await compareSnapshots(dir.path, [dir.path], {
      until: PREVIOUS,
    });
    assert.deepStrictEqual(previousResult, {
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

    const result = await compareSnapshots(dir.path, [dir.path]);

    assert.deepStrictEqual(result, {
      added: [],
      moved: [],
      modified: ["file1.txt"],
      deleted: [],
    });
  });

  it("shows swapped contents as two modifications", async () => {
    await using dir = await mkTmpDir();

    // Both paths persist, so neither can be a move source (only deleted
    // paths can) — two files trading hashes are just two modifications,
    // never an A→B/B→A cross-move of paths that still exist.
    await writeSnapshot(dir.path, PREVIOUS, [
      new File(["contents1"], "file.A"),
      new File(["contents2"], "file.B"),
    ]);

    await writeSnapshot(dir.path, CURRENT, [
      new File(["contents2"], "file.A"),
      new File(["contents1"], "file.B"),
    ]);

    const result = await compareSnapshots(dir.path, [dir.path]);

    assert.deepStrictEqual(result, {
      added: [],
      moved: [],
      modified: ["file.A", "file.B"],
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

    const result = await compareSnapshots(dir.path, [dir.path]);

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

    const result = await compareSnapshots(dir.path, [dir.path]);

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

    const result = await compareSnapshots(dir.path, [dir.path], {
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

    const result = await compareSnapshots(dir.path, [dir.path], {
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

    const result = await compareSnapshots(dir.path, [dir.path], {
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

    const result = await compareSnapshots(dir.path, [dir.path], {
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

    const result = await compareSnapshots(dir.path, [dir.path], {
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

    const result = await compareSnapshots(dir.path, [dir.path], {
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

  it("annotates a copy with the moved-to location when the original moved away", async () => {
    await using dir = await mkTmpDir();

    await writeSnapshot(dir.path, PREVIOUS, [
      new File(["contents1"], "file.A"),
    ]);

    await writeSnapshot(dir.path, CURRENT, [
      new File(["contents1"], "file.B"),
      new File(["contents1"], "file.C"),
    ]);

    const result = await compareSnapshots(dir.path, [dir.path]);

    assert.deepStrictEqual(result, {
      added: ["file.C == file.B"],
      modified: [],
      deleted: [],
      moved: ["file.A → file.B"],
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

    const result = await compareSnapshots(dir.path, [dir.path]);

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

    const result = await compareSnapshots(dir.path, [dir.path]);

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

  it("treats a file that failed hashing as deleted", async () => {
    await using dir = await mkTmpDir();

    await writeSnapshot(dir.path, PREVIOUS, [
      new File(["contents1"], "file1.txt"),
    ]);

    // A file that errors during snapshot (e.g. permission denied) is written
    // as a #comment line — exactly what the snapshot pipeline produces for
    // an unreadable file — and the snapshot reader skips comments. So the
    // path is invisible to compare and reports as deleted even though the
    // file is still on disk. Documented caveat; revisit when backup/restore
    // lands.
    await withSnapshotFile(dir.path, CURRENT, (stream) =>
      pipeline(
        stringifySnapshot(
          new Map([
            [
              resolve(dir.path, "file1.txt"),
              new Error("EACCES: permission denied"),
            ],
          ]),
        ),
        stream,
      ),
    );

    const result = await compareSnapshots(dir.path, [dir.path]);

    assert.deepStrictEqual(result, {
      added: [],
      moved: [],
      modified: [],
      deleted: ["file1.txt"],
    });
  });

  it("rejects an explicit snapshot name that does not exist", async () => {
    await using dir = await mkTmpDir();

    await writeSnapshot(dir.path, "current", [
      new File(["contents1"], "file1.txt"),
    ]);

    await assert.rejects(
      compareSnapshots(dir.path, [dir.path], {
        since: "nope",
        until: "current",
      }),
      /Snapshot 'nope' not found/,
    );

    await assert.rejects(
      compareSnapshots(dir.path, [dir.path], {
        since: "current",
        until: "nope",
      }),
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
      compareSnapshots(dir.path, [dir.path], { until: "debug" }),
      /not in the snapshot list/,
    );

    const result = await compareSnapshots(dir.path, [dir.path], {
      since: PREVIOUS,
      until: "debug",
    });

    assert.deepStrictEqual(result, {
      added: ["file2.txt"],
      moved: [],
      modified: [],
      deleted: [],
    });
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

    const result = await compareSnapshots(dir.path, [dir.path], {
      until: CURRENT + ".tsv.zst",
    });

    assert.deepStrictEqual(result, {
      added: ["file2.txt"],
      moved: [],
      modified: [],
      deleted: [],
    });
  });

  it("keeps a relative display for a top segment that starts with '..'", async () => {
    await using dir = await mkTmpDir();

    // A folder literally named `..stuff` produces a relative path beginning
    // with `..` that is NOT a parent escape — it must still display relative,
    // not fall back to the absolute path.
    await writeSnapshot(dir.path, PREVIOUS, []);
    await writeSnapshot(dir.path, CURRENT, [
      new File(["x"], "..stuff/file.txt"),
    ]);

    const result = await compareSnapshots(dir.path, [dir.path]);

    assert.deepStrictEqual(result.added, [join("..stuff", "file.txt")]);
  });

  it("displays each path relative to its own member root (multi-root)", async () => {
    await using dir = await mkTmpDir();

    // Two member roots; a manifest spanning both stores absolute paths. The
    // report shortens each against the root that contains it. (Absolute so the
    // stored keys aren't re-resolved against the temp dir.)
    const rootA = resolve(dir.path, "rootA");
    const rootB = resolve(dir.path, "rootB");
    mkdirSync(join(rootA, "sub"), { recursive: true });
    mkdirSync(rootB, { recursive: true });
    const fileA = join(rootA, "sub", "x.txt");
    const fileB = join(rootB, "y.txt");
    writeFileSync(fileA, "aaa");
    writeFileSync(fileB, "bbb");

    await writeSnapshot(dir.path, PREVIOUS, []);
    await writeSnapshot(dir.path, CURRENT, [fileA, fileB]);

    const result = await compareSnapshots(dir.path, [rootA, rootB]);

    assert.deepStrictEqual(result.added.sort(), [
      join("sub", "x.txt"),
      "y.txt",
    ]);
    assert.deepStrictEqual(result.moved, []);
  });
});
