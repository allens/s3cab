import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { describe, it, mock } from "node:test";
import { gzipSync } from "node:zlib";
import { s3Seam } from "../../test/helpers/s3-seam.mjs";
import { HEADING } from "./snapshot-file.mjs";

/** @import { _Object } from "@aws-sdk/client-s3" */

// The scan's one job is the *order* of its three reads (see the module header),
// so that is what this pins — through the real remote.mjs / objects.mjs /
// deletion-record.mjs, under one fake of the s3.mjs seam that records each
// LIST as it starts. Faking the three lib modules instead would prove only
// that this module calls three functions in a row; faking s3.mjs proves the
// requests the bucket sees arrive in the safe order. The live proof for
// cleanup is test/crash/concurrency.test.mjs ("cleanup vs forget is safe"),
// which parks the real binary between reads 1 and 2. Mocks first, then a
// dynamic import.

/** Every LIST prefix asked for, in the order the requests began. */
/** @type {string[]} */
let listed = [];
/** What each prefix's LIST yields — keys; sizes, classes and ETags where set. */
/** @type {Record<string, _Object[]>} */
let keysByPrefix = {};
/** The deletion record's body, when a test stores one. */
/** @type {Record<string, string>} */
let textByUri = {};
/** Set by a test to fail the objects LIST after it has begun. */
/** @type {Error | undefined} */
let objectsListFailure;
/**
 * A snapshot body read. The default is the seam's own: absent, which the scan
 * treats as vanished-mid-scan and skips — enough to exercise the snapshot
 * phase without a real gzip body. One test replaces it to hold a read open.
 * @type {(uri: string) => Promise<Readable>}
 */
let onGetStream = vanished;

/** @param {string} uri @returns {Promise<never>} */
async function vanished(uri) {
  throw Object.assign(new Error(uri), { name: "NoSuchKey" });
}

mock.module("./s3.mjs", {
  exports: s3Seam({
    listObjects: async function* (/** @type {string} */ uri) {
      const prefix = uri.slice("s3://b/".length);
      listed.push(prefix);
      if (prefix === "objects/" && objectsListFailure) {
        throw objectsListFailure;
      }
      yield* keysByPrefix[prefix] ?? [];
    },
    getStream: (/** @type {string} */ uri) => onGetStream(uri),
    getBytes: async (/** @type {string} */ uri) => {
      const text = textByUri[uri];
      return text === undefined ? undefined : Buffer.from(text);
    },
  }),
});
const { scanBucket } = await import("./bucket-scan.mjs");

const reset = () => {
  listed = [];
  keysByPrefix = {};
  textByUri = {};
  objectsListFailure = undefined;
  onGetStream = vanished;
};

describe("scanBucket", () => {
  it("reads snapshots, then objects, then the deletion record — in that order, each after the last", async () => {
    reset();
    // Every read has something to find, so the order is not an artifact of an
    // empty phase returning early.
    keysByPrefix = {
      "snapshots/": [
        { Key: "snapshots/photos/20260612T0915.tsv.gz", ETag: '"e1"' },
      ],
      "objects/": [{ Key: "objects/aaa", Size: 10, StorageClass: "STANDARD" }],
      "objects.deleted-": [{ Key: "objects.deleted-1.tsv" }],
    };
    textByUri["s3://b/objects.deleted-1.tsv"] =
      "@S3CAB\tFORMAT\tsize\ttime\thttps://s3cab.plantegral.com/guide/format\n" +
      `#deleted\t${"b".repeat(64)}\t7\t2026-08-22T11:04:55.120Z\tallen@DESKTOP\n` +
      ".\n";
    onGetStream = async () => Readable.from([gzipSync(HEADING + ".\n")]);

    const scan = await scanBucket("b");

    assert.deepEqual(listed, [
      "snapshots/",
      ".s3cab/sets/",
      "objects/",
      "objects.deleted-",
    ]);
    assert.deepEqual([...scan.referencedBySet.keys()], ["photos"]);
    // The listing the top-up will diff against: every key, by set, with the
    // bytes' identity.
    assert.deepEqual(
      scan.snapshotFiles,
      new Map([["photos", new Map([["20260612T0915.tsv.gz", '"e1"']])]]),
    );
    assert.deepEqual(
      scan.stored,
      new Map([["aaa", { size: 10, storageClass: "STANDARD" }]]),
    );
    assert.deepEqual(
      scan.deleted,
      new Map([["b".repeat(64), { deletedOn: "2026-08-22T11:04:55.120Z" }]]),
    );
    assert.deepEqual(scan.invalidRecords, []);
  });

  it("does not start the objects LIST until every snapshot has been read", async () => {
    reset();
    // The snapshot phase's GET is held open; while it is, the objects LIST must
    // not have begun. This is the half of the invariant a call-order assertion
    // cannot see — two awaits started back to back would list in the right
    // order and still race.
    keysByPrefix = {
      "snapshots/": [{ Key: "snapshots/photos/20260612T0915.tsv.gz" }],
    };
    /** @type {() => void} */
    let releaseSnapshotRead = () => {};
    const held = new Promise((resolve) => {
      releaseSnapshotRead = () => resolve(undefined);
    });
    /** @type {string[]} */
    let listedWhileHeld = [];
    onGetStream = async (uri) => {
      await held;
      listedWhileHeld = [...listed];
      return vanished(uri);
    };

    const scanning = scanBucket("b");
    await new Promise((resolve) => setImmediate(resolve));
    releaseSnapshotRead();
    await scanning;

    assert.deepEqual(
      listedWhileHeld,
      ["snapshots/", ".s3cab/sets/"],
      "the objects LIST had not begun while a snapshot read was in flight",
    );
  });

  it("keeps a snapshot that vanished before it was read out of the listing the top-up compares against", async () => {
    // Listed, then forgotten before its read: its rows were never seen, so a
    // key that comes back, even with the same bytes, must read as new (ADR-0112).
    reset();
    keysByPrefix = {
      "snapshots/": [
        { Key: "snapshots/photos/20260612T0915.tsv.gz", ETag: '"e1"' },
        { Key: "snapshots/photos/20260613T0915.tsv.gz", ETag: '"e2"' },
      ],
    };
    onGetStream = async (uri) =>
      uri.includes("0612T")
        ? vanished(uri)
        : Readable.from([gzipSync(HEADING + ".\n")]);

    const scan = await scanBucket("b");

    assert.deepEqual(
      scan.snapshotFiles,
      new Map([["photos", new Map([["20260613T0915.tsv.gz", '"e2"']])]]),
    );
  });

  it("scans a set known only by s3cab's copy of its config as a set with no snapshots", async () => {
    // Everything under `snapshots/photos` went at once: the config is what's
    // left to say the set was there (ADR-0117).
    reset();
    keysByPrefix = {
      ".s3cab/sets/": [
        { Key: ".s3cab/sets/photos/dirs.txt" },
        { Key: ".s3cab/sets/Not_A_Set/dirs.txt" },
      ],
    };

    const scan = await scanBucket("b");

    assert.deepEqual([...scan.referencedBySet.keys()], ["photos"]);
    assert.equal(scan.referencedBySet.get("photos")?.snapshotsChecked, 0);
  });

  it("an objects LIST failure aborts the scan rather than returning a partial store", async () => {
    reset();
    objectsListFailure = Object.assign(new Error("denied"), {
      name: "AccessDenied",
    });

    // The seam's error surfaces as itself — not wrapped, not swallowed.
    await assert.rejects(
      scanBucket("b"),
      (error) => error === objectsListFailure,
    );
    // ...and the record was never read: no phase runs on a broken predecessor.
    assert.deepEqual(listed, ["snapshots/", ".s3cab/sets/", "objects/"]);
  });

  it("an empty bucket scans to three empty maps", async () => {
    reset();
    const scan = await scanBucket("b");
    assert.deepEqual(scan, {
      snapshotFiles: new Map(),
      referencedBySet: new Map(),
      stored: new Map(),
      deleted: new Map(),
      invalidRecords: [],
    });
  });
});
