import assert from "node:assert/strict";
import { beforeEach, describe, it, mock } from "node:test";

// The deletion-record module against a mocked s3.mjs seam (docs/design/testing.md:
// mock at s3.mjs, not the SDK): the record's write discipline (conditional PUT,
// suffixing past a name already taken) and the read side's lenient-in-one-
// direction-only parsing. The record *format* is asserted directly on the
// returned string — it is a format-spec commitment (guide/format.md).
// Module-mock ordering (objects.test.mjs) applies: mocks first, dynamic import.

/** @type {{ Key?: string }[]} keys the mocked LIST yields under `deletions/` */
let listed = [];
/** @type {Map<string, string | undefined>} uri → body for the mocked getText */
let bodies = new Map();
/** @type {{ uri: string, content: string, noClobber: boolean }[]} */
let puts = [];
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
      puts.push({ uri, content, noClobber });
      return !(noClobber && (putConflict || taken.has(uri)));
    },
  },
});

const {
  deletionRecordMoment,
  formatDeletionRecord,
  readDeletionRecords,
  writeDeletionRecord,
} = await import("./deletion-record.mjs");

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

beforeEach(() => {
  listed = [];
  bodies = new Map();
  puts = [];
  taken = new Set();
  putConflict = false;
});

describe("deletionRecordMoment", () => {
  it("uses the snapshot-name grammar: minute-precision local time", () => {
    // One grammar for both timestamped artifacts (guide/format.md) — and minute
    // precision is what makes the same-minute conditional-PUT refusal the
    // collision story rather than a naming quirk.
    const { name, instant, zone } = deletionRecordMoment();
    assert.match(name, /^\d{4}-\d{2}-\d{2}T\d{4}$/);
    // …and the same UTC instant + zone every timestamped artifact records
    // (ADR-0072), so the record can be resolved to a moment, not just ordered.
    assert.match(instant, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    assert.ok(zone.length > 0);
  });
});

describe("formatDeletionRecord", () => {
  const context = {
    generated: "2026-07-19T1422",
    bucket: "my-backups",
    by: "allen@DESKTOP",
    sets: ["media", "photos"],
    paths: ["D:\\Media\\raw", "D:\\Media\\old"],
    everywhere: false,
    totals: { files: 3, bytes: 2048, objects: 2 },
  };
  const rows = [
    { hash: HASH_A, path: "D:\\Media\\raw\\a.mov" },
    { hash: HASH_B, path: "D:\\Media\\raw\\b.mov" },
  ];

  it("writes the header context, the totals, and one hash<TAB>path row per reference", () => {
    const text = formatDeletionRecord(context, rows);
    assert.match(text, /^# s3cab delete — content deliberately removed/);
    assert.match(text, /# generated: {2}2026-07-19T1422\n/);
    assert.match(text, /# bucket: {5}my-backups\n/);
    assert.match(text, /# by: {9}allen@DESKTOP\n/);
    assert.match(text, /# sets: {7}media, photos\n/);
    assert.match(text, /# scope: {6}the sets above only\n/);
    // Every named path is in the header, first labelled, the rest aligned.
    assert.match(text, /# paths: {6}D:\\Media\\raw\n# {13}D:\\Media\\old\n/);
    assert.match(text, /# 3 files, holding 2\.0kB across 2 stored objects\.\n/);
    assert.ok(text.includes(`${HASH_A}\tD:\\Media\\raw\\a.mov\n`));
    assert.ok(text.includes(`${HASH_B}\tD:\\Media\\raw\\b.mov\n`));
    assert.ok(text.endsWith("\n"));
  });

  it("names the everywhere scope when protection was overridden", () => {
    const text = formatDeletionRecord({ ...context, everywhere: true }, rows);
    assert.match(
      text,
      /# scope: {6}everywhere \(every reference, all sets\)\n/,
    );
  });
});

describe("writeDeletionRecord", () => {
  it("PUTs conditionally (never overwrite a record) and returns the URI", async () => {
    const uri = await writeDeletionRecord(
      "my-backups",
      "2026-07-19T1422",
      "#x\n",
    );
    assert.equal(uri, "s3://my-backups/deletions/2026-07-19T1422.tsv");
    assert.deepEqual(puts, [{ uri, content: "#x\n", noClobber: true }]);
  });

  // Two deletes in one minute are two real events and both must be recorded.
  // Unlike a snapshot, the name is read by nobody — `readDeletionRecords` LISTs
  // and unions — so it only has to be unique, and refusing bought no safety.
  it("suffixes past a name already taken, so a same-minute delete records", async () => {
    taken = new Set(["s3://my-backups/deletions/2026-07-19T1422.tsv"]);
    const uri = await writeDeletionRecord(
      "my-backups",
      "2026-07-19T1422",
      "#x\n",
    );
    assert.equal(uri, "s3://my-backups/deletions/2026-07-19T1422-2.tsv");
    // Still conditional on the retry: the suffix disambiguates, it never
    // licenses an overwrite.
    assert.deepEqual(
      puts.map((p) => [p.uri, p.noClobber]),
      [
        ["s3://my-backups/deletions/2026-07-19T1422.tsv", true],
        ["s3://my-backups/deletions/2026-07-19T1422-2.tsv", true],
      ],
    );
  });

  it("keeps counting when several records share the minute", async () => {
    taken = new Set([
      "s3://my-backups/deletions/2026-07-19T1422.tsv",
      "s3://my-backups/deletions/2026-07-19T1422-2.tsv",
      "s3://my-backups/deletions/2026-07-19T1422-3.tsv",
    ]);
    const uri = await writeDeletionRecord(
      "my-backups",
      "2026-07-19T1422",
      "#x\n",
    );
    assert.equal(uri, "s3://my-backups/deletions/2026-07-19T1422-4.tsv");
  });

  it("gives up loudly if every name is taken, having deleted nothing", async () => {
    putConflict = true; // every conditional PUT refused
    await assert.rejects(
      () => writeDeletionRecord("my-backups", "2026-07-19T1422", "#x\n"),
      /shouldn't happen[\s\S]*Nothing was deleted/,
    );
  });
});

describe("readDeletionRecords", () => {
  /** Registers a record file under the mocked bucket. */
  const record = (/** @type {string} */ name, /** @type {string} */ body) => {
    listed.push({ Key: `deletions/${name}.tsv` });
    bodies.set(`s3://b/deletions/${name}.tsv`, body);
  };

  it("returns an empty map for a repository that never ran delete", async () => {
    assert.deepEqual(await readDeletionRecords("b"), new Map());
  });

  it("collects hashes across records, skipping comments and blank lines", async () => {
    record(
      "2026-07-19T1422",
      `# header\n#\n${HASH_A}\tD:\\a.mov\n\n${HASH_B}\tD:\\b.mov\n`,
    );
    const deleted = await readDeletionRecords("b");
    assert.deepEqual(
      deleted,
      new Map([
        [HASH_A, { deletedOn: "2026-07-19T1422" }],
        [HASH_B, { deletedOn: "2026-07-19T1422" }],
      ]),
    );
  });

  it("keeps the newest record's date for a hash deleted twice", async () => {
    // Deleted, re-backed-up, deleted again: the later record is the operative
    // fact. Registered newest-first to prove the sort, not the LIST order, decides.
    record("2026-07-19T1422", `${HASH_A}\tD:\\again.mov\n`);
    record("2026-01-01T0900", `${HASH_A}\tD:\\first.mov\n`);
    const deleted = await readDeletionRecords("b");
    assert.equal(deleted.get(HASH_A)?.deletedOn, "2026-07-19T1422");
  });

  it("ignores rows whose first field is not a SHA-256 — lenient only in the safe direction", async () => {
    // A mangled row must be *ignored*, never allowed to explain away a missing
    // object it doesn't actually name.
    record(
      "2026-07-19T1422",
      `not-a-hash\tD:\\x\n${HASH_A.slice(0, 63)}\ttoo-short\n${HASH_A}\tD:\\ok\n`,
    );
    const deleted = await readDeletionRecords("b");
    assert.deepEqual([...deleted.keys()], [HASH_A]);
  });

  it("ignores keys that don't follow the record-name grammar", async () => {
    listed.push({ Key: "deletions/" }); // console folder marker
    listed.push({ Key: "deletions/notes.txt" }); // a stray hand-dropped file
    listed.push({ Key: "deletions/2026-07-19T1422-.tsv" }); // suffix with no number
    record("2026-07-19T1422", `${HASH_A}\tD:\\ok\n`);
    const deleted = await readDeletionRecords("b");
    assert.deepEqual([...deleted.keys()], [HASH_A]);
  });

  // The other half of the same-minute fix: a suffixed record is a real record,
  // so the read side must union it in. Missing it would leave hashes the store
  // deliberately deleted looking like unexplained damage to `verify`.
  it("reads a same-minute suffixed record alongside the unsuffixed one", async () => {
    record("2026-07-19T1422", `${HASH_A}\tD:\\a.mov\n`);
    record("2026-07-19T1422-2", `${HASH_B}\tD:\\b.mov\n`);
    const deleted = await readDeletionRecords("b");
    assert.deepEqual([...deleted.keys()].sort(), [HASH_A, HASH_B]);
    assert.equal(deleted.get(HASH_B)?.deletedOn, "2026-07-19T1422-2");
  });

  it("skips a record that vanished between the LIST and the read", async () => {
    listed.push({ Key: "deletions/2026-07-19T1422.tsv" }); // no body registered
    record("2026-07-19T1423", `${HASH_B}\tD:\\ok\n`);
    const deleted = await readDeletionRecords("b");
    assert.deepEqual([...deleted.keys()], [HASH_B]);
  });
});
