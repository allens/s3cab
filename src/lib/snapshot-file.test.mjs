import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { mkdtempDisposable } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Readable } from "node:stream";
import { describe, it } from "node:test";
import {
  listSnapshotNames,
  parseSnapshotStream,
  readSnapshot,
  writeSnapshot,
} from "./snapshot-file.mjs";

/** @import { Props } from "./snapshot-file.mjs" */

// `parseSnapshotStream` is the pure line-parser behind every snapshot read. It
// turns a decompressed TSV stream into `{ entries, errors, dirs, identity }` —
// the file lookup, the paths that failed hashing, plus the `#SNAPSHOT`/`#DIR`
// headers that keep a snapshot self-describing (and that `restore --output`
// re-roots by). Build streams from strings so these run without S3 or a temp
// file.
// Wrap the text in an array so it streams as a single chunk; a bare string is
// an iterable of characters, which Readable.from would emit one char at a time.
const parse = (/** @type {string} */ text) =>
  parseSnapshotStream(Readable.from([text]));

const hashA = "a".repeat(64);
const hashB = "b".repeat(64);

describe("parseSnapshotStream", () => {
  it("parses entries and the #SNAPSHOT/#DIR headers", async () => {
    const text = [
      "#SNAPSHOT\t\t2026-06-12T09:15\tphotos",
      "#DIR\t\t\tC:\\Users\\me\\Photos",
      "#DIR\t\t\tD:\\Pics",
      `${hashA}\t12\t2026-06-01T12:00:00.000Z\tC:\\Users\\me\\Photos\\beach.jpg`,
      `${hashB}\t34\t2026-06-02T08:30:00.000Z\tD:\\Pics\\ski.jpg`,
    ].join("\n");

    const { entries, dirs, identity } = await parse(text);

    assert.equal(identity, "photos");
    assert.deepEqual(dirs, ["C:\\Users\\me\\Photos", "D:\\Pics"]);
    assert.deepEqual(
      [...entries.keys()],
      ["C:\\Users\\me\\Photos\\beach.jpg", "D:\\Pics\\ski.jpg"],
    );
    assert.deepEqual(entries.get("D:\\Pics\\ski.jpg"), {
      hash: hashB,
      size: 34,
      mtime: "2026-06-02T08:30:00.000Z",
    });
  });

  it("yields empty headers for a snapshot without #SNAPSHOT/#DIR lines", async () => {
    const text = `${hashA}\t12\t2026-06-01T12:00:00.000Z\t/home/me/a.txt`;
    const { entries, dirs, identity } = await parse(text);
    assert.equal(entries.size, 1);
    assert.deepEqual(dirs, []);
    assert.equal(identity, undefined);
  });

  it("skips unknown comment lines without treating them as headers", async () => {
    const text = [
      "#DIR\t\t\t/home/me/Docs",
      "#some hand-written note\t\t\t/home/me/Docs/whatever",
      `${hashA}\t5\t2026-06-01T12:00:00.000Z\t/home/me/Docs/ok.txt`,
    ].join("\n");
    const { entries, dirs, errors } = await parse(text);
    assert.deepEqual(dirs, ["/home/me/Docs"]);
    assert.deepEqual([...entries.keys()], ["/home/me/Docs/ok.txt"]);
    assert.equal(errors.size, 0);
  });

  it("surfaces #ERROR rows into errors (with reason), not entries", async () => {
    // An #ERROR row carries its reason in col3 and is read back into `errors`,
    // kept out of `entries` so compare reports the path rather than mistaking
    // it for deleted. (writeSnapshot's round-trip test covers the writer side.)
    const text = [
      "#DIR\t\t\t/home/me/Docs",
      "#ERROR\t\tEACCES: permission denied\t/home/me/Docs/locked.bin",
      `${hashA}\t5\t2026-06-01T12:00:00.000Z\t/home/me/Docs/ok.txt`,
    ].join("\n");
    const { entries, errors } = await parse(text);
    assert.deepEqual([...entries.keys()], ["/home/me/Docs/ok.txt"]);
    assert.deepEqual(
      [...errors],
      [["/home/me/Docs/locked.bin", "EACCES: permission denied"]],
    );
  });

  it("preserves paths with leading/trailing whitespace verbatim", async () => {
    // Only the hash/size/mtime columns are trimmed; the path column must be
    // taken verbatim so a file whose name contains leading/trailing spaces
    // round-trips correctly (hand-editing is the no-lock-in story).
    const path = " /home/me/ a file with spaces .txt ";
    const text = `${hashA}\t5\t2026-06-01T12:00:00.000Z\t${path}`;
    const { entries } = await parse(text);
    assert.ok(
      entries.has(path),
      "path with surrounding spaces must be kept verbatim",
    );
    assert.ok(!entries.has(path.trim()), "trimmed form must not be present");
  });

  it("skips blank lines without throwing", async () => {
    // A hand-edited snapshot file may have blank lines (e.g. trailing newline).
    // The parser must skip them gracefully rather than asserting.
    const text = [
      "",
      `${hashA}\t5\t2026-06-01T12:00:00.000Z\t/home/me/a.txt`,
      "",
      `${hashB}\t7\t2026-06-02T08:00:00.000Z\t/home/me/b.txt`,
      "",
    ].join("\n");
    const { entries } = await parse(text);
    assert.equal(entries.size, 2);
  });
});

const mkTmpDir = async () => mkdtempDisposable(join("test", ".tmp"));

// listSnapshotNames is the storage core behind the `list` command — a temp dir
// stands in for a set's `~/.s3cab/sets/<set>/snapshots/`. The set resolution
// `list` wraps it in is covered in e2e.

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

// writeSnapshot is the single production seam for "files → snapshot file". It is
// driven here with an injected getProps (so no disk hashing and no `prop` — the
// writer's own logic is what's under test): the #SNAPSHOT/#DIR header, the
// #EXCLUDED rows, the #ERROR-on-hashing-failure path, and the round-trip back
// through readSnapshot are all asserted at the writer's interface — the write
// path that previously had no single seam to test through.
describe("writeSnapshot", () => {
  /** @type {(p: string) => Promise<Props>} */
  const props = async () => ({
    size: 3,
    mtime: "2026-06-23T10:00:00.000Z",
    hash: hashA,
  });

  it("writes header + entries + #EXCLUDED + #ERROR and round-trips via readSnapshot", async () => {
    await using dir = await mkTmpDir();
    const a = resolve(dir.path, "a.txt");
    const b = resolve(dir.path, "b.txt");
    const bad = resolve(dir.path, "bad.bin");
    const skipped = resolve(dir.path, "scratch.tmp");

    const path = await writeSnapshot(dir.path, "2026-06-23T1000", {
      identity: "photos",
      dirs: [dir.path],
      datetime: "2026-06-23T10:00",
      files: [a, b, bad],
      excluded: [{ fileType: "File", reason: "*.tmp", path: skipped }],
      getProps: async (p) => {
        // A file the walk can't hash becomes an #ERROR row, not an entry.
        if (p === bad) {
          throw new Error("EACCES: permission denied");
        }
        return props(p);
      },
    });

    assert.match(path, /2026-06-23T1000\.tsv\.zst$/);

    const { entries, errors, dirs, identity } = await readSnapshot(
      dir.path,
      "2026-06-23T1000",
    );

    // The #SNAPSHOT/#DIR header round-trips.
    assert.equal(identity, "photos");
    assert.deepEqual(dirs, [dir.path]);

    // Hashed files are entries; the #EXCLUDED row is skipped on read; the
    // unhashable file is surfaced under errors (not an entry, not "deleted").
    assert.deepEqual([...entries.keys()].sort(), [a, b].sort());
    assert.equal(entries.get(a)?.hash, hashA);
    assert.ok(!entries.has(bad), "errored file must not be an entry");
    assert.ok(!entries.has(skipped), "#EXCLUDED row must not be an entry");
    assert.deepEqual([...errors], [[bad, "EACCES: permission denied"]]);
  });

  it("writes one #DIR line per member directory (header round-trips)", async () => {
    await using dir = await mkTmpDir();
    // Mixed separators across roots, no file entries: pins the writer/reader
    // pair for the #SNAPSHOT identity and the per-directory #DIR lines.
    const dirs = ["C:\\Users\\me\\Photos", "/home/me/Docs"];

    await writeSnapshot(dir.path, "2026-06-23T1000", {
      identity: "photos",
      dirs,
      datetime: "2026-06-23T10:00",
      files: [],
      excluded: [],
      getProps: props,
    });

    const snap = await readSnapshot(dir.path, "2026-06-23T1000");
    assert.equal(snap.identity, "photos");
    assert.deepEqual(snap.dirs, dirs);
    assert.equal(snap.entries.size, 0);
  });

  it("writes #SKIPPED rows for by-design unsupported entries and round-trips them", async () => {
    await using dir = await mkTmpDir();
    const regular = resolve(dir.path, "regular.txt");
    const link = resolve(dir.path, "link.txt");

    const path = await writeSnapshot(dir.path, "2026-06-23T1000", {
      identity: "photos",
      dirs: [dir.path],
      datetime: "2026-06-23T10:00",
      files: [regular],
      excluded: [],
      skipped: [
        {
          fileType: "SymbolicLink",
          reason: "Unsupported file type",
          path: link,
        },
      ],
      getProps: async () => ({
        size: 3,
        mtime: "2026-06-23T10:00:00.000Z",
        hash: hashA,
      }),
    });

    assert.match(path, /2026-06-23T1000\.tsv\.zst$/);

    const snap = await readSnapshot(dir.path, "2026-06-23T1000");

    // The skipped entry must not appear as an entry or an error.
    assert.ok(!snap.entries.has(link), "#SKIPPED row must not be an entry");
    assert.ok(!snap.errors.has(link), "#SKIPPED row must not be an error");
    // It must be surfaced in skipped, mapped to its reason.
    assert.deepEqual([...snap.skipped], [[link, "Unsupported file type"]]);
  });

  it("refuses an existing same-name snapshot unless overwrite is set", async () => {
    await using dir = await mkTmpDir();
    /** @type {Parameters<typeof writeSnapshot>[2]} */
    const args = {
      identity: "photos",
      dirs: [dir.path],
      datetime: "2026-06-23T10:00",
      files: [],
      excluded: [],
      getProps: props,
    };

    await writeSnapshot(dir.path, "2026-06-23T1000", args);
    await assert.rejects(
      writeSnapshot(dir.path, "2026-06-23T1000", args),
      /same minute/,
    );
    // The debug escape hatch: overwrite replaces it without erroring.
    await writeSnapshot(dir.path, "2026-06-23T1000", {
      ...args,
      overwrite: true,
    });
  });
});
