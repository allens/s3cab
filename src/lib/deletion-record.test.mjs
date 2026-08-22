import assert from "node:assert/strict";
import { beforeEach, describe, it, mock } from "node:test";

// The deletion-record module against a mocked s3.mjs seam (docs/design/testing.md:
// mock at s3.mjs, not the SDK): the slot allocator's write discipline
// (conditional PUT at the next free index, walking upward past a lost race),
// the read side's lenient-in-one-direction-only parsing, and compaction's
// merge-then-delete ordering — the crash-safety — plus the trimming rule it
// must never get wrong (ADR-0090). The record *format* is asserted directly on
// the returned string — it is a format-spec commitment (guide/format.md).
// Module-mock ordering (objects.test.mjs) applies: mocks first, dynamic import.

/** @type {{ Key?: string }[]} keys the mocked LIST yields at the bucket root */
let listed = [];
/** @type {Map<string, string | undefined>} uri → body for the mocked getText */
let bodies = new Map();
/**
 * Every write-side call in order — compaction's merge-before-delete promise is
 * an *ordering* fact, so the log keeps puts and deletes in one sequence.
 * @type {({ op: "put", uri: string, content: string, noClobber: boolean } | { op: "delete", uri: string })[]}
 */
let ops = [];
/** URIs the mocked bucket already holds, so a conditional PUT refuses them. */
let taken = new Set();
/** Whether *every* conditional PUT is refused, whatever the key. */
let putConflict = false;

mock.module("./s3.mjs", {
  exports: {
    listObjects: async function* () {
      yield* listed;
    },
    getText: async (/** @type {string} */ uri) => bodies.get(uri),
    putText: async (
      /** @type {string} */ uri,
      /** @type {string} */ content,
      /** @type {{ noClobber?: boolean }} */ { noClobber = false } = {},
    ) => {
      ops.push({ op: "put", uri, content, noClobber });
      return !(noClobber && (putConflict || taken.has(uri)));
    },
    deleteObject: async (/** @type {string} */ uri) => {
      ops.push({ op: "delete", uri });
    },
  },
});

const {
  compactDeletionRecords,
  formatDeletionRecord,
  parseDeletionRecord,
  readDeletionRecords,
  writeDeletionRecord,
} = await import("./deletion-record.mjs");

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);

const T1 = "2026-08-14T09:31:07.412Z";
const T2 = "2026-08-19T22:10:41.006Z";
const T3 = "2026-08-22T11:04:55.120Z";

const puts = () => ops.filter((o) => o.op === "put");
const deletes = () => ops.filter((o) => o.op === "delete");

/** Registers a record file under the mocked bucket `b`. */
const record = (/** @type {number} */ index, /** @type {string} */ body) => {
  listed.push({ Key: `objects.deleted-${index}.tsv` });
  bodies.set(`s3://b/objects.deleted-${index}.tsv`, body);
};

beforeEach(() => {
  listed = [];
  bodies = new Map();
  ops = [];
  taken = new Set();
  putConflict = false;
});

describe("formatDeletionRecord", () => {
  const rows = [
    { hash: HASH_B, size: 892, instant: T2, by: "allen@LAPTOP" },
    { hash: HASH_A, size: 1204, instant: T1, by: "allen@DESKTOP" },
  ];

  it("writes the #DELETED header, one row per object, and a bare #END trailer", () => {
    const text = formatDeletionRecord(T3, rows);
    const lines = text.split("\n");
    // The header row matches the snapshot column grammar positionally: col1
    // the #TAG, col2 empty (a header has no size), col3 the write instant,
    // col4 the one sentence a reader needs.
    assert.equal(
      lines[0],
      `#DELETED\t\t${T3}\tThese objects were removed on purpose. Absence here is not damage.`,
    );
    assert.equal(lines[1], `${HASH_A}\t1204\t${T1}\tallen@DESKTOP`);
    assert.equal(lines[2], `${HASH_B}\t892\t${T2}\tallen@LAPTOP`);
    // Bare trailer, deliberately: a record lands in one atomic uncompressed
    // PUT, so PARTIAL cannot occur and no status column carries over.
    assert.equal(lines[3], "#END");
    assert.ok(text.endsWith("#END\n"));
  });

  it("sorts rows by instant then hash, so a compacted file reads chronologically", () => {
    const text = formatDeletionRecord(T3, [
      { hash: HASH_B, size: 1, instant: T2, by: "x" },
      { hash: HASH_C, size: 1, instant: T1, by: "x" },
      { hash: HASH_A, size: 1, instant: T2, by: "x" },
    ]);
    const order = text
      .split("\n")
      .filter((line) => line && !line.startsWith("#"))
      .map((line) => line.slice(0, 64));
    assert.deepEqual(order, [HASH_C, HASH_A, HASH_B]);
  });
});

describe("parseDeletionRecord", () => {
  it("round-trips what formatDeletionRecord writes", () => {
    const rows = [
      { hash: HASH_A, size: 1204, instant: T1, by: "allen@DESKTOP" },
      { hash: HASH_B, size: 892, instant: T2, by: "allen@LAPTOP" },
    ];
    assert.deepEqual(parseDeletionRecord(formatDeletionRecord(T3, rows)), rows);
  });

  it("ignores rows whose first field is not a SHA-256 — lenient only in the safe direction", () => {
    // A mangled row must be *ignored*, never allowed to explain away a missing
    // object it doesn't actually name.
    const text =
      `not-a-hash\t1\t${T1}\tx\n` +
      `${HASH_A.slice(0, 63)}\t1\t${T1}\ttoo-short\n` +
      `${HASH_A}\t7\t${T1}\tallen@PC\n`;
    assert.deepEqual(parseDeletionRecord(text), [
      { hash: HASH_A, size: 7, instant: T1, by: "allen@PC" },
    ]);
  });

  it("keeps a row whose size is mangled (as 0) — deliberately-gone is the fact that must survive", () => {
    const text = `${HASH_A}\tgarbage\t${T1}\tallen@PC\n`;
    assert.deepEqual(parseDeletionRecord(text), [
      { hash: HASH_A, size: 0, instant: T1, by: "allen@PC" },
    ]);
  });
});

describe("writeDeletionRecord", () => {
  it("writes objects.deleted-1.tsv to an empty bucket, conditionally", async () => {
    const uri = await writeDeletionRecord("b", "#x\n");
    assert.equal(uri, "s3://b/objects.deleted-1.tsv");
    // Conditional always: a record of a destructive act is never overwritten.
    assert.deepEqual(puts(), [
      { op: "put", uri, content: "#x\n", noClobber: true },
    ]);
  });

  it("takes the index after the highest taken — holes are not reused", async () => {
    // A hole is usually a compacted-away file; writing into it would be legal
    // (the PUT is conditional) but monotone indexes keep the history readable.
    record(1, "#a\n");
    record(3, "#b\n");
    const uri = await writeDeletionRecord("b", "#x\n");
    assert.equal(uri, "s3://b/objects.deleted-4.tsv");
  });

  it("walks upward past an index another run took since the LIST", async () => {
    record(1, "#a\n");
    taken = new Set([
      "s3://b/objects.deleted-2.tsv",
      "s3://b/objects.deleted-3.tsv",
    ]);
    const uri = await writeDeletionRecord("b", "#x\n");
    assert.equal(uri, "s3://b/objects.deleted-4.tsv");
    // Still conditional on every retry: the walk disambiguates, it never
    // licenses an overwrite.
    assert.deepEqual(
      puts().map((p) => [p.uri, p.noClobber]),
      [
        ["s3://b/objects.deleted-2.tsv", true],
        ["s3://b/objects.deleted-3.tsv", true],
        ["s3://b/objects.deleted-4.tsv", true],
      ],
    );
  });

  it("ignores keys that don't follow the record grammar when allocating", async () => {
    listed.push({ Key: "objects.deleted-" }); // console folder marker
    listed.push({ Key: "objects.deleted-notes.txt" }); // stray hand-dropped file
    listed.push({ Key: "objects.deleted-0.tsv" }); // indexes start at 1
    const uri = await writeDeletionRecord("b", "#x\n");
    assert.equal(uri, "s3://b/objects.deleted-1.tsv");
  });

  it("gives up loudly if every index refuses, having deleted nothing", async () => {
    putConflict = true; // every conditional PUT refused
    await assert.rejects(
      () => writeDeletionRecord("b", "#x\n"),
      /shouldn't happen[\s\S]*Nothing was deleted/,
    );
  });
});

describe("readDeletionRecords", () => {
  it("returns an empty map for a repository that never ran delete", async () => {
    assert.deepEqual(await readDeletionRecords("b"), new Map());
  });

  it("unions rows across files; deletedOn is the row's instant", async () => {
    record(
      1,
      formatDeletionRecord(T1, [
        { hash: HASH_A, size: 1, instant: T1, by: "x" },
      ]),
    );
    record(
      2,
      formatDeletionRecord(T2, [
        { hash: HASH_B, size: 2, instant: T2, by: "y" },
      ]),
    );
    assert.deepEqual(
      await readDeletionRecords("b"),
      new Map([
        [HASH_A, { deletedOn: T1 }],
        [HASH_B, { deletedOn: T2 }],
      ]),
    );
  });

  it("keeps the newest instant for a hash recorded twice, whatever file order", async () => {
    // Deleted, re-backed-up, deleted again: the later row is the operative
    // fact. The newer row is registered in the *lower-indexed* file to prove
    // the row instants, not the file order, decide.
    record(1, `${HASH_A}\t1\t${T2}\tx\n`);
    record(2, `${HASH_A}\t1\t${T1}\tx\n`);
    const deleted = await readDeletionRecords("b");
    assert.equal(deleted.get(HASH_A)?.deletedOn, T2);
  });

  it("ignores keys that don't follow the record grammar", async () => {
    listed.push({ Key: "objects.deleted-" });
    listed.push({ Key: "objects.deleted-notes.txt" });
    record(1, `${HASH_A}\t1\t${T1}\tx\n`);
    const deleted = await readDeletionRecords("b");
    assert.deepEqual([...deleted.keys()], [HASH_A]);
  });

  it("skips a record that vanished between the LIST and the read", async () => {
    listed.push({ Key: "objects.deleted-1.tsv" }); // no body registered
    record(2, `${HASH_B}\t1\t${T1}\tx\n`);
    const deleted = await readDeletionRecords("b");
    assert.deepEqual([...deleted.keys()], [HASH_B]);
  });
});

describe("compactDeletionRecords", () => {
  it("does nothing for a repository with no record files", async () => {
    const result = await compactDeletionRecords("b", new Set());
    assert.deepEqual(result, { files: 0, rows: 0, trimmed: 0 });
    assert.deepEqual(ops, []);
  });

  it("leaves a single already-compact file alone", async () => {
    record(
      1,
      formatDeletionRecord(T1, [
        { hash: HASH_A, size: 1, instant: T1, by: "x" },
      ]),
    );
    const result = await compactDeletionRecords("b", new Set([HASH_A]));
    assert.deepEqual(result, { files: 0, rows: 1, trimmed: 0 });
    assert.deepEqual(ops, [], "no churn: nothing written, nothing deleted");
  });

  it("merges several files to a fresh index, then deletes the absorbed ones", async () => {
    record(
      1,
      formatDeletionRecord(T1, [
        { hash: HASH_A, size: 1, instant: T1, by: "x" },
      ]),
    );
    record(
      2,
      formatDeletionRecord(T2, [
        { hash: HASH_B, size: 2, instant: T2, by: "y" },
      ]),
    );
    const result = await compactDeletionRecords(
      "b",
      new Set([HASH_A, HASH_B]),
      { instant: T3 },
    );
    assert.deepEqual(result, { files: 2, rows: 2, trimmed: 0 });

    // The merge goes to the next free index — the absorbed files still exist
    // at allocation time, so the fresh file can never collide with them.
    assert.deepEqual(
      puts().map((p) => p.uri),
      ["s3://b/objects.deleted-3.tsv"],
    );
    assert.equal(
      puts()[0]?.content,
      formatDeletionRecord(T3, [
        { hash: HASH_A, size: 1, instant: T1, by: "x" },
        { hash: HASH_B, size: 2, instant: T2, by: "y" },
      ]),
    );

    // Write-before-delete is the crash-safety: every intermediate state holds
    // all rows somewhere, and a duplicated row is still just "deliberately
    // gone". The absorbed files go only after the merge landed.
    assert.equal(ops[0]?.op, "put");
    assert.deepEqual(
      deletes()
        .map((d) => d.uri)
        .sort(),
      ["s3://b/objects.deleted-1.tsv", "s3://b/objects.deleted-2.tsv"],
    );
  });

  it("drops rows whose hash no snapshot references — and keeps a referenced row even when its object is long gone", async () => {
    // The trimming invariant (ADR-0090): `referenced` is snapshot references,
    // *not* stored objects. HASH_A is referenced (its row is what verify and
    // restore will read — a deleted object's row is load-bearing precisely
    // while snapshots still reference it); HASH_B is referenced by nothing, so
    // nothing can ever ask about it and its row is dead.
    record(
      1,
      formatDeletionRecord(T1, [
        { hash: HASH_A, size: 1, instant: T1, by: "x" },
        { hash: HASH_B, size: 2, instant: T1, by: "x" },
      ]),
    );
    record(
      2,
      formatDeletionRecord(T2, [
        { hash: HASH_C, size: 3, instant: T2, by: "y" },
      ]),
    );
    const result = await compactDeletionRecords("b", new Set([HASH_A]), {
      instant: T3,
    });
    assert.deepEqual(result, { files: 2, rows: 1, trimmed: 2 });
    assert.equal(
      puts()[0]?.content,
      formatDeletionRecord(T3, [
        { hash: HASH_A, size: 1, instant: T1, by: "x" },
      ]),
    );
  });

  it("collapses identical rows duplicated across files (a crashed earlier merge)", async () => {
    const row = { hash: HASH_A, size: 1, instant: T1, by: "x" };
    record(1, formatDeletionRecord(T1, [row]));
    record(2, formatDeletionRecord(T2, [row]));
    const result = await compactDeletionRecords("b", new Set([HASH_A]), {
      instant: T3,
    });
    // Collapsing a duplicate is dedup, not trimming — `trimmed` counts only
    // rows dropped because no snapshot references them.
    assert.deepEqual(result, { files: 2, rows: 1, trimmed: 0 });
    assert.equal(puts()[0]?.content, formatDeletionRecord(T3, [row]));
  });

  it("rewrites even a single file when trimming shrinks it", async () => {
    record(
      1,
      formatDeletionRecord(T1, [
        { hash: HASH_A, size: 1, instant: T1, by: "x" },
        { hash: HASH_B, size: 2, instant: T1, by: "x" },
      ]),
    );
    const result = await compactDeletionRecords("b", new Set([HASH_A]), {
      instant: T3,
    });
    assert.deepEqual(result, { files: 1, rows: 1, trimmed: 1 });
    assert.deepEqual(
      puts().map((p) => p.uri),
      ["s3://b/objects.deleted-2.tsv"],
    );
    assert.deepEqual(
      deletes().map((d) => d.uri),
      ["s3://b/objects.deleted-1.tsv"],
    );
  });

  it("writes no merge when every row is dead — the steady state is no record at all", async () => {
    record(
      1,
      formatDeletionRecord(T1, [
        { hash: HASH_A, size: 1, instant: T1, by: "x" },
      ]),
    );
    record(
      2,
      formatDeletionRecord(T2, [
        { hash: HASH_B, size: 2, instant: T2, by: "y" },
      ]),
    );
    const result = await compactDeletionRecords("b", new Set(), {
      instant: T3,
    });
    assert.deepEqual(result, { files: 2, rows: 0, trimmed: 2 });
    assert.deepEqual(puts(), [], "a row nothing references needs no tombstone");
    assert.deepEqual(
      deletes()
        .map((d) => d.uri)
        .sort(),
      ["s3://b/objects.deleted-1.tsv", "s3://b/objects.deleted-2.tsv"],
    );
  });

  it("neither absorbs nor deletes a file that vanished since the LIST", async () => {
    // A concurrent compaction absorbed it: its rows live on in that run's
    // merge, which this run's LIST never saw — so it contributes no rows here
    // and, crucially, is not deleted (its key may reappear under a racer that
    // recreated it; only files this run actually read may go).
    listed.push({ Key: "objects.deleted-1.tsv" }); // no body registered
    record(
      2,
      formatDeletionRecord(T1, [
        { hash: HASH_A, size: 1, instant: T1, by: "x" },
      ]),
    );
    record(
      3,
      formatDeletionRecord(T2, [
        { hash: HASH_B, size: 2, instant: T2, by: "y" },
      ]),
    );
    const result = await compactDeletionRecords(
      "b",
      new Set([HASH_A, HASH_B]),
      { instant: T3 },
    );
    assert.deepEqual(result, { files: 2, rows: 2, trimmed: 0 });
    assert.deepEqual(
      puts().map((p) => p.uri),
      ["s3://b/objects.deleted-4.tsv"],
    );
    assert.deepEqual(
      deletes()
        .map((d) => d.uri)
        .sort(),
      ["s3://b/objects.deleted-2.tsv", "s3://b/objects.deleted-3.tsv"],
    );
  });
});
