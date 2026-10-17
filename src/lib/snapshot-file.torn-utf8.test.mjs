import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { mkdtempDisposable } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { describe, it } from "node:test";
import { constants, gunzipSync, gzipSync } from "node:zlib";
import {
  parseCompressedSnapshotStream,
  readParkedLookup,
} from "./snapshot-file.mjs";
import { readBaseline } from "./snapshot.mjs";

/** @import { BackupSet } from "./sets.mjs" */

// A killed run's work file is gzip cut wherever the OS stopped writing, which
// can be between the two bytes of a character such as `é` in a path. The plain
// text cases are in snapshot-file.test.mjs; these cut a real gzip stream and
// read it through every reader that recovers a work file.

const hash = "a".repeat(64);
const HEADING =
  "@S3CAB\tFORMAT\tsize\ttime\thttps://s3cab.plantegral.com/guide/format";
const DIR = "@SET\tDIR\t\t\t/home/me/";
const START = "@SNAPSHOT\tSTART\t\t2026-06-12T08:15:32.123Z\tEurope/London";

/** @param {string} path @param {number} size */
const fileRow = (path, size) =>
  `-\t${hash}\t${size}\t2026-06-01T12:00:00.000Z\t${path}`;

// Distinct accented names, so the compressor emits mostly literals and many
// byte offsets of the gzip stream are candidate cuts.
let seed = 1;
const letters = "abcdefghijklmnopqrstuvwxyzéüñ";
const paths = Array.from({ length: 400 }, () => {
  const name = Array.from({ length: 24 }, () => {
    seed = (seed * 48271) % 2147483647;
    return letters[Math.floor((seed / 2147483647) * letters.length)];
  });
  return `/home/me/${name.join("")}.jpg`;
});
const text =
  [HEADING, DIR, START, ...paths.map((p, i) => fileRow(p, i + 1))].join("\n") +
  "\n";

// At `withSnapshotFile`'s settings, so the cut lands as it would in a work file.
const whole = gzipSync(Buffer.from(text), {
  level: 9,
  memLevel: 9,
  strategy: constants.Z_FILTERED,
});

/** What the tolerant gunzip gives for the first `cut` bytes of the stream. */
const inflate = (/** @type {number} */ cut) =>
  gunzipSync(whole.subarray(0, cut), { finishFlush: constants.Z_SYNC_FLUSH });

/** Whether `bytes` stop inside a character. */
const endsMidCharacter = (/** @type {Uint8Array} */ bytes) => {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return false;
  } catch {
    return true;
  }
};

/**
 * The paths a recovering read should keep from the first `cut` bytes: the rows
 * whose LF made it out of the decompressor.
 * @param {number} cut
 */
const rowsBefore = (cut) => {
  const inflated = inflate(cut);
  const rows = inflated
    .subarray(0, inflated.lastIndexOf(0x0a) + 1)
    .toString("utf8")
    .split("\n")
    .filter((line) => line.startsWith("-\t")).length;
  return paths.slice(0, rows);
};

// From the end, so that many whole rows precede the cut.
let tornAt = whole.length - 9;
while (tornAt > 20 && !endsMidCharacter(inflate(tornAt))) {
  tornAt--;
}
assert.ok(
  tornAt > 20,
  "fixture: no cut of the gzip stream lands inside a character",
);
const torn = whole.subarray(0, tornAt);
const expected = rowsBefore(tornAt);

describe("a work file cut inside a multi-byte character", () => {
  it("control: the same stream cut between characters reads fine", async () => {
    // Proves the fixture's only fault is where the cut lands.
    let cut = tornAt;
    while (endsMidCharacter(inflate(cut))) {
      cut--;
    }

    const { entries } = await parseCompressedSnapshotStream(
      Readable.from([whole.subarray(0, cut)]),
      { tolerant: true },
    );

    assert.deepEqual([...entries.keys()], rowsBefore(cut));
  });

  it("parseCompressedSnapshotStream (tolerant) keeps every row before the cut", async () => {
    const { entries } = await parseCompressedSnapshotStream(
      Readable.from([torn]),
      { tolerant: true },
    );

    assert.ok(expected.length > 0, "the fixture must leave whole rows");
    assert.deepEqual([...entries.keys()], expected);
  });

  it("readParkedLookup reads it", async () => {
    await using dir = await mkdtempDisposable(join("test", ".tmp"));
    writeFileSync(join(dir.path, ".snapshot.lookup.tsv.gz"), torn);

    const parked = await readParkedLookup(dir.path);

    assert.deepEqual([...(parked?.entries.keys() ?? [])], expected);
  });

  it("readBaseline (--resume) adopts it and carries on", async (t) => {
    await using dir = await mkdtempDisposable(join("test", ".tmp"));
    writeFileSync(join(dir.path, ".snapshot.tsv.gz"), torn);
    const warn = t.mock.method(console, "warn", () => {});
    const set = /** @type {BackupSet} */ (
      /** @type {unknown} */ ({ snapshotsDir: dir.path })
    );

    const baseline = await readBaseline(set, { resume: true });

    assert.deepEqual([...(baseline.lookup?.entries.keys() ?? [])], expected);
    assert.equal(warn.mock.callCount(), 1);
  });
});
