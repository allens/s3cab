import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtempDisposable } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { describe, it } from "node:test";
import { setTimeout } from "node:timers/promises";
import { constants, gzipSync, gunzipSync } from "node:zlib";
import { InterruptedError } from "./error.mjs";
import {
  listSnapshotNames,
  normalizeSnapshotName,
  parseCompressedSnapshotStream,
  parseSnapshotStream,
  readParkedLookup,
  readSnapshot,
  recoverWorkFile,
  snapshotFileName,
  snapshotMoment,
  snapshotNames,
  withSnapshotFile,
  writeSnapshot,
} from "./snapshot-file.mjs";

/** @import { Props, SnapshotSet } from "./snapshot-file.mjs" */

// `parseSnapshotStream` is the pure line-parser behind every snapshot read. It
// turns a decompressed TSV stream into what the code reads of a snapshot
// (ADR-0098), refusing what ADR-0101 calls invalid. Build streams from strings
// so these run without S3 or a temp file. The fixtures leave the columns
// unpadded, which a reader takes as readily as the writer's padding.
const parse = (/** @type {string} */ text) =>
  parseSnapshotStream(Readable.from([Buffer.from(text)]));

const hashA = "a".repeat(64);
const hashB = "b".repeat(64);

const HEADING =
  "@S3CAB\tFORMAT\tsize\ttime\thttps://s3cab.plantegral.com/guide/format";
const DIR = "@SET\tDIR\t\t\t/home/me/";
const START = "@SNAPSHOT\tSTART\t\t2026-06-12T08:15:32.123Z\tEurope/London";
/** The closing line with its LF, which is part of it (ADR-0106). */
const TERMINATOR = ".\n";

/**
 * A `-` row, a file's.
 * @param {string} hash
 * @param {number | string} size
 * @param {string} path
 * @param {string} [mtime]
 */
const fileRow = (hash, size, path, mtime = "2026-06-01T12:00:00.000Z") =>
  `-\t${hash}\t${size}\t${mtime}\t${path}`;

/** The `@SET DIR` row for a real directory, such as a test's temp dir. */
const dirRow = (/** @type {string} */ dir) =>
  `@SET\tDIR\t\t\t${resolve(dir)}${sep}`;

/** A snapshot whose files are all under `/home/me/`, around `rows`. */
const snapshotOf = (/** @type {string[]} */ ...rows) =>
  [HEADING, DIR, START, ...rows, TERMINATOR].join("\n");

describe("parseSnapshotStream", () => {
  it("parses - rows, @SET DIR and @SNAPSHOT START's instant", async () => {
    const text = [
      HEADING,
      "@SET\tDIR\t\t\tC:\\Users\\me\\Photos\\",
      "@SET\tDIR\t\t\tD:\\Pics\\",
      START,
      fileRow(hashA, 12, "C:\\Users\\me\\Photos\\beach.jpg"),
      fileRow(hashB, 34, "D:\\Pics\\ski.jpg"),
      TERMINATOR,
    ].join("\n");

    const { entries, dirs, instant, refused } = await parse(text);

    assert.equal(instant, "2026-06-12T08:15:32.123Z");
    assert.deepEqual(dirs, ["C:\\Users\\me\\Photos\\", "D:\\Pics\\"]);
    assert.deepEqual(
      [...entries.keys()],
      ["C:\\Users\\me\\Photos\\beach.jpg", "D:\\Pics\\ski.jpg"],
    );
    assert.deepEqual(entries.get("D:\\Pics\\ski.jpg"), {
      hash: hashB,
      size: 34,
      mtime: "2026-06-01T12:00:00.000Z",
    });
    assert.equal(refused.size, 0);
  });

  it("skips the @ and # rows only people read, and @ and # types it doesn't know", async () => {
    // An unknown `@` or `#` row is information a newer s3cab added, so skipping
    // it is what keeps a new property additive (ADR-0103) — and a `#` row
    // repeating a file row's path changes nothing a reader restores (ADR-0101).
    const { entries, errors } = await parse(
      snapshotOf(
        "@S3CAB\tVERSION\t\t\t0.14.0",
        "@SET\tNAME\t\t\tphotos",
        "@SET\tEXCLUDE\t\t\t*.tmp",
        "@SNAPSHOT\tCOLOUR\t\t\tblue",
        "@FUTURE\tTHING\t\t\tvalue",
        "#excluded\t*.tmp\t\t\t/home/me/Docs/scratch.tmp",
        "#future\tsomething\t\t\t/home/me/Docs/ok.txt",
        fileRow(hashA, 5, "/home/me/Docs/ok.txt"),
        "@SNAPSHOT\tFILES\t\t\t99",
      ),
    );
    assert.deepEqual([...entries.keys()], ["/home/me/Docs/ok.txt"]);
    assert.equal(errors.size, 0);
  });

  it("surfaces #error rows into errors (with the message), not entries", async () => {
    // Kept out of `entries` so compare reports the path rather than mistaking
    // it for deleted. (writeSnapshot's round-trip test covers the writer side.)
    const { entries, errors } = await parse(
      snapshotOf(
        "#error\tEACCES: permission denied\t\t\t/home/me/Docs/locked.bin",
        fileRow(hashA, 5, "/home/me/Docs/ok.txt"),
      ),
    );
    assert.deepEqual([...entries.keys()], ["/home/me/Docs/ok.txt"]);
    assert.deepEqual(
      [...errors],
      [["/home/me/Docs/locked.bin", "EACCES: permission denied"]],
    );
  });

  it("preserves paths with leading/trailing whitespace verbatim", async () => {
    // Only the padded columns are trimmed; the path column must be taken
    // verbatim so a file whose name begins or ends with a space round-trips
    // correctly (hand-editing is the no-lock-in story).
    const path = "/home/me/ a file with spaces .txt ";
    const { entries } = await parse(snapshotOf(fileRow(hashA, 5, path)));
    assert.ok(entries.has(path), "the path must be kept verbatim");
    assert.ok(!entries.has(path.trim()), "trimmed form must not be present");
  });

  it("skips blank lines after the heading", async () => {
    const { entries } = await parse(
      [
        HEADING,
        DIR,
        "",
        fileRow(hashA, 5, "/home/me/a.txt"),
        "",
        fileRow(hashB, 7, "/home/me/b.txt"),
        TERMINATOR,
        "",
      ].join("\n"),
    );
    assert.equal(entries.size, 2);
  });

  describe("refuses the whole file (ADR-0101)", () => {
    /**
     * @param {string | Buffer} text
     * @param {RegExp} message
     */
    const refuses = (text, message) =>
      assert.rejects(parseSnapshotStream(Readable.from([Buffer.from(text)])), {
        name: "AssertionError",
        message,
      });

    it("when it doesn't open with the heading row", async () => {
      await refuses(
        [DIR, fileRow(hashA, 12, "/home/me/a.txt"), TERMINATOR].join("\n"),
        /first line isn't the @S3CAB FORMAT heading row/,
      );
      // Not even after a blank line: the heading is the first line.
      await refuses(
        `\n${snapshotOf(fileRow(hashA, 12, "/home/me/a.txt"))}`,
        /heading row/,
      );
    });

    it("when its line endings are CRLF", async () => {
      // The heading's URL then ends in a CR, so the file isn't what s3cab writes.
      await refuses(
        snapshotOf(fileRow(hashA, 12, "/home/me/a.txt")).replaceAll(
          "\n",
          "\r\n",
        ),
        /heading row/,
      );
    });

    it("when it isn't UTF-8", async () => {
      const bytes = Buffer.concat([
        Buffer.from(snapshotOf(fileRow(hashA, 12, "/home/me/a.txt"))),
        Buffer.from([0xff, 0xfe]),
      ]);
      await refuses(bytes, /isn't UTF-8/);
    });

    it("when it ends without the closing ., as truncated", async () => {
      // ADR-0082: this parser takes an already-decompressed stream, so it has no
      // gzip trailer to lean on — for an uncompressed `.tsv` there is none, and
      // the `.` is the only thing standing between a destroyed manifest and a
      // clean parse. An AssertionError on purpose — isCorruptSnapshotError
      // classifies it as snapshot damage, so verify records the finding instead
      // of vouching for the wreck.
      await refuses(
        [HEADING, DIR, START, fileRow(hashA, 12, "/home/me/a.txt")].join("\n"),
        /Truncated snapshot/,
      );
    });

    it("when rows follow the closing ., which then no longer proves it whole", async () => {
      await refuses(
        `${snapshotOf(fileRow(hashA, 12, "/home/me/a.txt"))}\n${fileRow(hashB, 7, "/home/me/b.txt")}`,
        /rows follow the closing "\." line/,
      );
    });

    it("when the closing . has no LF, as a write cut just after it", async () => {
      await refuses(
        snapshotOf(fileRow(hashA, 12, "/home/me/a.txt")).slice(0, -1),
        /Truncated snapshot/,
      );
    });

    it("when the closing line is more than ., saying so rather than blaming a newer s3cab", async () => {
      await refuses(
        snapshotOf(fileRow(hashA, 12, "/home/me/a.txt")).replace(
          /\.\n$/,
          ". \n",
        ),
        /its closing line isn't exactly "\."/,
      );
    });

    it("when it holds a type starting with neither @ nor #, which may be content a restore would miss", async () => {
      await refuses(
        snapshotOf("xattr\tuser.tag\t\t\t/home/me/a.txt"),
        /Unknown row type 'xattr'/,
      );
    });

    it("when the heading row's column 2 isn't FORMAT", async () => {
      await refuses(
        snapshotOf(fileRow(hashA, 12, "/home/me/a.txt")).replace(
          "\tFORMAT\t",
          "\t\t",
        ),
        /heading row/,
      );
    });
  });

  describe("refuses one path and reads the rest (ADR-0101)", () => {
    for (const [what, row, path, reason] of [
      [
        "a hash that isn't 64 lowercase hex digits",
        fileRow("A".repeat(64), 12, "/home/me/x"),
        "/home/me/x",
        /hash/,
      ],
      [
        "a 63-digit hash",
        fileRow("a".repeat(63), 12, "/home/me/x"),
        "/home/me/x",
        /hash/,
      ],
      [
        "a size that isn't a whole number",
        fileRow(hashA, "12.5", "/home/me/x"),
        "/home/me/x",
        /size/,
      ],
      [
        "a time that isn't the 24-character instant",
        fileRow(hashA, 12, "/home/me/x", "2026-06-01T12:00:00Z"),
        "/home/me/x",
        /time/,
      ],
      [
        "an empty field",
        `-\t${hashA}\t\t2026-06-01T12:00:00.000Z\t/home/me/x`,
        "/home/me/x",
        /size/,
      ],
      ["no path at all", fileRow(hashA, 12, ""), "", /no path/],
      [
        "a path that isn't absolute",
        fileRow(hashA, 12, "home/me/x"),
        "home/me/x",
        /isn't absolute/,
      ],
      [
        "a .. segment",
        fileRow(hashA, 12, "/home/me/../../etc/passwd"),
        "/home/me/../../etc/passwd",
        /\.\. segment/,
      ],
      [
        "a . segment, in a Windows-shaped path",
        fileRow(hashA, 12, "C:\\Users\\.\\x"),
        "C:\\Users\\.\\x",
        /\.\. segment/,
      ],
      [
        "a carriage return in the path",
        fileRow(hashA, 12, "/home/me/x\r"),
        "/home/me/x\r",
        /carriage return/,
      ],
      [
        "a tab in the path, which must not cut it short at the tab",
        fileRow(hashA, 12, "/home/me/x\ty"),
        "/home/me/x\ty",
        /holds a tab/,
      ],
      [
        "a path under no @SET DIR",
        fileRow(hashA, 12, "/srv/other/x"),
        "/srv/other/x",
        /none of the snapshot's @SET DIR rows/,
      ],
    ]) {
      it(`for ${what}`, async () => {
        const { entries, errors, refused } = await parse(
          snapshotOf(fileRow(hashB, 7, "/home/me/ok.txt"), String(row)),
        );
        assert.deepEqual([...entries.keys()], ["/home/me/ok.txt"]);
        assert.deepEqual([...refused.keys()], [path]);
        assert.match(
          String(refused.get(String(path))),
          /** @type {RegExp} */ (reason),
        );
        // Elsewhere a refused path is one with no row, read like an `#error`.
        assert.equal(errors.get(String(path)), refused.get(String(path)));
      });
    }

    it("for a path two rows name, refusing both so no reader guesses", async () => {
      // Not last-wins: a first-wins reader and a last-wins one would restore
      // different bytes from the same file.
      const { entries, refused } = await parse(
        snapshotOf(
          fileRow(hashA, 12, "/home/me/a.txt"),
          fileRow(hashA, 12, "/home/me/twice.txt"),
          fileRow(hashB, 34, "/home/me/twice.txt"),
        ),
      );
      assert.deepEqual([...entries.keys()], ["/home/me/a.txt"]);
      assert.deepEqual(
        [...refused],
        [["/home/me/twice.txt", "it appears in two rows of the snapshot"]],
      );
    });
  });

  it("reads a work file's whole rows, dropping the one it died mid-write", async () => {
    // ADR-0092: a hard-killed run's file has no `.` — it never reached one —
    // and its last row is a prefix, cut between the compressor's last flushed
    // block and the end of the line. Both are the *expected* state here, where
    // for a snapshot they are damage. The torn row is the shape measured on a
    // real work file: hash and size intact, the mtime cut in half, no path.
    const text = [
      HEADING,
      DIR,
      START,
      fileRow(hashA, 12, "/home/me/a.txt"),
      fileRow(hashA, 34, "/home/me/b.txt"),
      `-\t${hashA}\t2806546623\t2026-07-26T17:21:28`,
    ].join("\n");

    const { entries, instant, refused } = await parseSnapshotStream(
      Readable.from([Buffer.from(text)]),
      { tolerant: true },
    );

    assert.deepEqual([...entries.keys()], ["/home/me/a.txt", "/home/me/b.txt"]);
    assert.equal(instant, "2026-06-12T08:15:32.123Z");
    assert.equal(refused.size, 0);
  });

  it("drops a last row torn inside the path, which looks whole but isn't", async () => {
    // The dangerous tear, and the reason the last line is taken on its LF's word
    // rather than on its own looks: cut inside the path and all five columns
    // are populated, so the row parses — filing a real hash under a *prefix* of
    // the real path. A live file matching that prefix whose size and mtime
    // agree with the row would then be stored under another file's content
    // hash.
    const text = [
      HEADING,
      DIR,
      fileRow(hashA, 12, "/home/me/a.txt"),
      fileRow(hashB, 34, "/home/me/photo"),
    ].join("\n");

    const { entries } = await parseSnapshotStream(
      Readable.from([Buffer.from(text)]),
      { tolerant: true },
    );

    assert.deepEqual([...entries.keys()], ["/home/me/a.txt"]);
  });

  it("keeps a work file's last row once its LF is written", async () => {
    // A gracefully parked file stops after a whole row and its LF, with no `.`.
    const text = [
      HEADING,
      DIR,
      fileRow(hashA, 12, "/home/me/a.txt"),
      fileRow(hashB, 34, "/home/me/b.txt"),
      "",
    ].join("\n");

    const { entries } = await parseSnapshotStream(
      Readable.from([Buffer.from(text)]),
      { tolerant: true },
    );

    assert.deepEqual([...entries.keys()], ["/home/me/a.txt", "/home/me/b.txt"]);
  });
});

// parseCompressedSnapshotStream fronts the parser with gunzip as the terminal
// sink of a pipeline. The shape exists for error propagation: the `.pipe` it
// replaced forwarded no source `error`, so a dropped stream stalled the parser
// forever — which is why these tests carry timeouts (the failure mode under
// guard is a hang, not a throw). The teardown half of the story — completing a
// read without aborting the live S3 request (#171) — needs a real body and is
// covered in test/integration/remote.test.mjs.
describe("parseCompressedSnapshotStream", () => {
  const text = snapshotOf(fileRow(hashA, 12, "/home/me/a.txt"));

  it(
    "parses a compressed stream arriving in arbitrary chunks",
    { timeout: 5000 },
    async () => {
      const compressed = gzipSync(text);
      const chunks = [];
      for (let i = 0; i < compressed.length; i += 7) {
        chunks.push(compressed.subarray(i, i + 7));
      }
      const { entries, instant } = await parseCompressedSnapshotStream(
        Readable.from(chunks),
      );
      assert.equal(instant, "2026-06-12T08:15:32.123Z");
      assert.deepEqual([...entries.keys()], ["/home/me/a.txt"]);
    },
  );

  it(
    "rejects cut-short bytes as a truncated snapshot, whichever layer notices",
    { timeout: 5000 },
    async () => {
      // gunzip rejects the cut stream itself (`Z_BUF_ERROR`) where the parser
      // would otherwise have missed the closing `.` — measured on 26.11 at every cut
      // point of a small snapshot, the empty stream included. Either way it must surface as the same
      // AssertionError, the one isCorruptSnapshotError files as damage
      // (ADR-0082 amendments 2 and 3).
      const compressed = gzipSync(text);
      for (const length of [0, Math.floor(compressed.length / 2)]) {
        await assert.rejects(
          parseCompressedSnapshotStream(
            Readable.from([compressed.subarray(0, length)]),
          ),
          { name: "AssertionError", message: /^Truncated snapshot/ },
          `a cut at byte ${length} of ${compressed.length}`,
        );
      }
    },
  );

  it(
    "rejects when the source errors mid-stream instead of stalling",
    { timeout: 5000 },
    async () => {
      // Half the compressed bytes arrive, then the source dies — a dropped
      // connection or a failed disk read, surfaced as the source's `error`.
      const compressed = gzipSync(text);
      const source = new Readable({ read() {} });
      source.push(compressed.subarray(0, Math.floor(compressed.length / 2)));
      const parsed = parseCompressedSnapshotStream(source);
      source.destroy(new Error("connection dropped"));
      await assert.rejects(parsed, /connection dropped/);
    },
  );

  it(
    "rejects when the source closes without ending (silent drop)",
    { timeout: 5000 },
    async () => {
      // A connection torn down without an error event: the source closes before
      // ever ending. `pipeline` turns that into ERR_STREAM_PREMATURE_CLOSE.
      const source = new Readable({ read() {} });
      source.push(gzipSync(text).subarray(0, 8));
      const parsed = parseCompressedSnapshotStream(source);
      source.destroy();
      await assert.rejects(parsed, { code: "ERR_STREAM_PREMATURE_CLOSE" });
    },
  );
});

const mkTmpDir = async () => mkdtempDisposable(join("test", ".tmp"));

/**
 * A snapshot moment with a fixed instant and zone, so a written header is
 * deterministic. Production mints these from one clock read (`snapshotMoment`).
 * @param {string} name
 */
const momentOf = (name) => ({
  name,
  instant: "2026-06-23T09:00:00.000Z",
  zone: "Europe/London",
});

/**
 * The set a written snapshot records in its `@SET` rows — absolute, as
 * `setup` canonicalizes them, or no path would be under one.
 * @param {string[]} dirs
 * @returns {SnapshotSet}
 */
const setOf = (dirs) => ({
  name: "photos",
  bucket: "my-backups",
  dirs: dirs.map((dir) => resolve(dir)),
  patterns: [],
});

/** A walk that found nothing but files. */
const nothingElse = { excluded: [], errors: [] };

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
      "2025-01-14T0830.tsv.gz",
      "2025-01-15T1030.tsv.gz",
      "2025-01-13T1200.tsv.gz",
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
      "2025-01-15T1030.tsv.gz",
      "not-a-snapshot.txt",
      ".snapshot.tsv.gz",
    ]);
    assert.deepEqual(listSnapshotNames(dir.path), ["2025-01-15T1030"]);
  });

  // `.at(0)` is how every caller wanting just the newest one spells it, so the
  // two cases that used to cover the `latest` option are asserted through it.
  it("puts the newest snapshot name first", async () => {
    await using dir = await mkTmpDir();
    makeSnapshots(dir.path, [
      "2025-01-14T0830.tsv.gz",
      "2025-01-15T1030.tsv.gz",
    ]);
    assert.equal(listSnapshotNames(dir.path).at(0), "2025-01-15T1030");
  });

  it("has no first name when no snapshots exist", async () => {
    await using dir = await mkTmpDir();
    assert.equal(listSnapshotNames(dir.path).at(0), undefined);
  });
});

describe("snapshotMoment's minted name", () => {
  it("is a minute-precision name the snapshot lister recognises", () => {
    const { name } = snapshotMoment();
    assert.match(name, /^\d{4}-\d{2}-\d{2}T\d{4}$/);
    // The minted name round-trips through the recognizer that list (local
    // files) and the remote lister both filter by.
    assert.deepEqual(snapshotNames([`${name}.tsv.gz`]), [name]);
  });
});

describe("snapshotFileName", () => {
  it("appends the stored extension — the format spec's promise, spelled out", () => {
    // The literal is written independently on purpose: `.tsv.gz` is a
    // user-facing contract (guide/format.md), so changing it must fail here.
    assert.equal(snapshotFileName("2026-06-12T0915"), "2026-06-12T0915.tsv.gz");
  });
});

describe("normalizeSnapshotName", () => {
  it("strips the .tsv/.tsv.gz extension and leaves bare names alone", () => {
    const name = "2026-06-12T0915";
    assert.equal(normalizeSnapshotName(`${name}.tsv.gz`), name);
    assert.equal(normalizeSnapshotName(`${name}.tsv`), name);
    assert.equal(normalizeSnapshotName(name), name);
    assert.equal(normalizeSnapshotName(undefined), undefined);
  });
});

// readSnapshot resolves a name to the one file a snapshot can be — its
// `<name>.tsv.gz`. The round-trip through it is asserted under writeSnapshot
// below; what these pin is the *resolution*, which used to try `<name>` and
// `<name>.tsv` first and accept anything `existsSync` liked.
describe("readSnapshot", () => {
  const name = "2026-06-23T1000";
  const file = "/home/me/a.txt";

  /** @param {string} snapshotDir */
  const writeRealSnapshot = (snapshotDir) =>
    writeFileSync(
      join(snapshotDir, snapshotFileName(name)),
      gzipSync(snapshotOf(fileRow(hashA, 3, file))),
    );

  it("reads the snapshot even with a same-named directory beside it", async () => {
    // The `backup` crash this fixes: decompressing a snapshot by hand leaves a
    // `<name>.tsv` next to it, and if that name is a *directory* the old
    // candidate list resolved to it and died on EISDIR mid-read.
    await using dir = await mkTmpDir();
    writeRealSnapshot(dir.path);
    mkdirSync(join(dir.path, `${name}.tsv`));
    mkdirSync(join(dir.path, name));

    const { entries } = await readSnapshot(dir.path, name);
    assert.deepEqual([...entries.keys()], [file]);
  });

  it("treats a directory named like the snapshot file as not found", async () => {
    await using dir = await mkTmpDir();
    mkdirSync(join(dir.path, snapshotFileName(name)));

    // Not an EISDIR out of a read stream: only a regular file is a snapshot,
    // so this is the same "no such snapshot" the lister would imply.
    await assert.rejects(readSnapshot(dir.path, name), /not found/);
  });
});

// writeSnapshot is the single production seam for "files → snapshot file". It is
// driven here with an injected getProps (so no disk hashing and no `prop` — the
// writer's own logic is what's under test): the rows and their layout, the
// #error-on-hashing-failure path, and the round-trip back through readSnapshot
// are all asserted at the writer's interface.
describe("writeSnapshot", () => {
  /** @type {(p: string) => Promise<Props>} */
  const props = async () => ({
    size: 3,
    mtime: "2026-06-23T10:00:00.000Z",
    hash: hashA,
  });

  /**
   * A written snapshot's rows, each split into its five columns: the four
   * padded ones trimmed, the last as written.
   * @param {string} path
   */
  const rowsOf = (path) =>
    gunzipSync(readFileSync(path))
      .toString("utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) =>
        line.split("\t").map((column, i) => (i < 4 ? column.trim() : column)),
      );

  it("writes -, #excluded and #error rows, and round-trips via readSnapshot", async () => {
    await using dir = await mkTmpDir();
    const a = resolve(dir.path, "a.txt");
    const b = resolve(dir.path, "b.txt");
    const bad = resolve(dir.path, "bad.bin");
    const scratch = resolve(dir.path, "scratch.tmp");
    const locked = resolve(dir.path, "locked");
    const archive = resolve(dir.path, "archive");
    const outside = "link to a folder outside the backup: /mnt/archive";

    const path = await writeSnapshot(dir.path, momentOf("2026-06-23T1000"), {
      set: setOf([dir.path]),
      files: [a, b, bad],
      excluded: [{ pattern: "*.tmp", path: scratch, isDir: false }],
      errors: [
        { path: locked, reason: "EACCES: permission denied, lstat" },
        // A folder link's `#error` ends its path with a separator (ADR-0098).
        { path: archive, reason: outside, isDir: true },
      ],
      getProps: async (p) => {
        // A file the walk can't hash becomes an #error row, not an entry.
        if (p === bad) {
          throw new Error("EACCES: permission denied");
        }
        return props(p);
      },
    });

    assert.match(path, /2026-06-23T1000\.tsv\.gz$/);

    const { entries, errors, dirs, instant } = await readSnapshot(
      dir.path,
      "2026-06-23T1000",
    );

    assert.equal(instant, momentOf("2026-06-23T1000").instant);
    assert.deepEqual(dirs, [resolve(dir.path) + sep]);
    assert.deepEqual([...entries.keys()], [a, b]);
    assert.equal(entries.get(a)?.hash, hashA);
    assert.ok(!entries.has(scratch), "#excluded row must not be an entry");
    // The walk's #error and the hashing one both come back, so compare reports
    // each path rather than mistaking it for deleted.
    assert.deepEqual(
      [...errors],
      [
        [locked, "EACCES: permission denied, lstat"],
        [archive + sep, outside],
        [bad, "EACCES: permission denied"],
      ],
    );
  });

  it("lays the rows out as ADR-0098 does, closed by a trailer it counts and times itself", async (t) => {
    // `FINISH` times *itself*, through format.mjs's clock seam — the one door
    // the model harness mocks — so pinning that clock pins it, rounded up to the
    // millisecond so it is never before the last row was written
    // (`completionInstant`'s rule, pinned in format.test.mjs).
    t.mock.method(Temporal.Now, "zonedDateTimeISO", () =>
      Temporal.Instant.from(
        "2026-06-23T10:30:00.123456789Z",
      ).toZonedDateTimeISO("Europe/London"),
    );
    await using dir = await mkTmpDir();
    const a = resolve(dir.path, "a.txt");
    const cache = resolve(dir.path, "cache");

    const path = await writeSnapshot(dir.path, momentOf("2026-06-23T1000"), {
      set: {
        name: "photos",
        bucket: "my-backups",
        endpoint: "https://s3.example.com",
        dirs: [dir.path],
        patterns: ["*.tmp", "cache"],
      },
      files: [a, resolve(dir.path, "b.bin")],
      excluded: [{ pattern: "cache", path: cache, isDir: true }],
      errors: [],
      getProps: async (p) => ({
        size: p === a ? 3 : 15463758036,
        mtime: "2026-06-23T10:00:00.000Z",
        hash: hashA,
      }),
    });

    const rows = rowsOf(path);
    assert.deepEqual(
      rows.map((row) => row.slice(0, 2).join(" ")),
      [
        "@S3CAB FORMAT",
        "@S3CAB VERSION",
        "@S3CAB HOME",
        "@SET NAME",
        "@SET BUCKET",
        "@SET ENDPOINT",
        "@SET DIR",
        "@SET EXCLUDE",
        "@SET EXCLUDE",
        "@SNAPSHOT NAME",
        "@SNAPSHOT BY",
        "@SNAPSHOT START",
        "#excluded cache",
        `- ${hashA}`,
        `- ${hashA}`,
        "@SNAPSHOT FILES",
        "@SNAPSHOT SIZE",
        "@SNAPSHOT FINISH",
        ".",
      ],
    );
    // The terminator is the one line with neither five fields nor a type.
    assert.deepEqual(rows.at(-1), ["."]);
    assert.ok(
      rows.slice(0, -1).every((row) => row.length === 5),
      "five columns on every row",
    );

    /**
     * The time and last columns of the rows with this type and col2.
     * @param {string} key - The type and col2, space-separated
     */
    const tail = (key) =>
      rows
        .filter(([type, col2]) => `${type} ${col2}` === key)
        .map(([, , , time, last]) => [time, last]);

    assert.deepEqual(rows[0], [
      "@S3CAB",
      "FORMAT",
      "size",
      "time",
      "https://s3cab.plantegral.com/guide/format",
    ]);
    assert.match(tail("@S3CAB VERSION")[0]?.[1] ?? "", /^\d+\.\d+\.\d+/);
    assert.ok(tail("@S3CAB HOME")[0]?.[1]?.endsWith(sep));
    assert.deepEqual(tail("@SET NAME"), [["", "photos"]]);
    assert.deepEqual(tail("@SET BUCKET"), [["", "s3://my-backups"]]);
    assert.deepEqual(tail("@SET ENDPOINT"), [["", "https://s3.example.com"]]);
    assert.deepEqual(tail("@SET EXCLUDE"), [
      ["", "*.tmp"],
      ["", "cache"],
    ]);
    // A folder's path ends with a separator: a member directory, and an
    // excluded folder alike.
    assert.deepEqual(tail("@SET DIR"), [["", dir.path + sep]]);
    assert.deepEqual(tail("#excluded cache"), [["", cache + sep]]);
    assert.deepEqual(tail("@SNAPSHOT NAME"), [["", "2026-06-23T1000"]]);
    assert.match(tail("@SNAPSHOT BY")[0]?.[1] ?? "", /^.+@.+$/);
    // Every spelling of the moment comes from the one `snapshotMoment` read the
    // caller made (ADR-0072), so the filename and these rows cannot disagree.
    assert.deepEqual(tail("@SNAPSHOT START"), [
      ["2026-06-23T09:00:00.000Z", "Europe/London"],
    ]);
    assert.deepEqual(tail("@SNAPSHOT FILES"), [["", "2"]]);
    assert.match(tail("@SNAPSHOT SIZE")[0]?.[1] ?? "", /^15463758039 \(.+\)$/);
    // Column 5 is the run's duration since `START`, in the closing report's form.
    assert.deepEqual(tail("@SNAPSHOT FINISH"), [
      ["2026-06-23T10:30:00.124Z", "1h 30m"],
    ]);

    // Column 1 is unpadded (ADR-0103), so a file row's type cell is exactly
    // `-` and the row carries no padding but its size's.
    const text = gunzipSync(readFileSync(path)).toString("utf8");
    assert.ok(text.endsWith("\n.\n"), "the last line is exactly .");
    assert.ok(
      text.includes(
        `\n-\t${hashA}\t           3\t2026-06-23T10:00:00.000Z\t${a}\n`,
      ),
    );
    assert.ok(text.includes("\n@SNAPSHOT\tSTART "));
  });

  it("spells out a control character in what only people read", async () => {
    // Excluding such a name is the escape hatch the walk's refusal points to
    // (ADR-0073), and an error message can span lines, so the snapshot must
    // stay one row per line when either turns up (ADR-0100).
    await using dir = await mkTmpDir();

    const path = await writeSnapshot(dir.path, momentOf("2026-06-23T1000"), {
      set: setOf([dir.path]),
      files: [],
      excluded: [
        {
          pattern: "odd*name.jpg",
          path: resolve(dir.path, "odd\nname.jpg"),
          isDir: false,
        },
      ],
      errors: [{ path: resolve(dir.path, "bad\rname"), reason: "EACCES:\tno" }],
      getProps: props,
    });

    assert.deepEqual(
      rowsOf(path).filter(
        ([type]) => type === "#excluded" || type === "#error",
      ),
      [
        [
          "#excluded",
          "odd*name.jpg",
          "",
          "",
          resolve(dir.path, "odd␊name.jpg"),
        ],
        ["#error", "EACCES:␉no", "", "", resolve(dir.path, "bad␍name")],
      ],
    );
  });

  it("passes rows through `through` and writes the identical file (the fusion seam)", async (t) => {
    // ADR-0069: `backup` PUTs each object from this transform. The promise the seam
    // rests on is that inserting it changes *when* work happens, never what the
    // snapshot says — so the two files must be byte-identical. `FINISH`
    // times itself, so the clock is pinned for both writes; nothing else in the
    // file can differ.
    t.mock.method(Temporal.Now, "zonedDateTimeISO", () =>
      Temporal.Instant.from("2026-06-23T10:30:00.000Z").toZonedDateTimeISO(
        "Europe/London",
      ),
    );
    await using dir = await mkTmpDir();
    const files = [resolve(dir.path, "a.txt"), resolve(dir.path, "b.txt")];
    const args = {
      set: setOf([dir.path]),
      files,
      ...nothingElse,
      getProps: props,
    };

    /** @type {string[]} */
    const seen = [];
    // The same name both times (the rows carry it), so only the transform differs.
    const plain = await writeSnapshot(
      dir.path,
      momentOf("2026-06-23T1000"),
      args,
    );
    const plainText = gunzipSync(readFileSync(plain)).toString("utf8");
    const fused = await writeSnapshot(dir.path, momentOf("2026-06-23T1000"), {
      ...args,
      through: async function* (rows) {
        for await (const row of rows) {
          seen.push(row[0]);
          yield row;
        }
      },
      overwrite: true,
    });

    // Every row reached the transform, in file order, before reaching the TSV.
    assert.deepEqual(seen, files);
    assert.equal(gunzipSync(readFileSync(fused)).toString("utf8"), plainText);
  });

  it("compresses with gzip level 9, memLevel 9 and Z_FILTERED (ADR-0097)", async () => {
    // The settings are the decision, and a round trip can't see them: any gzip
    // reads back the same. Recompressing the file's own text with exactly these
    // options must reproduce it byte for byte (deflate is deterministic for a
    // given input and settings, however the input was chunked), and zlib's
    // defaults must not, or this test couldn't tell the two apart. Random hex
    // hashes are what `Z_FILTERED` is for, so the fixture has a few hundred.
    await using dir = await mkTmpDir();
    const files = Array.from({ length: 400 }, (_, i) =>
      resolve(dir.path, `photo-${i}.jpg`),
    );
    const path = await writeSnapshot(dir.path, momentOf("2026-06-23T1000"), {
      set: setOf([dir.path]),
      files,
      ...nothingElse,
      getProps: async (file) => ({
        size: 3,
        mtime: "2026-06-23T10:00:00.000Z",
        hash: createHash("sha256").update(file).digest("hex"),
      }),
    });

    const written = readFileSync(path);
    const text = gunzipSync(written);
    const chosen = gzipSync(text, {
      level: 9,
      memLevel: 9,
      strategy: constants.Z_FILTERED,
    });
    assert.ok(written.equals(chosen), "written with the ADR-0097 settings");
    assert.ok(!written.equals(gzipSync(text)), "distinct from zlib's defaults");
  });

  it("refuses an existing same-name snapshot unless overwrite is set", async () => {
    await using dir = await mkTmpDir();
    /** @type {Parameters<typeof writeSnapshot>[2]} */
    const args = {
      set: setOf([dir.path]),
      files: [],
      ...nothingElse,
      getProps: props,
    };

    await writeSnapshot(dir.path, momentOf("2026-06-23T1000"), args);
    await assert.rejects(
      writeSnapshot(dir.path, momentOf("2026-06-23T1000"), args),
      /same minute/,
    );
    // The debug escape hatch: overwrite replaces it without erroring.
    await writeSnapshot(dir.path, momentOf("2026-06-23T1000"), {
      ...args,
      overwrite: true,
    });
  });
});

// The snapshot temp file doubles as the set's concurrency lock (ADR-0048):
// created atomically (`wx`) on acquire, consumed by the rename on success,
// unlinked on failure. Driven at the withSnapshotFile seam so the lock's three
// paths — held, stale, released-on-failure — are asserted without a real walk.
describe("withSnapshotFile (snapshot concurrency lock)", () => {
  it("refuses a concurrent snapshot while the first holds the lock", async () => {
    await using dir = await mkTmpDir();
    const acquired = Promise.withResolvers();
    const gate = Promise.withResolvers();

    // First run: signal once inside the callback (lock held), then block.
    // The callback must end the stream itself (in production writeSnapshot's
    // pipeline does that) or the compression pipeline never settles.
    const first = withSnapshotFile(dir.path, "2026-06-23T1000", async (s) => {
      acquired.resolve(undefined);
      await gate.promise;
      s.end("x");
    });
    await acquired.promise;

    // Second run (different name, so it's the lock refusing, not the
    // same-minute check) must fail with the in-progress error.
    await assert.rejects(
      withSnapshotFile(dir.path, "2026-06-23T1001", async () => {}),
      /already in progress/,
    );

    // Release the first run: it completes, and the rename that installs the
    // snapshot is also what releases the lock — no temp file remains.
    gate.resolve(undefined);
    const path = await first;
    assert.match(path, /2026-06-23T1000\.tsv\.gz$/);
    assert.ok(
      !existsSync(resolve(dir.path, ".snapshot.tsv.gz")),
      "success must release the lock (temp renamed away)",
    );
  });

  it("reports a stale lock (crashed run's leftover) with the exact fix", async () => {
    await using dir = await mkTmpDir();
    const tmpPath = resolve(dir.path, ".snapshot.tsv.gz");
    writeFileSync(tmpPath, "");

    await assert.rejects(
      withSnapshotFile(dir.path, "2026-06-23T1000", async () => {}),
      (/** @type {Error} */ error) => {
        // ADR-0030: goal-framed headline, then the copy-pasteable fixes, gated
        // on nothing else running. Recovery leads (ADR-0092) — the file holds
        // the hashes the dead run had already worked out — and the delete
        // remains as the way to start the pass over.
        assert.match(error.message, /already in progress/);
        assert.match(error.message, /carry on from the file hashes/);
        assert.match(error.message, /same command again with --resume/);
        assert.match(error.message, /start the pass over/);
        assert.ok(
          error.message.includes(tmpPath),
          "the fix must name the lock file's real path",
        );
        return true;
      },
    );
  });

  it("releases the lock when a run fails, so the next run succeeds", async () => {
    await using dir = await mkTmpDir();

    await assert.rejects(
      withSnapshotFile(dir.path, "2026-06-23T1000", async () => {
        throw new Error("member directory vanished");
      }),
      /vanished/,
    );
    assert.ok(
      !existsSync(resolve(dir.path, ".snapshot.tsv.gz")),
      "a failed run must release the lock, not wedge the next one",
    );

    // The retry acquires cleanly and completes.
    const path = await withSnapshotFile(
      dir.path,
      "2026-06-23T1000",
      async (s) => {
        s.end("x");
      },
    );
    assert.match(path, /2026-06-23T1000\.tsv\.gz$/);
  });
});

// Park-on-interrupt (ADR-0067): a graceful stop ends the writer cleanly and
// renames the work file aside as `.snapshot.lookup.tsv.gz`, so the next run
// reuses the hashes it holds instead of computing them again. Driven through
// `writeSnapshot` with a `getProps` that raises the signal part-way:
// `process.emit` invokes exactly the listener `withSnapshotFile` registers,
// without asking the OS to signal the test runner.
describe("withSnapshotFile (park on interrupt)", () => {
  const parkedPath = (/** @type {string} */ dir) =>
    resolve(dir, ".snapshot.lookup.tsv.gz");
  const lockPath = (/** @type {string} */ dir) =>
    resolve(dir, ".snapshot.tsv.gz");

  /** @type {(p: string) => Promise<Props>} */
  const props = async () => ({
    size: 3,
    mtime: "2026-06-23T10:00:00.000Z",
    hash: hashA,
  });

  /**
   * A `getProps` that raises SIGINT once it has hashed `count` files — the row
   * it is called for still lands (its hash is already paid for); the stop takes
   * effect before the next one.
   * @param {number} count
   */
  const interruptAfter = (count) => {
    let hashed = 0;
    return async (/** @type {string} */ path) => {
      if (++hashed === count) {
        process.emit("SIGINT", "SIGINT");
      }
      return props(path);
    };
  };

  /**
   * @param {string} snapshotDir
   * @param {string} name
   * @param {Iterable<string> | AsyncIterable<string>} files
   * @param {(p: string) => Promise<Props>} getProps
   */
  const write = (snapshotDir, name, files, getProps) =>
    writeSnapshot(snapshotDir, momentOf(name), {
      set: setOf([snapshotDir]),
      files,
      ...nothingElse,
      getProps,
    });

  /** @param {string} dir */
  const paths = (dir) =>
    ["a", "b", "c", "d"].map((name) => resolve(dir, `${name}.txt`));

  it("parks the work file on Ctrl+C instead of discarding it", async () => {
    await using dir = await mkTmpDir();
    const files = paths(dir.path);

    await assert.rejects(
      write(dir.path, "2026-06-23T1000", files, interruptAfter(2)),
      InterruptedError,
    );

    // No snapshot lands — this run did not finish the tree.
    assert.ok(
      !existsSync(resolve(dir.path, "2026-06-23T1000.tsv.gz")),
      "an interrupted run must not install a partial snapshot",
    );
    // The lock is released by the park, not left for `inProgressError`.
    assert.ok(
      !existsSync(lockPath(dir.path)),
      "parking must release the lock (the work file is renamed away)",
    );
    assert.ok(
      existsSync(parkedPath(dir.path)),
      "the hashes computed so far must be parked",
    );

    // Every row hashed before the stop: a graceful stop ends on a whole row and
    // its LF, so the tolerant read keeps them all (ADR-0106).
    const parked = await readParkedLookup(dir.path);
    assert.ok(parked);
    assert.deepEqual([...parked.entries.keys()], files.slice(0, 2));
    assert.equal(parked.entries.get(files[0] ?? "")?.hash, hashA);
    // The stopped run's start comes back with them — the change-time boundary
    // when there is no previous snapshot (ADR-0094).
    assert.equal(parked.instant, momentOf("2026-06-23T1000").instant);
  });

  it("stops the parked file after its last - row, with no trailer", async () => {
    await using dir = await mkTmpDir();

    await assert.rejects(
      write(dir.path, "2026-06-23T1000", paths(dir.path), interruptAfter(2)),
      InterruptedError,
    );

    // A clean `end()` flushes whole writes only, so the last byte is the
    // newline of the last complete row. No `FILES`, `SIZE`, `FINISH` or `.`:
    // the `.` means the file is complete, and a parked one isn't (ADR-0098).
    const text = gunzipSync(readFileSync(parkedPath(dir.path))).toString(
      "utf8",
    );
    assert.ok(text.endsWith("\n"));
    const lines = text.split("\n").filter(Boolean);
    assert.match(lines.at(-1) ?? "", /^-\t/);
    for (const line of lines) {
      assert.equal(line.split("\t").length, 5, `whole row expected: ${line}`);
      assert.doesNotMatch(line, /^@SNAPSHOT\t(FILES|SIZE|FINISH)\s/);
    }
  });

  it("deletes the parked lookup only once a snapshot lands", async () => {
    await using dir = await mkTmpDir();
    const files = paths(dir.path);

    await assert.rejects(
      write(dir.path, "2026-06-23T1000", files, interruptAfter(2)),
      InterruptedError,
    );

    // A *failed* run must leave the parked work alone — it is the only copy.
    // (A walk that dies mid-stream, not a getProps failure: an unhashable file
    // is recorded as an `#error` row and does not fail the run.)
    async function* vanishing() {
      yield files[0] ?? "";
      throw new Error("member directory vanished");
    }
    await assert.rejects(
      write(dir.path, "2026-06-23T1001", vanishing(), props),
      /vanished/,
    );
    assert.ok(
      existsSync(parkedPath(dir.path)),
      "a failed run must not throw away parked hashes",
    );

    // The completed snapshot re-records every parked row, so the parked copy
    // is redundant — and only then is it removed.
    await write(dir.path, "2026-06-23T1002", files, props);
    assert.ok(
      !existsSync(parkedPath(dir.path)),
      "a landed snapshot must consume the parked lookup",
    );
    assert.equal(await readParkedLookup(dir.path), undefined);
  });

  it("parks cumulatively — a second stop replaces the first with a fuller lookup", async () => {
    await using dir = await mkTmpDir();
    const files = paths(dir.path);

    await assert.rejects(
      write(dir.path, "2026-06-23T1000", files, interruptAfter(2)),
      InterruptedError,
    );
    const first = await readParkedLookup(dir.path);
    assert.equal(first?.entries.size, 2);

    // The resumed run re-records the reused rows into its own work file, so its
    // parked file is a superset — and replacing must work on Windows too, where
    // a rename cannot land on an existing file.
    await assert.rejects(
      write(dir.path, "2026-06-23T1001", files, interruptAfter(3)),
      InterruptedError,
    );
    const second = await readParkedLookup(dir.path);
    assert.deepEqual([...(second?.entries.keys() ?? [])], files.slice(0, 3));
  });

  it("leaves no signal listeners behind after the write", async () => {
    await using dir = await mkTmpDir();
    const before = process.listenerCount("SIGINT");

    await write(dir.path, "2026-06-23T1000", paths(dir.path), props);
    assert.equal(
      process.listenerCount("SIGINT"),
      before,
      "a completed write must restore Node's default interrupt behaviour",
    );

    // Including on the park path — the handler is removed as the run unwinds.
    await assert.rejects(
      write(dir.path, "2026-06-23T1001", paths(dir.path), interruptAfter(1)),
      InterruptedError,
    );
    assert.equal(process.listenerCount("SIGINT"), before);
  });

  // Every test above raises the signal with `process.emit`, which calls the
  // listener on the spot — so none of them can see that a *real* signal waits
  // for an event-loop turn, which a pass of synchronous work never takes on its
  // own (ADR-0093). This one sends the real thing. Not on Windows: there Node
  // ends a process that sends itself SIGINT outright, before any listener runs,
  // and a real Ctrl+C reaches the same loop-turn listener by the console instead.
  it(
    "hears a real Ctrl+C mid-pass, though every row's work is synchronous",
    { skip: process.platform === "win32" },
    async () => {
      await using dir = await mkTmpDir();
      const files = Array.from({ length: 200 }, (_, i) =>
        resolve(dir.path, `${i}.txt`),
      );
      // ~5ms of blocking work per file, the shape of `readFileSync` +
      // `crypto.hash` behind an `async` signature.
      const blocked = new Int32Array(new SharedArrayBuffer(4));
      let hashed = 0;
      /** @type {(p: string) => Promise<Props>} */
      const getProps = async (path) => {
        if (++hashed === 10) {
          process.kill(process.pid, "SIGINT");
        }
        Atomics.wait(blocked, 0, 0, 5);
        return props(path);
      };

      // A listener of the test's own, so a signal heard only after the write has
      // removed its handler is absorbed rather than ending the test worker: a
      // pass that never conceded the loop fails the assertion below, not the run.
      const absorb = () => {};
      process.on("SIGINT", absorb);
      try {
        await assert.rejects(
          write(dir.path, "2026-06-23T1000", files, getProps),
          InterruptedError,
        );
      } finally {
        await setTimeout(50);
        process.off("SIGINT", absorb);
      }
      // Heard within a concession or two of the signal — not at the end of the
      // pass, where an unheard signal would still park all 200 rows and throw
      // the same InterruptedError.
      assert.ok(
        hashed < 100,
        `expected the pass to stop soon after the signal, but it hashed ${hashed} of 200 files`,
      );
    },
  );
});

describe("readParkedLookup", () => {
  const parkedPath = (/** @type {string} */ dir) =>
    resolve(dir, ".snapshot.lookup.tsv.gz");

  /**
   * Park a file as a run that started at `instant` and was stopped with Ctrl+C
   * leaves it: no trailer, so its last row is dropped on read.
   * @param {string} dir
   * @param {string} instant
   */
  const parkRunStartedAt = (dir, instant) => {
    const text = [
      HEADING,
      dirRow(dir),
      `@SNAPSHOT\tSTART\t\t${instant}\tEurope/London`,
      fileRow(hashA, 1, resolve(dir, "a.txt")),
      fileRow(hashA, 2, resolve(dir, "b.txt")),
    ].join("\n");
    writeFileSync(parkedPath(dir), gzipSync(Buffer.from(text, "utf8")));
  };

  it("returns undefined when nothing is parked (the ordinary case)", async () => {
    await using dir = await mkTmpDir();
    assert.equal(await readParkedLookup(dir.path), undefined);
  });

  it("ignores a file parked by a run that started before the previous snapshot", async () => {
    await using dir = await mkTmpDir();
    parkRunStartedAt(dir.path, "2026-06-12T08:15:32.123Z");

    const parked = await readParkedLookup(dir.path, "2026-06-12T08:15:32.124Z");

    assert.equal(parked, undefined);
    assert.ok(
      existsSync(parkedPath(dir.path)),
      "an ignored file is left for the next landed snapshot to delete",
    );
  });

  it("reads a file parked by a run that started after the previous snapshot", async () => {
    await using dir = await mkTmpDir();
    parkRunStartedAt(dir.path, "2026-06-12T08:15:32.123Z");

    const parked = await readParkedLookup(dir.path, "2026-06-12T08:15:32.122Z");

    assert.deepEqual(
      [...(parked?.entries.keys() ?? [])],
      [resolve(dir.path, "a.txt")],
    );
  });
});

// Recovering a hard-killed run's work file (ADR-0092). A second Ctrl+C, a power
// cut or a kill runs no handler, so the file is left at the *lock* name with no
// trailer and a torn last row — where a graceful park leaves whole rows under
// the other name. `--resume` adopts it instead of throwing it away.
describe("recoverWorkFile", () => {
  const lockPath = (/** @type {string} */ dir) =>
    resolve(dir, ".snapshot.tsv.gz");
  const parkedPath = (/** @type {string} */ dir) =>
    resolve(dir, ".snapshot.lookup.tsv.gz");

  /**
   * Leave a work file exactly as a hard kill leaves one: the opening rows,
   * whole file rows, then a row cut off mid-write. Built as bytes rather than
   * by killing a real write, so the artifact under test is pinned to the shape
   * measured on a real 280,277-file set — 272,692 whole rows, one torn line, no
   * closing `.`.
   * @param {string} dir
   * @param {string[]} files
   */
  const killedRun = (dir, files) => {
    const text = [
      HEADING,
      dirRow(dir),
      START,
      ...files.map((path, i) => fileRow(hashA, i + 1, path)),
      `-\t${hashA}\t2806546623\t2026-07-26T17:21:28`,
    ].join("\n");
    writeFileSync(lockPath(dir), gzipSync(Buffer.from(text, "utf8")));
  };

  it("adopts the work file, so its hashes are there to reuse", async () => {
    await using dir = await mkTmpDir();
    const files = [resolve(dir.path, "a.txt"), resolve(dir.path, "b.txt")];
    killedRun(dir.path, files);

    assert.equal(await recoverWorkFile(dir.path), true);

    // The rename *is* the recovery: the file moves from the name that means "a
    // run is writing, keep out" to the one that means "here are hashes to
    // reuse", which releases the lock and feeds the lookup in one motion.
    assert.ok(
      !existsSync(lockPath(dir.path)),
      "recovery must release the lock it adopted",
    );
    assert.ok(existsSync(parkedPath(dir.path)));
    const parked = await readParkedLookup(dir.path);
    assert.deepEqual([...(parked?.entries.keys() ?? [])], files);
  });

  it("recovers the rows of a gzip stream its run never closed", async () => {
    // What a kill leaves on disk is a cut-short *stream*: the compressor had
    // written its finished deflate blocks and not the one it was filling, nor
    // gzip's trailer. `killedRun` alone is a whole stream around a torn row, so
    // this needs rows enough for several blocks and then cuts it.
    await using dir = await mkTmpDir();
    const files = Array.from({ length: 3000 }, (_, i) =>
      resolve(dir.path, `photo-${i}.jpg`),
    );
    killedRun(dir.path, files);
    const whole = readFileSync(lockPath(dir.path));
    writeFileSync(
      lockPath(dir.path),
      whole.subarray(0, Math.floor(whole.length * 0.9)),
    );

    await recoverWorkFile(dir.path);
    const parked = await readParkedLookup(dir.path);

    const recovered = [...(parked?.entries.keys() ?? [])];
    assert.ok(recovered.length > 0, "the flushed blocks' rows must survive");
    assert.ok(recovered.length < files.length, "the fixture must cut rows");
    // A prefix of the real paths, in order: a row torn at the cut is dropped,
    // never filed under a prefix of its path.
    assert.deepEqual(recovered, files.slice(0, recovered.length));
  });

  it("keeps the start instant of the run that never finished", async () => {
    // No trailer, but `@SNAPSHOT START` is written before any object, so the
    // change-time boundary (ADR-0094) survives the kill.
    await using dir = await mkTmpDir();
    killedRun(dir.path, [resolve(dir.path, "a.txt")]);
    await recoverWorkFile(dir.path);

    const parked = await readParkedLookup(dir.path);

    assert.equal(parked?.instant, "2026-06-12T08:15:32.123Z");
  });

  it("unblocks the next run, which the leftover file was refusing", async () => {
    await using dir = await mkTmpDir();
    const files = [resolve(dir.path, "a.txt")];
    killedRun(dir.path, files);

    // Before: the lock is held by a run that no longer exists.
    await assert.rejects(
      writeSnapshot(dir.path, momentOf("2026-06-23T1000"), {
        set: setOf([dir.path]),
        files,
        ...nothingElse,
        getProps: async () => ({
          size: 3,
          mtime: "2026-06-23T10:00:00.000Z",
          hash: hashA,
        }),
      }),
      /already in progress/,
    );

    await recoverWorkFile(dir.path);

    const path = await writeSnapshot(dir.path, momentOf("2026-06-23T1000"), {
      set: setOf([dir.path]),
      files,
      ...nothingElse,
      getProps: async () => ({
        size: 3,
        mtime: "2026-06-23T10:00:00.000Z",
        hash: hashA,
      }),
    });
    assert.match(path, /2026-06-23T1000\.tsv\.gz$/);
    // And the snapshot landing consumes the recovered lookup, exactly as it
    // consumes a gracefully parked one.
    assert.ok(!existsSync(parkedPath(dir.path)));
  });

  it("leaves a rival's adoption alone when it finds nothing to adopt", async () => {
    // Two `--resume` runs started together both see the work file; the rename is
    // what settles which owns it, and the loser must adopt nothing rather than
    // destroy what the winner took. Sequential calls are the deterministic
    // stand-in for that race — the second is the loser, running against exactly
    // the state the winner left. Checking for the file and *then* replacing the
    // parked one would delete the winner's hashes here and fail on the rename.
    await using dir = await mkTmpDir();
    const files = [resolve(dir.path, "a.txt")];
    killedRun(dir.path, files);

    assert.equal(await recoverWorkFile(dir.path), true);
    assert.equal(await recoverWorkFile(dir.path), false);

    const parked = await readParkedLookup(dir.path);
    assert.deepEqual([...(parked?.entries.keys() ?? [])], files);
  });

  it("does nothing when there is no work file to adopt", async () => {
    // `--resume` on a clean set is not an error: the user cannot be expected to
    // know whether the run they killed had got as far as opening the file.
    await using dir = await mkTmpDir();
    assert.equal(await recoverWorkFile(dir.path), false);
    assert.equal(await readParkedLookup(dir.path), undefined);
  });
});

describe("readSnapshot names the alternatives on a miss (ADR-0030)", () => {
  /**
   * @param {string} dir
   * @param {string} name
   */
  const seed = (dir, name) =>
    writeSnapshot(dir, momentOf(name), {
      set: setOf([dir]),
      files: [resolve(dir, "a.txt")],
      ...nothingElse,
      getProps: async () => ({
        size: 1,
        mtime: "2026-06-01T00:00:00.000Z",
        hash: "h",
      }),
    });

  it("lists the snapshots that do exist, newest first and untruncated", async () => {
    await using dir = await mkTmpDir();
    await seed(dir.path, "2026-06-12T0915");
    await seed(dir.path, "2026-06-19T0902");
    await seed(dir.path, "2026-06-05T1130");

    await assert.rejects(readSnapshot(dir.path, "2026-06-13T0000"), (error) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /Snapshot '2026-06-13T0000' not found/);
      // Every candidate, in the order `list` would show them — so the name can
      // be copied straight out of the error.
      const listed = error.message
        .split("\n")
        .filter((line) => /^ {2}\d{4}-/.test(line))
        .map((line) => line.trim());
      assert.deepStrictEqual(listed, [
        "2026-06-19T0902",
        "2026-06-12T0915",
        "2026-06-05T1130",
      ]);
      return true;
    });
  });

  it("says so plainly when the set has no snapshots at all", async () => {
    await using dir = await mkTmpDir();
    // Listing nothing under "here are the others" would read as a bug, so the
    // empty case gets its own sentence and points at how to make one.
    await assert.rejects(readSnapshot(dir.path, "2026-06-12T0915"), (error) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /no snapshots in/);
      assert.match(error.message, /s3cab snapshot/);
      assert.doesNotMatch(error.message, /newest first/);
      return true;
    });
  });
});

describe("the snapshot moment (ADR-0072)", () => {
  it("mints three spellings of one instant that agree with each other", () => {
    const { name, instant, zone } = snapshotMoment();

    // Not a formatting check: this is the invariant one clock read buys. Take
    // the machine-readable instant, put it back in the recorded zone, and the
    // local wall clock it lands on must be the name — so a reader can always
    // resolve the name, and the two can never drift a minute apart.
    const roundTrip = Temporal.Instant.from(instant)
      .toZonedDateTimeISO(zone)
      .toPlainDateTime()
      .toString({ smallestUnit: "minutes" })
      .replace(":", "");
    assert.equal(roundTrip, name);

    assert.match(name, /^\d{4}-\d{2}-\d{2}T\d{4}$/);
    assert.equal(instant.length, 24, "must fit mtime's own 24-wide column");
    assert.match(instant, /Z$/);
  });
});
