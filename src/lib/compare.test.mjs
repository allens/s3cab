import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtempDisposable } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { describe, it } from "node:test";
import { zstdCompressSync } from "node:zlib";
import {
  stringifySnapshot,
  withSnapshotFile,
  // The production writer, aliased: the local `writeSnapshot` is the file-rows
  // test helper, and `#SKIPPED` rows only come out of the real one.
  writeSnapshot as writeFullSnapshot,
} from "./snapshot-file.mjs";
import { writeSnapshot } from "../../test/helpers/write-snapshot.mjs";
import { compareSnapshots, diff } from "./compare.mjs";

/** @import { CompareResult, DiffResult } from "./compare.mjs" */
/** @import { SnapshotEntries } from "./snapshot-file.mjs" */

const mkTmpDir = async () => mkdtempDisposable(join("test", ".tmp"));

// compare.mjs holds two seams and the tests split accordingly: `diff` — the
// classification engine, the intricate part — is driven directly with
// in-memory SnapshotEntries Maps, so pairing edge cases are cheap to
// enumerate (no fixture files). `compareSnapshots` tests keep only what the
// I/O shell adds on top: since/until resolution and defaults, reading real
// `.tsv.zst` files, the errors category, and the structured absolute-path
// result (ADR-0043) whose sizes come from the snapshot entries.

// ---------------------------------------------------------------------------
// diff — classification at its own interface.

/**
 * Build {@link SnapshotEntries} from `{ path: hash }` — `diff` classifies by
 * hash and path alone, so size/mtime are filler.
 * @param {Record<string, string>} byPath
 * @returns {SnapshotEntries}
 */
const entries = (byPath) =>
  new Map(
    Object.entries(byPath).map(([path, hash]) => [
      path,
      { hash, size: 0, mtime: "" },
    ]),
  );

/**
 * Project a {@link DiffResult} into compact strings for assertions: `path`,
 * `path == dup1,dup2` for a duplicated add, and `from → to` for a move.
 * @param {DiffResult} result
 */
const plain = ({ added, moved, modified, deleted }) => ({
  added: Array.from(added, ([path, duplicates]) =>
    duplicates.size ? `${path} == ${[...duplicates].join(",")}` : path,
  ),
  moved: Array.from(moved, ([from, to]) => `${from} → ${to}`),
  modified: [...modified],
  deleted: [...deleted],
});

const NONE = { added: [], moved: [], modified: [], deleted: [] };

describe("diff", () => {
  it("classifies a same-path hash change as modified — the hash is the only signal", () => {
    // file2 keeps its content but is "touched" (mtime moves): silently
    // unchanged. Only file1, whose hash differs, reports.
    const previous = new Map([
      ["file1.txt", { hash: "h-one", size: 9, mtime: "2024-01-01T00:00" }],
      ["file2.txt", { hash: "h-same", size: 4, mtime: "2024-01-01T00:00" }],
    ]);
    const current = new Map([
      ["file1.txt", { hash: "h-two", size: 9, mtime: "2024-02-02T00:00" }],
      ["file2.txt", { hash: "h-same", size: 4, mtime: "2024-02-02T00:00" }],
    ]);

    assert.deepStrictEqual(plain(diff(previous, current)), {
      ...NONE,
      modified: ["file1.txt"],
    });
  });

  it("classifies swapped contents as two modifications", () => {
    // Both paths persist, so neither can be a move source (only deleted
    // paths can) — two files trading hashes are just two modifications,
    // never an A→B/B→A cross-move of paths that still exist.
    const result = diff(
      entries({ "file.A": "h1", "file.B": "h2" }),
      entries({ "file.A": "h2", "file.B": "h1" }),
    );

    assert.deepStrictEqual(plain(result), {
      ...NONE,
      modified: ["file.A", "file.B"],
    });
  });

  it("classifies a vanished path as deleted, and modifies neither input", () => {
    const previous = entries({ "file1.txt": "h1", "file2.txt": "h2" });
    const current = entries({ "file1.txt": "h1" });

    const result = diff(previous, current);

    assert.deepStrictEqual(plain(result), { ...NONE, deleted: ["file2.txt"] });
    // "Neither input is modified" (the doc contract).
    assert.equal(previous.size, 2);
    assert.equal(current.size, 1);
  });

  it("classifies rotation as modified plus a copy of the old content", () => {
    // Rotation / copy-then-edit: app.log's old content now lives at
    // app.log.1, and app.log itself changed. Only *deleted* paths can be
    // move sources, so this is deliberately NOT reported as a move: from two
    // snapshots, "copied then edited" and "renamed away then recreated" are
    // indistinguishable, and modified-plus-copy is the reading that is
    // verifiably true from the data either way (git's rename detection draws
    // the same line). The duplicate annotation refers to the previous snapshot:
    // app.log.1 holds what app.log *used to* contain.
    const result = diff(
      entries({ "app.log": "h-old" }),
      entries({ "app.log": "h-new", "app.log.1": "h-old" }),
    );

    assert.deepStrictEqual(plain(result), {
      ...NONE,
      added: ["app.log.1 == app.log"],
      modified: ["app.log"],
    });
  });

  it("pairs a renamed file", () => {
    const result = diff(
      entries({ "oldname.txt": "h1" }),
      entries({ "newname.txt": "h1" }),
    );

    assert.deepStrictEqual(plain(result), {
      ...NONE,
      moved: ["oldname.txt → newname.txt"],
    });
  });

  it("pairs a moved file", () => {
    const result = diff(
      entries({ "olddir/file1.txt": "h1" }),
      entries({ "newdir/file1.txt": "h1" }),
    );

    assert.deepStrictEqual(plain(result), {
      ...NONE,
      moved: ["olddir/file1.txt → newdir/file1.txt"],
    });
  });

  it("pairs a move and ignores a persisting file with the same content", () => {
    // file.A persists across both snapshots with the same content as the
    // moved file. The pairing must not mistake file.A as the move source.
    const result = diff(
      entries({ "file.A": "h1", "olddir/file1.txt": "h1" }),
      entries({ "file.A": "h1", "newdir/file1.txt": "h1" }),
    );

    assert.deepStrictEqual(plain(result), {
      ...NONE,
      moved: ["olddir/file1.txt → newdir/file1.txt"],
    });
  });

  it("reports one move and one copy when a deleted holder is claimed", () => {
    const result = diff(
      entries({ "file.A": "h1", "file.B": "h1" }),
      entries({ "file.A": "h1", "file.X": "h1", "file.Y": "h1" }),
    );

    assert.deepStrictEqual(plain(result), {
      ...NONE,
      added: ["file.Y == file.A"],
      moved: ["file.B → file.X"],
    });
  });

  it("annotates copies with every surviving holder of the content", () => {
    const result = diff(
      entries({ "file.A": "h1", "file.B": "h1", "file.C": "h1" }),
      entries({
        "file.A": "h1",
        "file.B": "h1",
        "file.X": "h1",
        "file.Y": "h1",
        "file.Z": "h1",
      }),
    );

    assert.deepStrictEqual(plain(result), {
      ...NONE,
      added: ["file.Y == file.A,file.B", "file.Z == file.A,file.B"],
      moved: ["file.C → file.X"],
    });
  });

  it("classifies pure copies as added with duplicates", () => {
    const result = diff(
      entries({ "file.A": "h1", "file.B": "h1" }),
      entries({
        "file.A": "h1",
        "file.B": "h1",
        "file.X": "h1",
        "file.Y": "h1",
        "file.Z": "h1",
      }),
    );

    assert.deepStrictEqual(plain(result), {
      ...NONE,
      added: [
        "file.X == file.A,file.B",
        "file.Y == file.A,file.B",
        "file.Z == file.A,file.B",
      ],
    });
  });

  it("annotates a copy with the moved-to location when the original moved away", () => {
    // Every previous holder of the content was claimed as a move source, so
    // the annotation points at where the content lives *now* — a copy is
    // never mistaken for brand-new content.
    const result = diff(
      entries({ "file.A": "h1" }),
      entries({ "file.B": "h1", "file.C": "h1" }),
    );

    assert.deepStrictEqual(plain(result), {
      ...NONE,
      added: ["file.C == file.B"],
      moved: ["file.A → file.B"],
    });
  });

  it("pairs simultaneous moves by basename", () => {
    // All four files share one hash (think: empty files) — pairing must still
    // line up x with x and y with y rather than cross-pairing arbitrarily.
    const result = diff(
      entries({ "olddir/x.txt": "h0", "olddir/y.txt": "h0" }),
      entries({ "newdir/x.txt": "h0", "newdir/y.txt": "h0" }),
    );

    assert.deepStrictEqual(plain(result), {
      ...NONE,
      moved: ["olddir/x.txt → newdir/x.txt", "olddir/y.txt → newdir/y.txt"],
    });
  });

  it("prefers a same-directory move source when basenames differ", () => {
    const result = diff(
      entries({ "dir1/old.txt": "h1", "dir2/old.txt": "h1" }),
      entries({ "dir1/new.txt": "h1", "dir2/new.txt": "h1" }),
    );

    assert.deepStrictEqual(plain(result), {
      ...NONE,
      moved: ["dir1/old.txt → dir1/new.txt", "dir2/old.txt → dir2/new.txt"],
    });
  });
});

// ---------------------------------------------------------------------------
// compareSnapshots — the I/O shell over `diff`.

// These exercise `compareSnapshots(snapshotDir, dirs, …)` against real
// snapshot files — the snapshots are written into the temp dir and the temp
// dir is the (single) member root, so a path stored `resolve(dir.path, name)`
// recovers its original relative name against the root.
//
// `compareSnapshots` returns *structured, absolute-path* data (ADR-0043) —
// the string microsyntax (`==`, `→`) and the relative shortening moved to
// the renderer (`renderCompareResult`, tested in render.test.mjs). To keep
// these tests readable, `summarize` projects the structured result back to a
// compact relative form: it's a test-only view of *what was classified how*,
// not the renderer (which decides display, colour, and rename-vs-move wording).
//
// listSnapshotNames() only reports datestamped `.tsv.zst` snapshots, so tests
// that lean on the default since/until resolution use real-looking names —
// lexical order is chronological order.
const OLDEST = "2023-12-31T0101";
const PREVIOUS = "2024-01-01T0101";
const CURRENT = "2024-01-02T0101";

/**
 * Project a structured {@link CompareResult} into compact relative strings for
 * assertions: `path`, `path == dup1,dup2` for a duplicated add, `from → to` for
 * a move, and `path (reason)` for an error — all relative to `base`.
 * @param {CompareResult} result
 * @param {string} base
 */
function summarize(result, base) {
  const r = (/** @type {string} */ p) => relative(base, p);
  return {
    added: result.added.map((a) =>
      a.duplicates.length
        ? `${r(a.path)} == ${a.duplicates.map(r).join(",")}`
        : r(a.path),
    ),
    moved: result.moved.map((m) => `${r(m.path)} → ${r(m.to)}`),
    modified: result.modified.map((m) => r(m.path)),
    deleted: result.deleted.map((d) => r(d.path)),
    errors: result.errors.map((e) => `${r(e.path)} (${e.reason})`),
    skipped: result.skipped.map((s) => `${r(s.path)} (${s.fileType})`),
  };
}

const EMPTY = {
  added: [],
  moved: [],
  modified: [],
  deleted: [],
  errors: [],
  skipped: [],
};

/**
 * A moment for the production snapshot writer, which takes one rather than a
 * bare name (ADR-0072).
 * @param {string} name
 */
const momentOf = (name) => ({
  name,
  instant: "2024-01-02T01:01:00.000Z",
  zone: "Europe/London",
});

describe("compareSnapshots", () => {
  it("shows added file (first snapshot compares against an empty baseline)", async () => {
    await using dir = await mkTmpDir();

    await writeSnapshot(dir.path, CURRENT, [
      new File(["contents1"], "file1.txt"),
    ]);

    const result = await compareSnapshots(dir.path, [dir.path]);

    assert.deepStrictEqual(summarize(result, dir.path), {
      ...EMPTY,
      added: ["file1.txt"],
    });
  });

  it("carries metadata (setName, dirs, since/until) and absolute paths + sizes", async () => {
    // The structured shape (ADR-0043): the renderer's header + self-describing
    // --json. A first snapshot has `since: null` (empty baseline); paths are
    // absolute and each entry carries its size.
    await using dir = await mkTmpDir();

    await writeSnapshot(dir.path, CURRENT, [new File(["12345"], "file1.txt")]);

    const result = await compareSnapshots(dir.path, [dir.path], {
      setName: "photos",
    });

    assert.equal(result.setName, "photos");
    assert.deepStrictEqual(result.dirs, [dir.path]);
    assert.equal(result.since, null); // first snapshot
    assert.equal(result.until, CURRENT);
    assert.deepStrictEqual(result.added, [
      { path: resolve(dir.path, "file1.txt"), size: 5, duplicates: [] },
    ]);
  });

  it("accepts an already-parsed since side instead of re-reading it", async () => {
    await using dir = await mkTmpDir();

    await writeSnapshot(dir.path, CURRENT, [new File(["same"], "kept.txt")]);

    // The baseline is handed in as { name, entries } — the threading seam
    // `snapshot` uses so the previous snapshot isn't decompressed twice. No
    // PREVIOUS file exists on disk, so a re-read would throw: the classification
    // below can only come from the synthetic entries.
    /** @type {SnapshotEntries} */
    const entries = new Map([
      [
        resolve(dir.path, "vanished.txt"),
        { size: 4, mtime: "2024-01-01T01:01:00Z", hash: "0".repeat(64) },
      ],
    ]);
    const result = await compareSnapshots(dir.path, [dir.path], {
      since: { name: PREVIOUS, entries },
      until: CURRENT,
    });

    assert.equal(result.since, PREVIOUS);
    assert.deepStrictEqual(summarize(result, dir.path), {
      ...EMPTY,
      added: ["kept.txt"],
      deleted: ["vanished.txt"],
    });
  });

  it("populates since with the predecessor for a non-first comparison", async () => {
    await using dir = await mkTmpDir();

    await writeSnapshot(dir.path, PREVIOUS, [new File(["a"], "f.txt")]);
    await writeSnapshot(dir.path, CURRENT, [
      new File(["a"], "f.txt"),
      new File(["b"], "g.txt"),
    ]);

    const result = await compareSnapshots(dir.path, [dir.path]);

    assert.equal(result.since, PREVIOUS);
    assert.equal(result.until, CURRENT);
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
    assert.deepStrictEqual(summarize(latestResult, dir.path), {
      ...EMPTY,
      added: ["fileC.txt"],
    });

    // Explicit until: the default baseline is *its* predecessor, not the
    // latest snapshot (the step-2 inversion bug) and not an empty baseline.
    const previousResult = await compareSnapshots(dir.path, [dir.path], {
      until: PREVIOUS,
    });
    assert.deepStrictEqual(summarize(previousResult, dir.path), {
      ...EMPTY,
      added: ["fileB.txt"],
    });
  });

  it("reports a file that failed hashing under errors, not deleted", async () => {
    await using dir = await mkTmpDir();

    await writeSnapshot(dir.path, PREVIOUS, [
      new File(["contents1"], "file1.txt"),
    ]);

    // A file that errors during snapshot (e.g. permission denied) is written
    // as an #ERROR row — exactly what the snapshot pipeline produces for an
    // unreadable file. The path existed in the previous snapshot, so before
    // the errors category it was mis-reported as deleted; it must now surface
    // under `errors` and stay out of `deleted` (the file is still on disk).
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

    assert.deepStrictEqual(summarize(result, dir.path), {
      ...EMPTY,
      errors: ["file1.txt (EACCES: permission denied)"],
    });
  });

  it("lists what the walk skipped, naming the file type that explains it", async () => {
    await using dir = await mkTmpDir();
    const vault = resolve(dir.path, "Personal Vault");

    await writeSnapshot(dir.path, PREVIOUS, []);
    await writeFullSnapshot(dir.path, momentOf(CURRENT), {
      identity: "photos",
      dirs: [dir.path],
      files: [],
      excluded: [],
      skipped: [
        {
          fileType: "SymbolicLink",
          reason: "Unsupported file type",
          path: vault,
        },
      ],
      getProps: async () => assert.fail("no files to hash"),
    });

    const result = await compareSnapshots(dir.path, [dir.path]);

    // The whole point of the category: before this, a `#SKIPPED` row was parsed
    // and then read by nobody, so a symlink the backup left out was invisible in
    // every command. The type travels with it — "SymbolicLink", not just the
    // one-size-fits-all "Unsupported file type" reason.
    assert.deepStrictEqual(summarize(result, dir.path), {
      ...EMPTY,
      skipped: ["Personal Vault (SymbolicLink)"],
    });
  });

  it("reports a file that became a symlink as skipped, not deleted", async () => {
    await using dir = await mkTmpDir();

    // file1.txt was a real file in the baseline and is a symlink now, so it is
    // absent from `entries` and would otherwise read as a deletion — the same
    // trap the errors category exists to avoid. It didn't go away; s3cab just
    // stopped being able to store it.
    await writeSnapshot(dir.path, PREVIOUS, [
      new File(["contents1"], "file1.txt"),
    ]);
    await writeFullSnapshot(dir.path, momentOf(CURRENT), {
      identity: "photos",
      dirs: [dir.path],
      files: [],
      excluded: [],
      skipped: [
        {
          fileType: "SymbolicLink",
          reason: "Unsupported file type",
          path: resolve(dir.path, "file1.txt"),
        },
      ],
      getProps: async () => assert.fail("no files to hash"),
    });

    const result = await compareSnapshots(dir.path, [dir.path]);

    assert.deepStrictEqual(summarize(result, dir.path), {
      ...EMPTY,
      skipped: ["file1.txt (SymbolicLink)"],
    });
  });

  it("reports a brand-new file that failed hashing under errors, not as nothing", async () => {
    await using dir = await mkTmpDir();

    // The errored file is new (absent from the previous snapshot). Before the
    // errors category it was in neither entries map, so it vanished from the
    // report entirely; it must now surface under `errors`.
    await writeSnapshot(dir.path, PREVIOUS, []);
    await withSnapshotFile(dir.path, CURRENT, (stream) =>
      pipeline(
        stringifySnapshot(
          new Map([
            [resolve(dir.path, "new.bin"), new Error("EISDIR: is a directory")],
          ]),
        ),
        stream,
      ),
    );

    const result = await compareSnapshots(dir.path, [dir.path]);

    assert.deepStrictEqual(summarize(result, dir.path), {
      ...EMPTY,
      errors: ["new.bin (EISDIR: is a directory)"],
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

    assert.deepStrictEqual(summarize(result, dir.path), {
      ...EMPTY,
      added: ["file2.txt"],
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

    assert.deepStrictEqual(summarize(result, dir.path), {
      ...EMPTY,
      added: ["file2.txt"],
    });
  });

  it("returns absolute paths, leaving relative shortening to the renderer", async () => {
    await using dir = await mkTmpDir();

    // A directory literally named `..stuff` (a top segment starting with `..`)
    // is not a parent escape. The absolute path is what compareSnapshots
    // returns; the renderer shortens it against the common ancestor (that
    // shortening — including this `..stuff` case — is pinned in render.test.mjs).
    await writeSnapshot(dir.path, PREVIOUS, []);
    await writeSnapshot(dir.path, CURRENT, [
      new File(["x"], "..stuff/file.txt"),
    ]);

    const result = await compareSnapshots(dir.path, [dir.path]);

    assert.deepStrictEqual(
      result.added.map((a) => a.path),
      [resolve(dir.path, "..stuff", "file.txt")],
    );
  });

  it("stores absolute paths spanning multiple member roots", async () => {
    await using dir = await mkTmpDir();

    // Two member roots; a snapshot spanning both stores absolute paths. The
    // report keeps them absolute (the renderer shortens against the common
    // ancestor of the roots — render.test.mjs). (Absolute so the stored keys
    // aren't re-resolved against the temp dir.)
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

    assert.deepStrictEqual(
      result.added.map((a) => a.path).sort(),
      [fileA, fileB].sort(),
    );
    assert.deepStrictEqual(result.moved, []);
  });

  it("errors naming the set, with a copy-pasteable fix, when there are no snapshots", async () => {
    await using dir = await mkTmpDir();

    await assert.rejects(
      () => compareSnapshots(dir.path, [dir.path], { setName: "photos" }),
      /No snapshots to compare yet for set 'photos'[\s\S]*s3cab snapshot photos/,
    );
  });
});

describe("out-of-order warning (ADR-0072 check B)", () => {
  const HASH = "a".repeat(64);

  /**
   * Plant a snapshot by hand, so its header can say something its name doesn't.
   * @param {string} dir
   * @param {string} name
   * @param {string | undefined} instant
   */
  function plant(dir, name, instant) {
    const header = instant
      ? `#SNAPSHOT\tphotos\t${instant}\t${name} Europe/London\n`
      : `#SNAPSHOT\t\t2026-10-25T01:15\tphotos\n`; // the pre-0072 shape
    const row = `${HASH}\t1\t2026-01-01T00:00:00.000Z\t/home/me/a.txt\n`;
    writeFileSync(
      join(dir, `${name}.tsv.zst`),
      zstdCompressSync(Buffer.from(header + row, "utf8")),
    );
  }

  /** @param {() => Promise<unknown>} run */
  async function warningsFrom(run) {
    /** @type {string[]} */
    const said = [];
    const original = console.warn;
    console.warn = (...args) => said.push(args.map(String).join(" "));
    try {
      await run();
    } finally {
      console.warn = original;
    }
    return said.join("\n");
  }

  // The autumn fold: 01:30 BST is 00:30 UTC, and 01:15 GMT — a quarter of an
  // hour *later* — is 01:15 UTC. So the earlier-sorting name is the newer file,
  // which is exactly the case a name-ordered diff reads backwards.
  const EARLIER_NAME = "2026-10-25T0115";
  const LATER_INSTANT = "2026-10-25T01:15:00.000Z";
  const LATER_NAME = "2026-10-25T0130";
  const EARLIER_INSTANT = "2026-10-25T00:30:00.000Z";

  it("says the diff reads backwards when the names disagree with the instants", async () => {
    await using dir = await mkTmpDir();
    plant(dir.path, EARLIER_NAME, LATER_INSTANT);
    plant(dir.path, LATER_NAME, EARLIER_INSTANT);

    const said = await warningsFrom(() =>
      compareSnapshots(dir.path, [dir.path], {
        since: EARLIER_NAME,
        until: LATER_NAME,
      }),
    );
    assert.match(said, /was actually taken after/);
    assert.match(said, /reads backwards/);
    assert.match(said, /Swap --since and --until/);
  });

  it("stays quiet when the instants agree with the names", async () => {
    await using dir = await mkTmpDir();
    plant(dir.path, "2026-06-12T0915", "2026-06-12T08:15:00.000Z");
    plant(dir.path, "2026-06-12T1030", "2026-06-12T09:30:00.000Z");

    const said = await warningsFrom(() =>
      compareSnapshots(dir.path, [dir.path], {
        since: "2026-06-12T0915",
        until: "2026-06-12T1030",
      }),
    );
    assert.doesNotMatch(said, /actually taken after/);
  });

  it("stays quiet rather than guessing when a side predates ADR-0072", async () => {
    await using dir = await mkTmpDir();
    // No instant to compare, so the check cannot be certain — and a check that
    // guessed from the names would reintroduce the very ambiguity it exists to
    // see through.
    plant(dir.path, "2026-10-25T0115", undefined);
    plant(dir.path, LATER_NAME, EARLIER_INSTANT);

    const said = await warningsFrom(() =>
      compareSnapshots(dir.path, [dir.path], {
        since: "2026-10-25T0115",
        until: LATER_NAME,
      }),
    );
    assert.doesNotMatch(said, /actually taken after/);
  });
});
