import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtempDisposable } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Readable } from "node:stream";
import { describe, it } from "node:test";
import { zstdCompressSync, zstdDecompressSync } from "node:zlib";
import { InterruptedError } from "./error.mjs";
import {
  listSnapshotNames,
  normalizeSnapshotName,
  parseSnapshotStream,
  readParkedLookup,
  readSnapshot,
  snapshotFileName,
  snapshotMoment,
  snapshotName,
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

describe("snapshotName", () => {
  it("mints a minute-precision name the snapshot lister recognises", () => {
    const name = snapshotName();
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

  it("passes rows through `through` and writes the identical file (the fusion seam)", async () => {
    // ADR-0069: `backup` PUTs each object from this transform. The promise the seam
    // rests on is that inserting it changes *when* work happens, never what the
    // snapshot says — so the two files must be byte-identical.
    await using dir = await mkTmpDir();
    const files = [resolve(dir.path, "a.txt"), resolve(dir.path, "b.txt")];
    const args = {
      identity: "photos",
      dirs: [dir.path],
      files,
      excluded: [],
      getProps: props,
    };

    /** @type {string[]} */
    const seen = [];
    // The same name both times (the header carries it), so only the transform differs.
    const plain = await writeSnapshot(
      dir.path,
      momentOf("2026-06-23T1000"),
      args,
    );
    const withoutStage = readFileSync(plain);
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
    assert.deepEqual(readFileSync(fused), withoutStage);
  });

  it("derives the #SNAPSHOT header datetime from the snapshot name", async () => {
    await using dir = await mkTmpDir();

    const path = await writeSnapshot(dir.path, momentOf("2026-06-23T1000"), {
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

  it("refuses an existing same-name snapshot unless overwrite is set", async () => {
    await using dir = await mkTmpDir();
    /** @type {Parameters<typeof writeSnapshot>[2]} */
    const args = {
      identity: "photos",
      dirs: [dir.path],
      files: [],
      excluded: [],
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
      withSnapshotFile(dir.path, "2026-06-23T1000", async () => {}),
      (/** @type {Error} */ error) => {
        // ADR-0030: goal-framed headline, then the copy-pasteable fix naming
        // the actual file — gated on nothing else running.
        assert.match(error.message, /already in progress/);
        assert.match(error.message, /delete the file and retry/);
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
    const entries = await readParkedLookup(dir.path);
    assert.ok(entries);
    assert.deepEqual([...entries.keys()], files.slice(0, 2));
    assert.equal(entries.get(files[0] ?? "")?.hash, hashA);
  });

  it("ends the parked file on a whole row, never a torn one", async () => {
    await using dir = await mkTmpDir();

    await assert.rejects(
      write(dir.path, "2026-06-23T1000", paths(dir.path), interruptAfter(2)),
      InterruptedError,
    );

    // A clean `end()` flushes whole writes only, so the last byte is the
    // newline of the last complete row — a truncated row would not parse.
    const text = zstdDecompressSync(
      readFileSync(parkedPath(dir.path)),
    ).toString("utf8");
    assert.ok(
      text.endsWith("\n"),
      `parked file must end on a whole row, got: ${JSON.stringify(text.slice(-24))}`,
    );
    for (const line of text.split("\n").filter(Boolean)) {
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
    assert.equal(first?.size, 1);

    // The resumed run re-records the reused rows into its own work file, so its
    // parked file is a superset — and replacing must work on Windows too, where
    // a rename cannot land on an existing file.
    await assert.rejects(
      write(dir.path, "2026-06-23T1001", files, interruptAfter(3)),
      InterruptedError,
    );
    const second = await readParkedLookup(dir.path);
    assert.deepEqual([...(second?.keys() ?? [])], files.slice(0, 3));
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
});

describe("readParkedLookup", () => {
  it("returns undefined when nothing is parked (the ordinary case)", async () => {
    await using dir = await mkTmpDir();
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
    const text = "#SNAPSHOT\tphotos\t2026-06-12T08:15:32.123Z\t2026-06-12T0915";
    const { identity, instant, zone } = await parse(text);
    assert.equal(identity, "photos");
    assert.equal(instant, "2026-06-12T08:15:32.123Z");
    assert.equal(zone, undefined);
  });
});
