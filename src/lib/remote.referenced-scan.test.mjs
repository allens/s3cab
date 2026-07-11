import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";

// Unit tests for referencedObjects' snapshot-read error handling, mocking the
// s3.mjs seam (docs/design/testing.md: mock at s3.mjs, not the AWS SDK). Split from
// the pure-function remote.test.mjs (ADR-0049 dotted aspect) because it needs the
// mock; the real round-trip lives in test/integration/remote.test.mjs. Here we drive
// the three-way branch in readSetReferenced deterministically — a snapshot that
// vanished mid-scan (skip), a corrupt one (flag), an operational error (abort) —
// with no live bucket and no real zstd streams. The mock is registered before the
// dynamic import of remote.mjs so that import binds the fakes (ordering rule from
// objects.test.mjs); needs --experimental-test-module-mocks (set on the test scripts).

// getStream's outcome is swapped per test via this hook; listObjects yields these
// keys.
/** @type {(uri: string) => Promise<import("node:stream").Readable>} */
let onGetStream;
/** @type {string[]} */
let snapshotKeys;

mock.module("./s3.mjs", {
  exports: {
    // Not AWS I/O, so not truly a seam — but mock.module replaces the whole
    // module, so it must be supplied. Kept faithful to the real predicate (which
    // is unit-tested in s3.test.mjs); remote's branch keys on its verdict.
    isObjectNotFound: (/** @type {unknown} */ e) =>
      Error.isError(e) && (e.name === "NoSuchKey" || e.name === "NotFound"),
    listObjects: async function* () {
      for (const Key of snapshotKeys) {
        yield { Key };
      }
    },
    getStream: (/** @type {string} */ uri) => onGetStream(uri),
    // Imported by remote.mjs (deleteRemoteSnapshot); no test here calls it.
    deleteObject: async () => {},
  },
});
const { referencedObjects } = await import("./remote.mjs");

const BUCKET = "b";
/** @param {string} set @param {string} name */
const key = (set, name) => `snapshots/${set}/${name}.tsv.zst`;
/** @param {string} name */
const named = (name) => Object.assign(new Error(name), { name });
const zstdError = () =>
  Object.assign(new Error("bad zstd"), {
    code: "ZSTD_error_corruption_detected",
  });

describe("referencedObjects snapshot-read error handling (mocked s3)", () => {
  it("skips a snapshot that vanished between LIST and read — not unreadable, no abort", async () => {
    snapshotKeys = [key("s", "2025-01-01T0000"), key("s", "2025-01-02T0000")];
    onGetStream = async () => {
      throw named("NoSuchKey");
    };

    const bySet = await referencedObjects(BUCKET);
    const result = bySet.get("s");
    assert.ok(result, "the set is still enumerated");
    assert.equal(
      result.snapshotsChecked,
      0,
      "a vanished snapshot isn't counted",
    );
    assert.deepEqual(
      result.unreadable,
      [],
      "a vanished snapshot is NOT flagged unreadable — it's gone, not damaged",
    );
    assert.equal(result.referenced.size, 0);
  });

  it("still flags a corrupt (undecompressable) snapshot as unreadable", async () => {
    snapshotKeys = [key("s", "2025-03-10T0900")];
    onGetStream = async () => {
      throw zstdError();
    };

    const bySet = await referencedObjects(BUCKET);
    const result = bySet.get("s");
    assert.ok(result);
    assert.deepEqual(
      result.unreadable.map((u) => u.snapshot),
      ["2025-03-10T0900"],
    );
  });

  it("still rethrows an operational error (aborts the scan)", async () => {
    snapshotKeys = [key("s", "2025-04-01T1200")];
    onGetStream = async () => {
      throw named("AccessDenied");
    };

    await assert.rejects(referencedObjects(BUCKET), /AccessDenied/);
  });
});
