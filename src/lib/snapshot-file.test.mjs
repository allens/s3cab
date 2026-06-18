import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { describe, it } from "node:test";
import { parseSnapshotStream } from "./snapshot-file.mjs";

// `parseSnapshotStream` is the pure line-parser behind every snapshot read. It
// turns a decompressed TSV stream into `{ entries, dirs, identity }` — the file
// lookup plus the `#SNAPSHOT`/`#DIR` headers that keep a snapshot self-describing
// (and that `restore --output` re-roots by). Build streams from strings so these
// run without S3 or a temp file.
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

  it("yields empty headers for a snapshot without #SNAPSHOT/#DIR lines", async () => {
    const text = `${hashA}\t12\t2026-06-01T12:00:00.000Z\t/home/me/a.txt`;
    const { entries, dirs, identity } = await parse(text);
    assert.equal(entries.size, 1);
    assert.deepEqual(dirs, []);
    assert.equal(identity, undefined);
  });

  it("skips ordinary comment lines (e.g. a hashing error) without treating them as headers", async () => {
    const text = [
      "#DIR\t\t\t/home/me/Docs",
      "#permission denied\t\t\t/home/me/Docs/locked.bin",
      `${hashA}\t5\t2026-06-01T12:00:00.000Z\t/home/me/Docs/ok.txt`,
    ].join("\n");
    const { entries, dirs } = await parse(text);
    assert.deepEqual(dirs, ["/home/me/Docs"]);
    assert.deepEqual([...entries.keys()], ["/home/me/Docs/ok.txt"]);
  });
});
