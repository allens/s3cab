import assert from "node:assert/strict";
import { beforeEach, describe, it, mock } from "node:test";
import { s3Seam } from "../../test/helpers/s3-seam.mjs";

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

// A store with just enough behaviour to hold the record: a listing, bodies, a
// conditional PUT that can refuse, and a DELETE — the four operations the slot
// allocator and compaction are made of. Everything else is the stencil's.
mock.module("./s3.mjs", {
  exports: s3Seam({
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
  }),
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

/**
 * A hand-built `#deleted` row, unpadded: a reader trims the leading fields, so
 * the padding is the writer's business.
 */
const deletedRow = (
  /** @type {string} */ hash,
  /** @type {number|string} */ size,
  /** @type {string} */ instant,
  /** @type {string} */ by,
) => `#deleted\t${hash}\t${size}\t${instant}\t${by}\n`;

/** A record file around hand-built `rows`: the heading first, `.` last. */
const fileOf = (/** @type {string[]} */ ...rows) =>
  "@S3CAB\tFORMAT\tsize\ttime\thttps://s3cab.plantegral.com/guide/format\n" +
  rows.join("") +
  ".\n";

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

  it("writes the snapshot's heading and @S3CAB rows, a padded #deleted row per object, and the closing .", () => {
    const lines = formatDeletionRecord(rows).split("\n");
    assert.match(
      lines[0] ?? "",
      /^@S3CAB\tFORMAT +\t {8}size\ttime {20}\thttps:/,
    );
    assert.match(lines[1] ?? "", /^@S3CAB\tVERSION +\t +\t +\t\d/);
    assert.match(lines[2] ?? "", /^@S3CAB\tHOME +\t +\t +\t.+[\\/]$/);
    // `#deleted` overflows column 1's six; the columns after it still pad.
    assert.equal(
      lines[3],
      `#deleted\t${HASH_A}\t        1204\t${T1}\tallen@DESKTOP`,
    );
    assert.equal(
      lines[4],
      `#deleted\t${HASH_B}\t         892\t${T2}\tallen@LAPTOP`,
    );
    // No finish instant: each row has its own.
    assert.equal(lines[5], ".");
    assert.equal(lines[6], "", "ends with a newline");
    assert.equal(lines.length, 7);
  });

  it("sorts rows by instant then hash, so a compacted file reads chronologically", () => {
    const order = parseDeletionRecord(
      formatDeletionRecord([
        { hash: HASH_B, size: 1, instant: T2, by: "x" },
        { hash: HASH_C, size: 1, instant: T1, by: "x" },
        { hash: HASH_A, size: 1, instant: T2, by: "x" },
      ]),
    ).rows.map((row) => row.hash);
    assert.deepEqual(order, [HASH_C, HASH_A, HASH_B]);
  });

  it("spells out a tab or line ending in who deleted it", () => {
    const [row] = parseDeletionRecord(
      formatDeletionRecord([
        { hash: HASH_A, size: 1, instant: T1, by: "odd\tuser@PC" },
      ]),
    ).rows;
    assert.equal(row?.by, "odd␉user@PC");
  });
});

describe("parseDeletionRecord", () => {
  it("round-trips what formatDeletionRecord writes, as a valid file", () => {
    const rows = [
      { hash: HASH_A, size: 1204, instant: T1, by: "allen@DESKTOP" },
      { hash: HASH_B, size: 892, instant: T2, by: "allen@LAPTOP" },
    ];
    assert.deepEqual(parseDeletionRecord(formatDeletionRecord(rows)), {
      rows,
      invalid: undefined,
    });
  });

  it("skips the @ and # rows it doesn't know", () => {
    const { rows, invalid } = parseDeletionRecord(
      fileOf(
        `@S3CAB\tNEWS\t\t\tsomething\n#future\tthing\n`,
        deletedRow(HASH_C, 1, T1, "x"),
      ),
    );
    assert.deepEqual(
      rows.map((row) => row.hash),
      [HASH_C],
    );
    assert.equal(invalid, undefined);
  });

  // A refused row must never explain away a missing object: its content counts
  // as not deleted, the safe direction, and the file is invalid as a whole.
  for (const [name, row] of [
    ["a hash that isn't a SHA-256", deletedRow("not-a-hash", 1, T1, "x")],
    ["a short hash", deletedRow(HASH_A.slice(0, 63), 1, T1, "x")],
    ["a size that isn't a whole number", deletedRow(HASH_A, "1.5", T1, "x")],
    [
      "a time that isn't a UTC instant",
      deletedRow(HASH_A, 1, "2026-08-14", "x"),
    ],
  ]) {
    it(`refuses a #deleted row with ${name}, and the file is invalid`, () => {
      const { rows, invalid } = parseDeletionRecord(
        fileOf(String(row), deletedRow(HASH_B, 7, T1, "allen@PC")),
      );
      assert.deepEqual(rows, [
        { hash: HASH_B, size: 7, instant: T1, by: "allen@PC" },
      ]);
      assert.match(invalid ?? "", /a #deleted row is malformed/);
    });
  }

  for (const [
    name,
    text,
    reason,
  ] of /** @type {[string, string, RegExp][]} */ ([
    [
      "doesn't open with the heading",
      fileOf(deletedRow(HASH_A, 1, T1, "x")).replace(/^[^\n]*\n/, ""),
      /heading/,
    ],
    [
      "has no closing .",
      fileOf(deletedRow(HASH_A, 1, T1, "x")).replace(/\.\n$/, ""),
      /closing "\." line is missing/,
    ],
    [
      "ends in a . with no LF, as a PUT cut just after it",
      fileOf(deletedRow(HASH_A, 1, T1, "x")).slice(0, -1),
      /closing "\." line is missing/,
    ],
    [
      "ends in a line that is more than .",
      fileOf(deletedRow(HASH_A, 1, T1, "x")).replace(/\.\n$/, ". \n"),
      /closing line isn't exactly "\."/,
    ],
    [
      "has rows after the closing .",
      fileOf() + deletedRow(HASH_A, 1, T1, "x"),
      /rows follow/,
    ],
    [
      "holds a type starting with neither @ nor #",
      fileOf(`-\t${HASH_A}\t1\t${T1}\t/a.txt\n`),
      /unknown row type '-'/,
    ],
  ])) {
    it(`calls a file that ${name} invalid`, () => {
      assert.match(parseDeletionRecord(text).invalid ?? "", reason);
    });
  }
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
    assert.deepEqual(await readDeletionRecords("b"), {
      deleted: new Map(),
      invalid: [],
    });
  });

  it("names each invalid file, and still counts its well-formed rows", async () => {
    record(1, fileOf(deletedRow(HASH_A, 1, T1, "x")));
    record(2, fileOf(deletedRow(HASH_B, 1, T2, "x")).replace(/\.\n$/, ""));

    const { deleted, invalid } = await readDeletionRecords("b");

    assert.deepEqual([...deleted.keys()], [HASH_A, HASH_B]);
    assert.deepEqual(invalid, [
      {
        uri: "s3://b/objects.deleted-2.tsv",
        reason: 'the closing "." line is missing',
      },
    ]);
  });

  it("unions rows across files; deletedOn is the row's instant", async () => {
    record(
      1,
      formatDeletionRecord([{ hash: HASH_A, size: 1, instant: T1, by: "x" }]),
    );
    record(
      2,
      formatDeletionRecord([{ hash: HASH_B, size: 2, instant: T2, by: "y" }]),
    );
    const { deleted } = await readDeletionRecords("b");
    assert.deepEqual(
      deleted,
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
    record(1, fileOf(deletedRow(HASH_A, 1, T2, "x")));
    record(2, fileOf(deletedRow(HASH_A, 1, T1, "x")));
    const { deleted } = await readDeletionRecords("b");
    assert.equal(deleted.get(HASH_A)?.deletedOn, T2);
  });

  it("ignores keys that don't follow the record grammar", async () => {
    listed.push({ Key: "objects.deleted-" });
    listed.push({ Key: "objects.deleted-notes.txt" });
    record(1, fileOf(deletedRow(HASH_A, 1, T1, "x")));
    const { deleted } = await readDeletionRecords("b");
    assert.deepEqual([...deleted.keys()], [HASH_A]);
  });

  it("skips a record that vanished between the LIST and the read", async () => {
    listed.push({ Key: "objects.deleted-1.tsv" }); // no body registered
    record(2, fileOf(deletedRow(HASH_B, 1, T1, "x")));
    const { deleted, invalid } = await readDeletionRecords("b");
    assert.deepEqual([...deleted.keys()], [HASH_B]);
    assert.deepEqual(invalid, []);
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
      formatDeletionRecord([{ hash: HASH_A, size: 1, instant: T1, by: "x" }]),
    );
    const result = await compactDeletionRecords("b", new Set([HASH_A]));
    assert.deepEqual(result, { files: 0, rows: 1, trimmed: 0 });
    assert.deepEqual(ops, [], "no churn: nothing written, nothing deleted");
  });

  it("merges several files to a fresh index, then deletes the absorbed ones", async () => {
    record(
      1,
      formatDeletionRecord([{ hash: HASH_A, size: 1, instant: T1, by: "x" }]),
    );
    record(
      2,
      formatDeletionRecord([{ hash: HASH_B, size: 2, instant: T2, by: "y" }]),
    );
    const result = await compactDeletionRecords("b", new Set([HASH_A, HASH_B]));
    assert.deepEqual(result, { files: 2, rows: 2, trimmed: 0 });

    // The merge goes to the next free index — the absorbed files still exist
    // at allocation time, so the fresh file can never collide with them.
    assert.deepEqual(
      puts().map((p) => p.uri),
      ["s3://b/objects.deleted-3.tsv"],
    );
    assert.equal(
      puts()[0]?.content,
      formatDeletionRecord([
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
      formatDeletionRecord([
        { hash: HASH_A, size: 1, instant: T1, by: "x" },
        { hash: HASH_B, size: 2, instant: T1, by: "x" },
      ]),
    );
    record(
      2,
      formatDeletionRecord([{ hash: HASH_C, size: 3, instant: T2, by: "y" }]),
    );
    const result = await compactDeletionRecords("b", new Set([HASH_A]));
    assert.deepEqual(result, { files: 2, rows: 1, trimmed: 2 });
    assert.equal(
      puts()[0]?.content,
      formatDeletionRecord([{ hash: HASH_A, size: 1, instant: T1, by: "x" }]),
    );
  });

  it("collapses identical rows duplicated across files (a crashed earlier merge)", async () => {
    const row = { hash: HASH_A, size: 1, instant: T1, by: "x" };
    record(1, formatDeletionRecord([row]));
    record(2, formatDeletionRecord([row]));
    const result = await compactDeletionRecords("b", new Set([HASH_A]));
    // Collapsing a duplicate is dedup, not trimming — `trimmed` counts only
    // rows dropped because no snapshot references them.
    assert.deepEqual(result, { files: 2, rows: 1, trimmed: 0 });
    assert.equal(puts()[0]?.content, formatDeletionRecord([row]));
  });

  it("rewrites even a single file when trimming shrinks it", async () => {
    record(
      1,
      formatDeletionRecord([
        { hash: HASH_A, size: 1, instant: T1, by: "x" },
        { hash: HASH_B, size: 2, instant: T1, by: "x" },
      ]),
    );
    const result = await compactDeletionRecords("b", new Set([HASH_A]));
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
      formatDeletionRecord([{ hash: HASH_A, size: 1, instant: T1, by: "x" }]),
    );
    record(
      2,
      formatDeletionRecord([{ hash: HASH_B, size: 2, instant: T2, by: "y" }]),
    );
    const result = await compactDeletionRecords("b", new Set());
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
      formatDeletionRecord([{ hash: HASH_A, size: 1, instant: T1, by: "x" }]),
    );
    record(
      3,
      formatDeletionRecord([{ hash: HASH_B, size: 2, instant: T2, by: "y" }]),
    );
    const result = await compactDeletionRecords("b", new Set([HASH_A, HASH_B]));
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

  it("refuses to compact past an invalid file, writing and deleting nothing", async () => {
    // The merge keeps only parsed rows and then deletes the original, so a
    // refused row would be lost for good.
    record(1, fileOf(deletedRow(HASH_A, 1, T1, "x")));
    record(2, fileOf(deletedRow("not-a-hash", 1, T1, "x")));
    await assert.rejects(
      () => compactDeletionRecords("b", new Set([HASH_A])),
      /Not compacting: s3:\/\/b\/objects\.deleted-2\.tsv isn't valid/,
    );
    assert.deepEqual(ops, []);
  });
});
