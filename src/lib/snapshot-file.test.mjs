import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtempDisposable } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Readable } from "node:stream";
import { describe, it } from "node:test";
import { setTimeout } from "node:timers/promises";
import { zstdCompressSync, zstdDecompressSync } from "node:zlib";
import { InterruptedError } from "./error.mjs";
import {
  listSnapshotNames,
  normalizeSnapshotName,
  parseCompressedSnapshotStream,
  parseSnapshotStream,
  readParkedLookup,
  readSnapshot,
  readSnapshotFile,
  recoverWorkFile,
  snapshotFileName,
  snapshotMoment,
  snapshotNames,
  withSnapshotFile,
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
      "#SNAPSHOT\tphotos\t2026-06-12T08:15:32.123Z\t2026-06-12T0915 Europe/London",
      "#DIR\t\t\tC:\\Users\\me\\Photos",
      "#DIR\t\t\tD:\\Pics",
      `${hashA}\t12\t2026-06-01T12:00:00.000Z\tC:\\Users\\me\\Photos\\beach.jpg`,
      `${hashB}\t34\t2026-06-02T08:30:00.000Z\tD:\\Pics\\ski.jpg`,
      "#END",
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
    const text = `${hashA}\t12\t2026-06-01T12:00:00.000Z\t/home/me/a.txt\n#END`;
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
      "#END",
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
      "#END",
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
    const text = `${hashA}\t5\t2026-06-01T12:00:00.000Z\t${path}\n#END`;
    const { entries } = await parse(text);
    assert.ok(
      entries.has(path),
      "path with surrounding spaces must be kept verbatim",
    );
    assert.ok(!entries.has(path.trim()), "trimmed form must not be present");
  });

  it("rejects a stream that ends without the #END trailer as truncated", async () => {
    // ADR-0082: this parser takes an already-decompressed stream, so it has no
    // frame to lean on — for an uncompressed `.tsv` there is none at all, and
    // the trailer is the only thing standing between a destroyed manifest and a
    // clean parse. An AssertionError on purpose — isCorruptSnapshotError
    // classifies it as snapshot damage, so verify records the finding instead
    // of vouching for the wreck.
    const text = [
      "#SNAPSHOT\tphotos\t2026-06-12T08:15:32.123Z\t2026-06-12T0915 Europe/London",
      `${hashA}\t12\t2026-06-01T12:00:00.000Z\t/home/me/a.txt`,
    ].join("\n");
    await assert.rejects(parse(text), {
      name: "AssertionError",
      message: /Truncated snapshot/,
    });
  });

  it("reads a work file's whole rows, dropping the one it died mid-write", async () => {
    // ADR-0092: a hard-killed run's file has no trailer — it never reached one
    // — and its last row is a prefix, cut between the compressor's last flushed
    // block and the end of the line. Both are the *expected* state here, where
    // for a snapshot they are damage. The torn row is the shape measured on a
    // real work file: hash and size intact, the mtime cut in half, no path.
    const text = [
      "#SNAPSHOT\tphotos\t2026-06-12T08:15:32.123Z\t2026-06-12T0915 Europe/London",
      `${hashA}\t12\t2026-06-01T12:00:00.000Z\t/home/me/a.txt`,
      `${hashA}\t34\t2026-06-01T12:00:00.000Z\t/home/me/b.txt`,
      `${hashA}\t2806546623\t2026-07-26T17:21:28`,
    ].join("\n");

    const { entries, completed } = await parseSnapshotStream(
      Readable.from([text]),
      { tolerant: true },
    );

    assert.deepEqual([...entries.keys()], ["/home/me/a.txt", "/home/me/b.txt"]);
    // No trailer means no completion instant.
    assert.equal(completed, undefined);
  });

  it("drops a last row torn inside the path, which looks whole but isn't", async () => {
    // The dangerous tear, and the reason the last line is taken on the
    // trailer's word rather than on its own looks: cut after the fourth tab and
    // all four columns are populated, so the row parses — filing a real hash
    // under a *prefix* of the real path. A live file matching that prefix whose
    // size and mtime agree with the row would then be stored under another
    // file's content hash. The cost of the rule is visible here too: with no
    // trailer, a final row that *was* whole is dropped as well.
    const text = [
      `${hashA}\t12\t2026-06-01T12:00:00.000Z\t/home/me/a.txt`,
      `${hashB}\t34\t2026-06-01T12:00:00.000Z\t/home/me/photo`,
    ].join("\n");

    const { entries } = await parseSnapshotStream(Readable.from([text]), {
      tolerant: true,
    });

    assert.deepEqual([...entries.keys()], ["/home/me/a.txt"]);
  });

  it("keeps a parked file's last row, which its trailer vouches for", async () => {
    // So the lookbehind costs a *gracefully* parked file nothing (ADR-0067):
    // its last line is the `#END` trailer, which is the one line nothing can
    // follow and so the one line that vouches for itself. Only a hard-killed
    // file pays a dropped row.
    const text = [
      `${hashA}\t12\t2026-06-01T12:00:00.000Z\t/home/me/a.txt`,
      `${hashB}\t34\t2026-06-01T12:00:00.000Z\t/home/me/b.txt`,
      "#END\tPARTIAL\t2026-06-12T08:20:44.500Z\t",
    ].join("\n");

    const { entries, status, completed } = await parseSnapshotStream(
      Readable.from([text]),
      { tolerant: true },
    );

    assert.deepEqual([...entries.keys()], ["/home/me/a.txt", "/home/me/b.txt"]);
    assert.equal(status, "PARTIAL");
    assert.equal(completed, "2026-06-12T08:20:44.500Z");
  });

  it("tolerates a torn row only as the file's last line", async () => {
    // The tear an interrupted write leaves is always the tail. Damage in the
    // *body* is something else entirely, and forgiving it would quietly drop
    // rows from the middle of a lookup, so the tolerance stops at the last line.
    const text = [
      `${hashA}\t12\t2026-06-01T12:00:00.000Z\t/home/me/a.txt`,
      `${hashA}\t34\t2026-06-01T12:00:00.000Z`,
      `${hashA}\t56\t2026-06-01T12:00:00.000Z\t/home/me/c.txt`,
    ].join("\n");

    await assert.rejects(
      parseSnapshotStream(Readable.from([text]), { tolerant: true }),
      { name: "AssertionError", message: /Malformed snapshot line/ },
    );
  });

  it("reads the trailer's status and completion instant", async () => {
    const text = [
      `${hashA}\t12\t2026-06-01T12:00:00.000Z\t/home/me/a.txt`,
      "#END\t   PARTIAL\t2026-06-12T08:20:44.500Z\t",
    ].join("\n");

    const { status, completed } = await parse(text);

    assert.equal(status, "PARTIAL");
    assert.equal(completed, "2026-06-12T08:20:44.500Z");
  });

  it("reads a bare trailer as a file that names neither", async () => {
    // A trailer written before the columns existed. `undefined` is the honest
    // reading: a caller wanting a trust boundary falls back to the `#SNAPSHOT`
    // instant, which is earlier and so only ever more cautious (ADR-0085).
    const text = [
      `${hashA}\t12\t2026-06-01T12:00:00.000Z\t/home/me/a.txt`,
      "#END",
    ].join("\n");

    const { status, completed, entries } = await parse(text);

    assert.equal(status, undefined);
    assert.equal(completed, undefined);
    assert.equal(entries.size, 1, "the rows still parse");
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
      "#END",
      "",
    ].join("\n");
    const { entries } = await parse(text);
    assert.equal(entries.size, 2);
  });
});

// parseCompressedSnapshotStream fronts the parser with zstd as the terminal
// sink of a pipeline. The shape exists for error propagation: the `.pipe` it
// replaced forwarded no source `error`, so a dropped stream stalled the parser
// forever — which is why these tests carry timeouts (the failure mode under
// guard is a hang, not a throw). The teardown half of the story — completing a
// read without aborting the live S3 request (#171) — needs a real body and is
// covered in test/integration/remote.test.mjs.
describe("parseCompressedSnapshotStream", () => {
  const text = [
    "#SNAPSHOT\tphotos\t2026-06-12T08:15:32.123Z\t2026-06-12T0915 Europe/London",
    `${hashA}\t12\t2026-06-01T12:00:00.000Z\t/home/me/a.txt`,
    "#END",
  ].join("\n");

  it(
    "parses a compressed stream arriving in arbitrary chunks",
    { timeout: 5000 },
    async () => {
      const compressed = zstdCompressSync(text);
      const chunks = [];
      for (let i = 0; i < compressed.length; i += 7) {
        chunks.push(compressed.subarray(i, i + 7));
      }
      const { entries, identity } = await parseCompressedSnapshotStream(
        Readable.from(chunks),
      );
      assert.equal(identity, "photos");
      assert.deepEqual([...entries.keys()], ["/home/me/a.txt"]);
    },
  );

  it(
    "rejects cut-short bytes as a truncated snapshot, whichever layer notices",
    { timeout: 5000 },
    async () => {
      // zstd rejects the cut stream itself (`Z_BUF_ERROR`) where the parser
      // would otherwise have missed `#END` — measured on 26.10 for both cuts
      // here, the empty stream included. Either way it must surface as the same
      // AssertionError, the one isCorruptSnapshotError files as damage
      // (ADR-0082 amendments 2 and 3).
      const compressed = zstdCompressSync(text);
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
      const compressed = zstdCompressSync(text);
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
      source.push(zstdCompressSync(text).subarray(0, 8));
      const parsed = parseCompressedSnapshotStream(source);
      source.destroy();
      await assert.rejects(parsed, { code: "ERR_STREAM_PREMATURE_CLOSE" });
    },
  );
});

const mkTmpDir = async () => mkdtempDisposable(join("test", ".tmp"));

const RESUME = "s3cab snapshot photos --resume";

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

  // `.at(0)` is how every caller wanting just the newest one spells it, so the
  // two cases that used to cover the `latest` option are asserted through it.
  it("puts the newest snapshot name first", async () => {
    await using dir = await mkTmpDir();
    makeSnapshots(dir.path, [
      "2025-01-14T0830.tsv.zst",
      "2025-01-15T1030.tsv.zst",
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
    assert.deepEqual(snapshotNames([`${name}.tsv.zst`]), [name]);
  });
});

describe("snapshotFileName", () => {
  it("appends the stored extension — the format spec's promise, spelled out", () => {
    // The literal is written independently on purpose: `.tsv.zst` is a
    // user-facing contract (guide/format.md), so changing it must fail here.
    assert.equal(
      snapshotFileName("2026-06-12T0915"),
      "2026-06-12T0915.tsv.zst",
    );
  });
});

describe("normalizeSnapshotName", () => {
  it("strips the .tsv/.tsv.zst extension and leaves bare names alone", () => {
    const name = "2026-06-12T0915";
    assert.equal(normalizeSnapshotName(`${name}.tsv.zst`), name);
    assert.equal(normalizeSnapshotName(`${name}.tsv`), name);
    assert.equal(normalizeSnapshotName(name), name);
    assert.equal(normalizeSnapshotName(undefined), undefined);
  });
});

// readSnapshot resolves a name to the one file a snapshot can be — its
// `<name>.tsv.zst`. The round-trip through it is asserted under writeSnapshot
// below; what these pin is the *resolution*, which used to try `<name>` and
// `<name>.tsv` first and accept anything `existsSync` liked.
describe("readSnapshot", () => {
  const name = "2026-06-23T1000";
  const file = "/home/me/a.txt";

  /** @param {string} snapshotDir */
  const writeRealSnapshot = (snapshotDir) =>
    writeFileSync(
      join(snapshotDir, snapshotFileName(name)),
      zstdCompressSync(
        [
          "#SNAPSHOT\tphotos\t2026-06-23T09:00:00.000Z\t2026-06-23T1000 Europe/London",
          `${hashA}\t3\t2026-06-23T10:00:00.000Z\t${file}`,
          "#END",
        ].join("\n"),
      ),
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

    const path = await writeSnapshot(dir.path, momentOf("2026-06-23T1000"), {
      resumeCommand: RESUME,
      identity: "photos",
      dirs: [dir.path],
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

    await writeSnapshot(dir.path, momentOf("2026-06-23T1000"), {
      resumeCommand: RESUME,
      identity: "photos",
      dirs,
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

    const path = await writeSnapshot(dir.path, momentOf("2026-06-23T1000"), {
      resumeCommand: RESUME,
      identity: "photos",
      dirs: [dir.path],
      files: [regular],
      excluded: [],
      skipped: [
        {
          fileType: "Symbolic Link",
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
    // It must be surfaced in skipped with *both* written columns. The file type
    // is the one that answers "what was that?" — the reason is the same string
    // for every skip the walk records — and it used to be dropped on read.
    assert.deepEqual(
      [...snap.skipped],
      [[link, { fileType: "Symbolic Link", reason: "Unsupported file type" }]],
    );
  });

  it("passes rows through `through` and writes the identical file (the fusion seam)", async (t) => {
    // ADR-0069: `backup` PUTs each object from this transform. The promise the seam
    // rests on is that inserting it changes *when* work happens, never what the
    // snapshot says — so the two files must be byte-identical. The `#END`
    // trailer times itself, so the clock is pinned for both writes; nothing
    // else in the file can differ.
    t.mock.method(Temporal.Now, "zonedDateTimeISO", () =>
      Temporal.Instant.from("2026-06-23T10:30:00.000Z").toZonedDateTimeISO(
        "Europe/London",
      ),
    );
    await using dir = await mkTmpDir();
    const files = [resolve(dir.path, "a.txt"), resolve(dir.path, "b.txt")];
    const args = {
      identity: "photos",
      dirs: [dir.path],
      files,
      excluded: [],
      getProps: props,
      resumeCommand: RESUME,
    };

    /** @type {string[]} */
    const seen = [];
    // The same name both times (the header carries it), so only the transform differs.
    const plain = await writeSnapshot(
      dir.path,
      momentOf("2026-06-23T1000"),
      args,
    );
    const plainText = zstdDecompressSync(readFileSync(plain)).toString("utf8");
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
    assert.equal(
      zstdDecompressSync(readFileSync(fused)).toString("utf8"),
      plainText,
    );
  });

  it("derives the #SNAPSHOT header datetime from the snapshot name", async () => {
    await using dir = await mkTmpDir();

    const path = await writeSnapshot(dir.path, momentOf("2026-06-23T1000"), {
      resumeCommand: RESUME,
      identity: "photos",
      dirs: [],
      files: [],
      excluded: [],
      getProps: props,
    });

    // Every spelling of the moment comes from the one `snapshotMoment` read the
    // caller made (ADR-0072), so the filename and the header cannot disagree.
    // The row keeps four columns: set, UTC instant, then the name and its zone.
    const text = zstdDecompressSync(readFileSync(path)).toString("utf8");
    const [header = ""] = text.split("\n");
    const [marker, identity, instant, nameAndZone] = header
      .split("\t")
      .map((field) => field.trim());

    assert.equal(marker, "#SNAPSHOT");
    assert.equal(identity, "photos");
    assert.equal(instant, "2026-06-23T09:00:00.000Z");
    assert.equal(nameAndZone, "2026-06-23T1000 Europe/London");
    // The instant lands in `mtime`'s own column, which is why it fits: an ISO
    // instant at millisecond precision is exactly the 24 characters col3 pads to.
    assert.equal(instant.length, 24);
  });

  it("closes a finished snapshot COMPLETE, timed by the clock seam as the last row lands", async (t) => {
    // The trailer times *itself*, which is the whole reason it is worth a
    // column: the header's instant is minted before the pass reads anything, so
    // it cannot vouch for a file whose ctime the reading moved (ADR-0085). The
    // read goes through format.mjs's clock seam — the one door the model
    // harness mocks — so pinning that clock pins the trailer, rounded up to the
    // millisecond (`completionInstant`'s rule, pinned in format.test.mjs). An
    // earlier shape compared against a real clock read and raced on macOS.
    await using dir = await mkTmpDir();
    t.mock.method(Temporal.Now, "zonedDateTimeISO", () =>
      Temporal.Instant.from(
        "2026-06-23T10:30:00.123456789Z",
      ).toZonedDateTimeISO("Europe/London"),
    );

    const path = await writeSnapshot(dir.path, momentOf("2026-06-23T1000"), {
      resumeCommand: RESUME,
      identity: "photos",
      dirs: [dir.path],
      files: [resolve(dir.path, "a.txt")],
      excluded: [],
      getProps: props,
    });

    const { status, completed } = await readSnapshotFile(path);
    assert.equal(status, "COMPLETE");
    assert.equal(completed, "2026-06-23T10:30:00.124Z");
  });

  it("refuses an existing same-name snapshot unless overwrite is set", async () => {
    await using dir = await mkTmpDir();
    /** @type {Parameters<typeof writeSnapshot>[2]} */
    const args = {
      identity: "photos",
      dirs: [dir.path],
      files: [],
      excluded: [],
      getProps: props,
      resumeCommand: RESUME,
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
    const first = withSnapshotFile(
      dir.path,
      "2026-06-23T1000",
      async (s) => {
        acquired.resolve(undefined);
        await gate.promise;
        s.end("x");
      },
      { resumeCommand: RESUME },
    );
    await acquired.promise;

    // Second run (different name, so it's the lock refusing, not the
    // same-minute check) must fail with the in-progress error.
    await assert.rejects(
      withSnapshotFile(dir.path, "2026-06-23T1001", async () => {}, {
        resumeCommand: RESUME,
      }),
      /already in progress/,
    );

    // Release the first run: it completes, and the rename that installs the
    // snapshot is also what releases the lock — no temp file remains.
    gate.resolve(undefined);
    const path = await first;
    assert.match(path, /2026-06-23T1000\.tsv\.zst$/);
    assert.ok(
      !existsSync(resolve(dir.path, ".snapshot.tsv.zst")),
      "success must release the lock (temp renamed away)",
    );
  });

  it("reports a stale lock (crashed run's leftover) with the exact fix", async () => {
    await using dir = await mkTmpDir();
    const tmpPath = resolve(dir.path, ".snapshot.tsv.zst");
    writeFileSync(tmpPath, "");

    await assert.rejects(
      withSnapshotFile(dir.path, "2026-06-23T1000", async () => {}, {
        resumeCommand: RESUME,
      }),
      (/** @type {Error} */ error) => {
        // ADR-0030: goal-framed headline, then the copy-pasteable fixes, gated
        // on nothing else running. Recovery leads (ADR-0092) — the file holds
        // the hashes the dead run had already worked out — and the delete
        // remains as the way to start the pass over.
        assert.match(error.message, /already in progress/);
        assert.match(error.message, /carry on from the file hashes/);
        assert.ok(
          error.message.includes(RESUME),
          "the fix must offer the given --resume",
        );
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
      withSnapshotFile(
        dir.path,
        "2026-06-23T1000",
        async () => {
          throw new Error("member directory vanished");
        },
        { resumeCommand: RESUME },
      ),
      /vanished/,
    );
    assert.ok(
      !existsSync(resolve(dir.path, ".snapshot.tsv.zst")),
      "a failed run must release the lock, not wedge the next one",
    );

    // The retry acquires cleanly and completes.
    const path = await withSnapshotFile(
      dir.path,
      "2026-06-23T1000",
      async (s) => {
        s.end("x");
      },
      { resumeCommand: RESUME },
    );
    assert.match(path, /2026-06-23T1000\.tsv\.zst$/);
  });
});

// Park-on-interrupt (ADR-0067): a graceful stop ends the writer cleanly and
// renames the work file aside as `.snapshot.lookup.tsv.zst`, so the next run
// reuses the hashes it holds instead of computing them again. Driven through
// `writeSnapshot` with a `getProps` that raises the signal part-way:
// `process.emit` invokes exactly the listener `withSnapshotFile` registers,
// without asking the OS to signal the test runner.
describe("withSnapshotFile (park on interrupt)", () => {
  const parkedPath = (/** @type {string} */ dir) =>
    resolve(dir, ".snapshot.lookup.tsv.zst");
  const lockPath = (/** @type {string} */ dir) =>
    resolve(dir, ".snapshot.tsv.zst");

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
      resumeCommand: RESUME,
      identity: "photos",
      dirs: [snapshotDir],
      files,
      excluded: [],
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
      !existsSync(resolve(dir.path, "2026-06-23T1000.tsv.zst")),
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

    // Exactly the rows hashed before the stop, and nothing half-written.
    const parked = await readParkedLookup(dir.path);
    assert.ok(parked);
    assert.deepEqual([...parked.entries.keys()], files.slice(0, 2));
    assert.equal(parked.entries.get(files[0] ?? "")?.hash, hashA);
    // The stopped run's start comes back with them — the change-time boundary
    // when there is no previous snapshot (ADR-0094).
    assert.equal(parked.instant, momentOf("2026-06-23T1000").instant);
  });

  it("ends the parked file on a whole row, never a torn one", async () => {
    await using dir = await mkTmpDir();

    await assert.rejects(
      write(dir.path, "2026-06-23T1000", paths(dir.path), interruptAfter(2)),
      InterruptedError,
    );

    // A clean `end()` flushes whole writes only, so the last byte is the
    // newline of the last complete row — a truncated row would not parse. The
    // trailer says PARTIAL: it is there because the stop was controlled, and it
    // must not read as a finished snapshot (ADR-0082).
    const text = zstdDecompressSync(
      readFileSync(parkedPath(dir.path)),
    ).toString("utf8");
    const trailer = text.split("\n").at(-2) ?? "";
    assert.match(
      trailer,
      /^#END\s+PARTIAL\t\d{4}-\d\d-\d\dT[\d:.]+Z\s*\t$/,
      `parked file must close with a PARTIAL #END trailer, got: ${JSON.stringify(trailer)}`,
    );
    for (const line of text.split("\n").filter(Boolean).slice(0, -1)) {
      assert.equal(line.split("\t").length, 4, `whole row expected: ${line}`);
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
    // is recorded as an #ERROR row and does not fail the run.)
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
      write(dir.path, "2026-06-23T1000", files, interruptAfter(1)),
      InterruptedError,
    );
    const first = await readParkedLookup(dir.path);
    assert.equal(first?.entries.size, 1);

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
    resolve(dir, ".snapshot.lookup.tsv.zst");

  /**
   * Park one row as a run that started at `instant` and was stopped with
   * Ctrl+C leaves it.
   * @param {string} dir
   * @param {string} instant
   */
  const parkRunStartedAt = (dir, instant) => {
    const text = [
      `#SNAPSHOT\tphotos\t${instant}\t2026-06-12T0915 Europe/London`,
      `${hashA}\t1\t2026-06-01T12:00:00.000Z\t${resolve(dir, "a.txt")}`,
      "#END\tPARTIAL\t2026-06-12T08:20:44.500Z\t",
    ].join("\n");
    writeFileSync(parkedPath(dir), zstdCompressSync(Buffer.from(text, "utf8")));
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
// trailer and a torn last row — where a graceful park leaves a closed file under
// the other name. `--resume` adopts it instead of throwing it away.
describe("recoverWorkFile", () => {
  const lockPath = (/** @type {string} */ dir) =>
    resolve(dir, ".snapshot.tsv.zst");
  const parkedPath = (/** @type {string} */ dir) =>
    resolve(dir, ".snapshot.lookup.tsv.zst");

  /**
   * Leave a work file exactly as a hard kill leaves one: header, whole rows,
   * then a row cut off mid-write. Built as bytes rather than by killing a real
   * write, so the artifact under test is pinned to the shape measured on a real
   * 280,277-file set — 272,692 whole rows, one torn line, no `#END`.
   * @param {string} dir
   * @param {string[]} files
   */
  const killedRun = (dir, files) => {
    const text = [
      "#SNAPSHOT\tphotos\t2026-06-12T08:15:32.123Z\t2026-06-12T0915 Europe/London",
      ...files.map(
        (path, i) => `${hashA}\t${i + 1}\t2026-06-01T12:00:00.000Z\t${path}`,
      ),
      `${hashA}\t2806546623\t2026-07-26T17:21:28`,
    ].join("\n");
    writeFileSync(lockPath(dir), zstdCompressSync(Buffer.from(text, "utf8")));
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

  it("recovers the rows of a frame its run never closed", async () => {
    // What a kill leaves on disk is a cut-short *frame*: the compressor had
    // written its finished blocks and not the one it was filling. `killedRun`
    // alone is a whole frame around a torn row. A one-block frame yields
    // nothing once cut, so this needs rows enough for several blocks.
    await using dir = await mkTmpDir();
    const files = Array.from({ length: 3000 }, (_, i) =>
      resolve(dir.path, `photo-${i}.jpg`),
    );
    killedRun(dir.path, files);
    const frame = readFileSync(lockPath(dir.path));
    writeFileSync(
      lockPath(dir.path),
      frame.subarray(0, Math.floor(frame.length * 0.9)),
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
    // No trailer, but the header is the first line a run writes, so the
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
        resumeCommand: RESUME,
        identity: "photos",
        dirs: [dir.path],
        files,
        excluded: [],
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
      resumeCommand: RESUME,
      identity: "photos",
      dirs: [dir.path],
      files,
      excluded: [],
      getProps: async () => ({
        size: 3,
        mtime: "2026-06-23T10:00:00.000Z",
        hash: hashA,
      }),
    });
    assert.match(path, /2026-06-23T1000\.tsv\.zst$/);
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
      resumeCommand: RESUME,
      identity: "photos",
      dirs: [dir],
      files: [resolve(dir, "a.txt")],
      excluded: [],
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

describe("the snapshot moment and its header (ADR-0072)", () => {
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

  it("reads the current header: set, instant, then name and zone", async () => {
    const text = [
      "#SNAPSHOT\tphotos\t2026-06-12T08:15:32.123Z\t2026-06-12T0915 Europe/London",
      "#DIR\t\t\t/home/me/Photos",
      `${hashA}\t12\t2026-06-01T12:00:00.000Z\t/home/me/Photos/beach.jpg`,
      "#END",
    ].join("\n");

    const { identity, instant, zone, dirs, entries } = await parse(text);
    assert.equal(identity, "photos");
    assert.equal(instant, "2026-06-12T08:15:32.123Z");
    assert.equal(zone, "Europe/London");
    assert.deepEqual(dirs, ["/home/me/Photos"]);
    assert.equal(entries.size, 1);
  });

  it("leaves the header fields absent when a snapshot carries no #SNAPSHOT line", async () => {
    // The row-only form the test fixture builder writes. Absent, not guessed —
    // which is why a consumer has to treat all three as optional.
    const text = [
      "#DIR\t\t\t/home/me/Photos",
      `${hashA}\t12\t2026-06-01T12:00:00.000Z\t/home/me/Photos/beach.jpg`,
      "#END",
    ].join("\n");

    const { identity, instant, zone, dirs, entries } = await parse(text);
    assert.equal(identity, undefined);
    assert.equal(instant, undefined);
    assert.equal(zone, undefined);
    assert.deepEqual(dirs, ["/home/me/Photos"]);
    assert.equal(entries.size, 1);
  });

  it("survives a header whose zone is missing", async () => {
    // A hand-edited file, or one truncated at col4. The name is the filename
    // anyway, so a missing zone costs the reader nothing it cannot recover.
    const text =
      "#SNAPSHOT\tphotos\t2026-06-12T08:15:32.123Z\t2026-06-12T0915\n#END";
    const { identity, instant, zone } = await parse(text);
    assert.equal(identity, "photos");
    assert.equal(instant, "2026-06-12T08:15:32.123Z");
    assert.equal(zone, undefined);
  });
});
