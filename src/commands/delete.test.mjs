import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import { renderFind } from "../render.mjs";

// Offline tests for the whole of `delete` — the operand grammar and the policy
// wrapped around it, which live in one file because the grammar is private to
// the command: the loud non-hash error, the empty-file-hash refusal, the
// non-interactive gate, the preflight's reported-and-skipped missing hashes,
// the typed-bucket-name confirmation, and — most load-bearing — the
// record-FIRST-then-delete ordering (ADR-0089/0090). Every S3/prompt seam is
// faked at the lib boundary (docs/design/testing.md). Module-mock ordering
// (objects.test.mjs) applies: mocks first, dynamic import.
//
// The `--from-file` cases parse `renderFind`'s *real* output — the actual
// producer's bytes, warnings and all — rather than a hand-written imitation of
// ADR-0088's contract.

/** @type {Map<string, number>} hash → stored size for the mocked preflight HEAD */
let storedSizes = new Map();
/** How many preflight HEADs ran — the fail-before-paying evidence. */
let heads = 0;
/** @type {string[]} every side-effect, in order: "record" then "delete:<hash>" */
let effects = [];
/** @type {{ instant: string, rows: { hash: string, size: number, instant: string, by: string }[] } | undefined} */
let formatted;
/** @type {string[]} the command's stderr guidance, captured rather than printed */
let warnings = [];
/** @type {ReturnType<typeof mock.method>} */
let warn;
/** @type {ReturnType<typeof mock.method>} */
let log;
/** @type {string | undefined} what the prompt answers (undefined = no TTY expected) */
let promptAnswer;
let promptCalls = 0;

mock.module("../lib/objects.mjs", {
  exports: {
    storedObjectSize: async (
      /** @type {string} */ _bucket,
      /** @type {string} */ hash,
    ) => {
      heads++;
      return storedSizes.get(hash);
    },
    deleteStoredObject: async (
      /** @type {string} */ _bucket,
      /** @type {string} */ hash,
    ) => {
      effects.push(`delete:${hash}`);
    },
  },
});
mock.module("../lib/deletion-record.mjs", {
  exports: {
    formatDeletionRecord: (
      /** @type {string} */ instant,
      /** @type {{ hash: string, size: number, instant: string, by: string }[]} */ rows,
    ) => {
      formatted = { instant, rows };
      return `# record: ${rows.length} row(s)\n`;
    },
    writeDeletionRecord: async (/** @type {string} */ bucket) => {
      effects.push("record");
      return `s3://${bucket}/objects.deleted-1.tsv`;
    },
  },
});
mock.module("../lib/sets.mjs", {
  exports: {
    validateBucketName: () => {},
  },
});
mock.module("../lib/prompt.mjs", {
  exports: {
    promptLine: async () => {
      promptCalls++;
      assert.notEqual(promptAnswer, undefined, "unexpected prompt");
      return /** @type {string} */ (promptAnswer);
    },
  },
});

const { deleteHashes } = await import("./delete.mjs");

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);
const EMPTY =
  "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

// A real directory for --from-file's real file reads.
/** @type {string} */
let dir;

/**
 * A realistic FindResult, shaped as `find` builds it (lib/find.mjs typedefs):
 * two files in one set, one object also backing a path outside the search — the
 * dedup warning — plus an unreadable snapshot, so `renderFind` emits every
 * comment shape it can around the hash lines, warnings included.
 */
const findResult = {
  patterns: ["raw/"],
  searched: [{ name: "media", bucket: "b", snapshots: 3 }],
  files: [
    {
      path: "D:\\Media\\raw\\one.mov",
      objects: [
        {
          hash: HASH_A,
          size: 1204,
          mtime: "2026-08-14T09:31:07.412Z",
          spans: [
            {
              set: "media",
              first: "2026-08-14T0935",
              last: "2026-08-20T0900",
              count: 3,
            },
          ],
          alsoBacks: [],
        },
      ],
    },
    {
      path: "D:\\Media\\raw\\two.mov",
      objects: [
        {
          hash: HASH_B,
          size: 892,
          mtime: "2026-08-19T22:10:41.006Z",
          spans: [
            {
              set: "media",
              first: "2026-08-20T0900",
              last: "2026-08-20T0900",
              count: 1,
            },
          ],
          alsoBacks: ["D:\\Media\\other\\copy.mov"],
        },
      ],
    },
  ],
  unreadable: [
    { set: "media", snapshot: "2026-01-01T0000", reason: "truncated" },
  ],
};

/** @type {boolean | undefined} */
let savedTTY;
const stdin = /** @type {{ isTTY?: boolean }} */ (process.stdin);
beforeEach(() => {
  savedTTY = stdin.isTTY;
  stdin.isTTY = false;
  storedSizes = new Map([
    [HASH_A, 1204],
    [HASH_B, 892],
  ]);
  heads = 0;
  effects = [];
  formatted = undefined;
  promptAnswer = undefined;
  promptCalls = 0;
  dir = mkdtempSync(join(tmpdir(), "s3cab-delete-"));
  warnings = [];
  warn = mock.method(console, "warn", (/** @type {string} */ m) =>
    warnings.push(m),
  );
  log = mock.method(console, "log", () => {});
});
afterEach(() => {
  stdin.isTTY = savedTTY;
  warn.mock.restore();
  log.mock.restore();
  rmSync(dir, { recursive: true, force: true });
});

describe("delete command", () => {
  it("requires a bucket, and a hash or --from-file", async () => {
    await assert.rejects(
      () => deleteHashes([HASH_A]),
      /Missing required argument: bucket/,
    );
    await assert.rejects(
      () => deleteHashes([], { bucket: "b" }),
      /Missing required argument: hash/,
    );
  });

  it("errors loudly on anything that is not a hash — paths and snapshot names alike", async () => {
    // The stale-muscle-memory protection (ADR-0089): the old path operand and
    // the delete-a-snapshot habit both fail with the pointer at `find`,
    // before any S3 traffic.
    await assert.rejects(
      () =>
        deleteHashes(["D:\\Media\\secrets", "2026-07-19T1422"], {
          bucket: "b",
          force: true,
        }),
      /takes content hashes[\s\S]*D:\\Media\\secrets[\s\S]*2026-07-19T1422[\s\S]*s3cab find/,
    );
    assert.equal(heads, 0);
    assert.deepEqual(effects, []);
  });

  it("refuses the empty-file hash outright", async () => {
    await assert.rejects(
      () => deleteHashes([HASH_A, EMPTY], { bucket: "b", force: true }),
      /empty file's hash[\s\S]*every zero-byte file/,
    );
    assert.equal(heads, 0);
    assert.deepEqual(effects, []);
  });

  it("errors helpfully when the --from-file file doesn't exist", async () => {
    await assert.rejects(
      () =>
        deleteHashes([], {
          bucket: "b",
          force: true,
          "from-file": join(dir, "nope.txt"),
        }),
      /no file[\s\S]*nope\.txt[\s\S]*s3cab find/,
    );
  });

  it("errors when the --from-file file holds no hashes at all", async () => {
    const file = join(dir, "comments-only.txt");
    writeFileSync(file, "# everything was edited out\n\n");
    await assert.rejects(
      () => deleteHashes([], { bucket: "b", force: true, "from-file": file }),
      /No hashes to delete[\s\S]*comments-only\.txt/,
    );
  });

  it("refuses a non-interactive run without --force, before any S3 traffic", async () => {
    await assert.rejects(
      () => deleteHashes([HASH_A], { bucket: "b" }),
      /no terminal to ask on[\s\S]*--dry-run[\s\S]*--force/,
    );
    assert.equal(heads, 0); // fails in milliseconds, not after the preflight
  });

  it("writes the record BEFORE deleting, with the preflight's sizes in the rows", async () => {
    const result = await deleteHashes([HASH_A, HASH_B], {
      bucket: "b",
      force: true,
    });
    assert.equal(result.deleted, true);
    assert.equal(result.deletedObjects, 2);
    assert.equal(result.deletedBytes, 1204 + 892);
    assert.equal(result.record, "s3://b/objects.deleted-1.tsv");
    // Record-first is the crash-safety invariant: a run that dies mid-delete
    // must leave every missing object explained.
    assert.deepEqual(effects, [
      "record",
      `delete:${HASH_A}`,
      `delete:${HASH_B}`,
    ]);
    // The rows carry what the record needs: the preflight's ContentLength, one
    // shared instant, and who ran it.
    assert.ok(formatted);
    assert.deepEqual(
      formatted.rows.map(({ hash, size }) => ({ hash, size })),
      [
        { hash: HASH_A, size: 1204 },
        { hash: HASH_B, size: 892 },
      ],
    );
    for (const row of formatted.rows) {
      assert.equal(row.instant, formatted.instant);
      assert.match(row.by, /.+@.+/);
    }
    assert.ok(
      warnings.some((w) => w.includes("s3://b/objects.deleted-1.tsv")),
      "the closing line points at the record it just wrote",
    );
  });

  it("reports and skips hashes the bucket doesn't hold — not fatal", async () => {
    const result = await deleteHashes([HASH_A, HASH_C], {
      bucket: "b",
      force: true,
    });
    assert.equal(result.deleted, true);
    assert.deepEqual(result.missing, [HASH_C]);
    assert.deepEqual(effects, ["record", `delete:${HASH_A}`]);
    assert.ok(
      warnings.some((w) => w.includes("Skipping") && w.includes(HASH_C)),
      "the skipped hash is named on stderr",
    );
  });

  it("deletes nothing — and writes no record — when no named hash is stored", async () => {
    stdin.isTTY = true; // and never prompts, either
    const result = await deleteHashes([HASH_C], { bucket: "b" });
    assert.equal(result.deleted, false);
    assert.deepEqual(result.missing, [HASH_C]);
    assert.equal(promptCalls, 0);
    assert.deepEqual(effects, []);
  });

  it("dry run previews (preflight included) and touches nothing", async () => {
    const result = await deleteHashes([HASH_A, HASH_C], {
      bucket: "b",
      "dry-run": true,
    });
    assert.equal(result.deleted, false);
    assert.equal(result.deletedObjects, 1); // what WOULD go
    assert.deepEqual(result.missing, [HASH_C]);
    assert.equal(heads, 2); // the preview is the real preflight, not a guess
    assert.deepEqual(effects, []);
  });

  it("on a TTY, only the exact bucket name typed back proceeds", async () => {
    stdin.isTTY = true;
    promptAnswer = "B"; // close is not correct
    const declined = await deleteHashes([HASH_A], { bucket: "b" });
    assert.equal(declined.deleted, false);
    assert.equal(promptCalls, 1);
    assert.deepEqual(effects, []);

    promptAnswer = "b";
    const confirmed = await deleteHashes([HASH_A], { bucket: "b" });
    assert.equal(confirmed.deleted, true);
    assert.deepEqual(effects, ["record", `delete:${HASH_A}`]);
  });

  it("--force on a TTY skips the prompt but not the record", async () => {
    stdin.isTTY = true;
    const result = await deleteHashes([HASH_A], { bucket: "b", force: true });
    assert.equal(result.deleted, true);
    assert.equal(promptCalls, 0);
    assert.deepEqual(effects, ["record", `delete:${HASH_A}`]);
  });

  it("a hash named twice is one object — one HEAD, one delete", async () => {
    const result = await deleteHashes([HASH_A, HASH_A.toUpperCase()], {
      bucket: "b",
      force: true,
    });
    assert.equal(result.deletedObjects, 1);
    assert.equal(heads, 1);
    assert.deepEqual(effects, ["record", `delete:${HASH_A}`]);
  });

  it("--from-file reads find's real output and deletes exactly its hashes", async () => {
    // The producer's actual bytes (ADR-0088's contract), written the way
    // `s3cab find raw/ > hashes.txt` writes them — not an imitation. Every
    // comment shape, the warning lines included, is garnish the parse skips.
    const file = join(dir, "hashes.txt");
    writeFileSync(file, renderFind(findResult));
    const result = await deleteHashes([], {
      bucket: "b",
      force: true,
      "from-file": file,
    });
    assert.equal(result.deleted, true);
    assert.deepEqual(effects, [
      "record",
      `delete:${HASH_A}`,
      `delete:${HASH_B}`,
    ]);
  });

  it("errors loudly on a find file whose warnings are coloured", async () => {
    // A user redirecting on a forced-colour terminal keeps the ANSI codes, and
    // a painted warning line starts with the escape, not `#` — so it is no
    // longer a comment the parse skips. That must be loud rather than silently
    // passing as a hash: asserting the behaviour here so a change to it is a
    // decision, not an accident.
    const file = join(dir, "coloured.txt");
    writeFileSync(file, renderFind(findResult, { color: true }));
    await assert.rejects(
      () => deleteHashes([], { bucket: "b", force: true, "from-file": file }),
      (/** @type {Error} */ error) => {
        assert.match(error.message, /takes content hashes/);
        // Named verbatim, escapes and all, so the user sees what the file
        // actually holds rather than a sanitized guess at it.
        assert.ok(error.message.includes("\u001b["), error.message);
        return true;
      },
    );
    assert.equal(heads, 0);
    assert.deepEqual(effects, []);
  });

  it("takes column one of a tab-separated file — 'anything with hashes in column one'", async () => {
    const file = join(dir, "columns.tsv");
    writeFileSync(
      file,
      `${HASH_A}\t1204\tD:\\a.mov\n${HASH_B}\t892\tD:\\b.mov\n`,
    );
    const result = await deleteHashes([], {
      bucket: "b",
      force: true,
      "from-file": file,
    });
    assert.deepEqual(effects, [
      "record",
      `delete:${HASH_A}`,
      `delete:${HASH_B}`,
    ]);
    assert.equal(result.deletedObjects, 2);
  });

  it("merges positional and file hashes, de-duplicated across the two sources", async () => {
    // HASH_A arrives twice, once from each source, and is one object.
    const file = join(dir, "hashes.txt");
    writeFileSync(file, renderFind(findResult));
    const result = await deleteHashes([HASH_A], {
      bucket: "b",
      force: true,
      "from-file": file,
    });
    assert.equal(result.deletedObjects, 2);
    assert.equal(heads, 2);
    assert.deepEqual(effects, [
      "record",
      `delete:${HASH_A}`,
      `delete:${HASH_B}`,
    ]);
  });

  it("refuses the SHA-256 of zero bytes, derived rather than transcribed", async () => {
    // The refusal guards every zero-byte file in the repository, so what it
    // must match is the real digest of no bytes — not a sentinel someone typed.
    assert.equal(EMPTY, createHash("sha256").update("").digest("hex"));
    await assert.rejects(
      () => deleteHashes([EMPTY], { bucket: "b", force: true }),
      /empty file's hash/,
    );
  });
});
