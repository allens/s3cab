import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { mkdtempDisposable } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { describe, it } from "node:test";
import { constants, gunzipSync, gzipSync } from "node:zlib";
import {
  parseCompressedSnapshotStream,
  parseSnapshotStream,
  readParkedLookup,
} from "./snapshot-file.mjs";
import { readBaseline } from "./snapshot.mjs";

/** @import { BackupSet } from "./sets.mjs" */

// A killed run's work file is cut wherever the OS stopped writing, which can be
// between the two bytes of a character such as `é` in a path. The tolerant read
// drops that torn tail with the LF-less last line; a strict read still refuses it.

const hash = "a".repeat(64);
const HEADING =
  "@S3CAB\tFORMAT\tsize\ttime\thttps://s3cab.plantegral.com/guide/format";
const DIR = "@SET\tDIR\t\t\t/home/me/";
const START = "@SNAPSHOT\tSTART\t\t2026-06-12T08:15:32.123Z\tEurope/London";

/** @param {string} path @param {number} size */
const fileRow = (path, size) =>
  `-\t${hash}\t${size}\t2026-06-01T12:00:00.000Z\t${path}`;

// Distinct accented names, so the compressor emits mostly literals (a repeated
// name is a long match, and a cut inside one never lands between an `é`'s bytes).
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

/**
 * Whether `bytes` stop inside a character.
 * @param {Uint8Array} bytes
 */
const endsMidCharacter = (bytes) => {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return false;
  } catch {
    return true;
  }
};

/**
 * A work file as the backup pass writes it (gzip at the settings of
 * `withSnapshotFile`), cut at the first byte offset where the tolerant gunzip's
 * output stops inside a character.
 */
const tornWorkFile = () => {
  const whole = gzipSync(Buffer.from(text), {
    level: 9,
    memLevel: 9,
    strategy: constants.Z_FILTERED,
  });
  // From the end, so that many whole rows precede the cut.
  for (let cut = whole.length - 9; cut > 20; cut--) {
    const torn = whole.subarray(0, cut);
    const inflated = gunzipSync(torn, { finishFlush: constants.Z_SYNC_FLUSH });
    if (endsMidCharacter(inflated)) {
      return torn;
    }
  }
  throw new Error(
    "fixture: no cut of the gzip stream lands inside a character",
  );
};

/** The whole rows before the cut, as paths. */
const recoveredPaths = (/** @type {Map<string, unknown>} */ entries) => [
  ...entries.keys(),
];

describe("a work file cut inside a multi-byte character", () => {
  it("control: the same stream cut between characters reads fine", async () => {
    // Proves the fixture's only fault is where the cut lands.
    const whole = gzipSync(Buffer.from(text), {
      level: 9,
      memLevel: 9,
      strategy: constants.Z_FILTERED,
    });
    let cut = tornWorkFile().length;
    while (
      endsMidCharacter(
        gunzipSync(whole.subarray(0, cut), {
          finishFlush: constants.Z_SYNC_FLUSH,
        }),
      )
    ) {
      cut--;
    }

    const { entries } = await parseCompressedSnapshotStream(
      Readable.from([whole.subarray(0, cut)]),
      { tolerant: true },
    );

    assert.ok(entries.size > 0);
  });

  // The bytes of `é` are C3 A9; the file stops after C3.
  const tornText = Buffer.concat([
    Buffer.from(
      [
        HEADING,
        DIR,
        fileRow("/home/me/a.txt", 1),
        "-\tx\t1\tx\t/home/me/caf",
      ].join("\n"),
    ),
    Buffer.from([0xc3]),
  ]);

  it("parseSnapshotStream (tolerant) drops the torn tail", async () => {
    const { entries } = await parseSnapshotStream(Readable.from([tornText]), {
      tolerant: true,
    });

    assert.deepEqual(recoveredPaths(entries), ["/home/me/a.txt"]);
  });

  it("parseSnapshotStream (strict) still refuses it as not UTF-8", async () => {
    await assert.rejects(
      parseSnapshotStream(Readable.from([tornText])),
      /isn't UTF-8/,
    );
  });

  it("parseCompressedSnapshotStream (tolerant) reads a gzip cut inside a character", async () => {
    const torn = tornWorkFile();

    const { entries } = await parseCompressedSnapshotStream(
      Readable.from([torn]),
      { tolerant: true },
    );

    const recovered = recoveredPaths(entries);
    assert.ok(recovered.length > 0, "the rows before the cut must survive");
    assert.deepEqual(recovered, paths.slice(0, recovered.length));
  });

  it("readParkedLookup reads it", async () => {
    await using dir = await mkdtempDisposable(join("test", ".tmp"));
    writeFileSync(join(dir.path, ".snapshot.lookup.tsv.gz"), tornWorkFile());

    const parked = await readParkedLookup(dir.path);

    assert.ok((parked?.entries.size ?? 0) > 0);
  });

  it("readBaseline (--resume) adopts it and carries on", async () => {
    await using dir = await mkdtempDisposable(join("test", ".tmp"));
    writeFileSync(join(dir.path, ".snapshot.tsv.gz"), tornWorkFile());
    const set = /** @type {BackupSet} */ (
      /** @type {unknown} */ ({ snapshotsDir: dir.path })
    );

    const baseline = await readBaseline(set, { resume: true });

    assert.ok((baseline.lookup?.entries.size ?? 0) > 0);
  });
});
