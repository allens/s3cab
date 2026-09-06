import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import { s3Seam } from "../../test/helpers/s3-seam.mjs";

/** @import { Readable } from "node:stream" */

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
/** What each prefix's LIST yields — keys only; sizes and ages where set. */
/** @type {Record<string, { Key: string, Size?: number, LastModified?: Date }[]>} */
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
 * phase without a real zstd body. One test replaces it to hold a read open.
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
    getText: async (/** @type {string} */ uri) => textByUri[uri],
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
      "snapshots/": [{ Key: "snapshots/photos/2026-06-12T0915.tsv.zst" }],
      "objects/": [{ Key: "objects/aaa", Size: 10, LastModified: new Date(0) }],
      "objects.deleted-": [{ Key: "objects.deleted-1.tsv" }],
    };
    textByUri["s3://b/objects.deleted-1.tsv"] =
      "#DELETED\t\t2026-08-22T11:04:55.120Z\tgone on purpose\n" +
      `${"b".repeat(64)}\t7\t2026-08-22T11:04:55.120Z\tallen@DESKTOP\n#END\n`;

    const scan = await scanBucket("b");

    assert.deepEqual(listed, ["snapshots/", "objects/", "objects.deleted-"]);
    assert.deepEqual([...scan.referencedBySet.keys()], ["photos"]);
    assert.deepEqual(
      scan.stored,
      new Map([["aaa", { size: 10, lastModified: new Date(0) }]]),
    );
    assert.deepEqual(
      scan.deleted,
      new Map([["b".repeat(64), { deletedOn: "2026-08-22T11:04:55.120Z" }]]),
    );
  });

  it("does not start the objects LIST until every snapshot has been read", async () => {
    reset();
    // The snapshot phase's GET is held open; while it is, the objects LIST must
    // not have begun. This is the half of the invariant a call-order assertion
    // cannot see — two awaits started back to back would list in the right
    // order and still race.
    keysByPrefix = {
      "snapshots/": [{ Key: "snapshots/photos/2026-06-12T0915.tsv.zst" }],
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
      ["snapshots/"],
      "the objects LIST had not begun while a snapshot read was in flight",
    );
  });

  it("an objects LIST failure aborts the scan rather than returning a partial store", async () => {
    reset();
    objectsListFailure = Object.assign(new Error("denied"), {
      name: "AccessDenied",
    });

    await assert.rejects(scanBucket("b"), /AccessDenied/);
    // ...and the record was never read: no phase runs on a broken predecessor.
    assert.deepEqual(listed, ["snapshots/", "objects/"]);
  });

  it("an empty bucket scans to three empty maps", async () => {
    reset();
    const scan = await scanBucket("b");
    assert.deepEqual(scan, {
      referencedBySet: new Map(),
      stored: new Map(),
      deleted: new Map(),
    });
  });
});
