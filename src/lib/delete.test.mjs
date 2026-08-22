import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderFind } from "../render.mjs";
import { collectHashes, EMPTY_FILE_HASH } from "./delete.mjs";

// The operand grammar of the hash-operand `delete` (ADR-0089): exactness is
// the safety story — anything that is not a SHA-256 is rejected data for the
// command's loud error, never a guess — while `find`'s comment garnish is the
// one lenient direction. The `--from-file` cases therefore parse `renderFind`'s
// *real* output (the actual producer's bytes, warnings and all), not a
// hand-written imitation of it.

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);

/**
 * A realistic FindResult, shaped as `find` builds it (lib/find.mjs typedefs):
 * two files in one set, one object shared with a path outside the search — the
 * dedup warning case — plus an unreadable snapshot, so the file exercises every
 * comment shape `renderFind` can emit around the hash lines.
 */
const findResult = {
  patterns: ["secretsdir/"],
  searched: [{ name: "media", bucket: "my-backups", snapshots: 12 }],
  files: [
    {
      path: "D:\\Media\\secretsdir\\aws-keys.txt",
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
              count: 7,
            },
          ],
          alsoBacks: [],
        },
      ],
    },
    {
      path: "D:\\Media\\secretsdir\\backup.env",
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
          alsoBacks: ["D:\\Media\\other\\copy.env"],
        },
      ],
    },
  ],
  unreadable: [
    { set: "media", snapshot: "2026-01-01T0000", reason: "truncated" },
  ],
};

describe("collectHashes", () => {
  it("accepts positional hashes, folding case and de-duplicating", () => {
    const { hashes, rejected } = collectHashes([
      HASH_A.toUpperCase(),
      HASH_B,
      HASH_A,
    ]);
    assert.deepEqual(hashes, [HASH_A, HASH_B]);
    assert.deepEqual(rejected, []);
  });

  it("rejects anything that is not 64 hex characters, verbatim", () => {
    // The stale-muscle-memory cases (ADR-0089): a path, a snapshot name, a
    // truncated hash — each must surface for the loud error, never be guessed.
    const { hashes, rejected } = collectHashes([
      "D:\\Media\\secretsdir",
      "2026-07-19T1422",
      HASH_A.slice(0, 63),
      HASH_A,
    ]);
    assert.deepEqual(hashes, [HASH_A]);
    assert.deepEqual(rejected, [
      "D:\\Media\\secretsdir",
      "2026-07-19T1422",
      HASH_A.slice(0, 63),
    ]);
  });

  it("parses find's real output: every hash, none of the comments", () => {
    // The producing end of the contract (ADR-0088: one hash per line,
    // everything else a `#` comment) — rendered by the real renderer, warnings
    // included, exactly as `s3cab find secretsdir/ > hashes.txt` writes it.
    const text = renderFind(findResult);
    const { hashes, rejected } = collectHashes([], text);
    assert.deepEqual(hashes, [HASH_A, HASH_B]);
    assert.deepEqual(rejected, []);
  });

  it("still parses find's output when its warnings are coloured", () => {
    // A user redirecting on a forced-colour terminal keeps the ANSI codes; the
    // warning lines are still `#` comments underneath... but painted ones start
    // with the escape, not `#`. Those lines must land in `rejected` (loud)
    // rather than silently passing as hashes — asserting the actual behaviour
    // here so a change to it is a decision, not an accident.
    const text = renderFind(findResult, { color: true });
    const { hashes, rejected } = collectHashes([], text);
    assert.deepEqual(hashes, [HASH_A, HASH_B]);
    // The two coloured warning lines (dedup + unreadable header) reject; the
    // plain comment lines and hashes are unaffected.
    assert.equal(rejected.length, 2);
    for (const line of rejected) {
      assert.ok(line.startsWith("\u001b["), `keeps its escape: ${line}`);
    }
  });

  it("takes column one of a tab-separated file — 'anything with hashes in column one'", () => {
    const text = `${HASH_A}\t1204\tD:\\a.mov\n` + `${HASH_B}\t892\tD:\\b.mov\n`;
    const { hashes, rejected } = collectHashes([], text);
    assert.deepEqual(hashes, [HASH_A, HASH_B]);
    assert.deepEqual(rejected, []);
  });

  it("merges positional and file hashes, de-duplicated across sources", () => {
    const { hashes } = collectHashes([HASH_C, HASH_A], renderFind(findResult));
    assert.deepEqual(hashes, [HASH_C, HASH_A, HASH_B]);
  });

  it("skips blank lines and comments; an edited-down file of nothing yields nothing", () => {
    const { hashes, rejected } = collectHashes(
      [],
      "# kept the comments\n\n#\n",
    );
    assert.deepEqual(hashes, []);
    assert.deepEqual(rejected, []);
  });

  it("knows the empty-file hash (the refusal is the command's, the constant lives here)", () => {
    // Pin the value itself: it is the SHA-256 of zero bytes, not a made-up
    // sentinel, and the refusal guards every zero-byte file in the repository.
    assert.equal(
      EMPTY_FILE_HASH,
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
    const { hashes } = collectHashes([EMPTY_FILE_HASH]);
    assert.deepEqual(hashes, [EMPTY_FILE_HASH]);
  });
});
