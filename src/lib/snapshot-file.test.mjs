import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { mkdtempDisposable } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { describe, it } from "node:test";
import {
  errorLine,
  listSnapshotNames,
  parseSnapshotStream,
  snapshotHeader,
} from "./snapshot-file.mjs";

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
      "#SNAPSHOT\t\t2026-06-12T09:15\tallen@allen-pc:photos",
      "#DIR\t\t\tC:\\Users\\me\\Photos",
      "#DIR\t\t\tD:\\Pics",
      `${hashA}\t12\t2026-06-01T12:00:00.000Z\tC:\\Users\\me\\Photos\\beach.jpg`,
      `${hashB}\t34\t2026-06-02T08:30:00.000Z\tD:\\Pics\\ski.jpg`,
    ].join("\n");

    const { entries, dirs, identity } = await parse(text);

    assert.equal(identity, "allen@allen-pc:photos");
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

  it("round-trips the headers snapshotHeader writes", async () => {
    // Pins both sides of the header grammar in one place: what snapshotHeader
    // emits, parseSnapshotStream must read back unchanged.
    const dirs = ["C:\\Users\\me\\Photos", "/home/me/Docs"];
    const {
      entries,
      dirs: parsedDirs,
      identity,
    } = await parse(
      snapshotHeader({
        datetime: "2026-06-18T22:04",
        identity: "allen@allen-pc:photos",
        dirs,
      }),
    );
    assert.equal(identity, "allen@allen-pc:photos");
    assert.deepEqual(parsedDirs, dirs);
    assert.equal(entries.size, 0);
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
    // Pins the writer/reader pair: what errorLine emits, parseSnapshotStream
    // reads back into `errors` — kept out of `entries` so compare reports the
    // path rather than mistaking it for deleted.
    const text = [
      "#DIR\t\t\t/home/me/Docs",
      errorLine(
        "EACCES: permission denied",
        "/home/me/Docs/locked.bin",
      ).trimEnd(),
      `${hashA}\t5\t2026-06-01T12:00:00.000Z\t/home/me/Docs/ok.txt`,
    ].join("\n");
    const { entries, errors } = await parse(text);
    assert.deepEqual([...entries.keys()], ["/home/me/Docs/ok.txt"]);
    assert.deepEqual(
      [...errors],
      [["/home/me/Docs/locked.bin", "EACCES: permission denied"]],
    );
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
