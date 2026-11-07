import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { beforeEach, describe, it, mock } from "node:test";
import { gzipSync } from "node:zlib";
import { s3Seam } from "../../test/helpers/s3-seam.mjs";
import { HEADING } from "./snapshot-file.mjs";

// Unit tests for referencedObjects' snapshot-read error handling, mocking the
// s3.mjs seam (docs/design/testing.md: mock at s3.mjs, not the AWS SDK). Split from
// the pure-function remote.test.mjs (ADR-0049 dotted aspect) because it needs the
// mock; the real round-trip lives in test/integration/remote.test.mjs. Here we drive
// the three-way branch in readSetReferenced deterministically — a snapshot that
// vanished mid-scan (skip), a corrupt one (flag), an operational error (abort) —
// with no live bucket and no real gzip streams. The mock is registered before the
// dynamic import of remote.mjs so that import binds the fakes (ordering rule from
// objects.test.mjs); needs --experimental-test-module-mocks (set on the test scripts).

// getStream's outcome is swapped per test via this hook; listObjects yields these
// keys.
/** @type {(uri: string) => Promise<Readable>} */
let onGetStream;
/** @type {string[]} */
let snapshotKeys;
/** @type {Record<string, string>} each key's ETag, where a test sets one */
let etags = {};
beforeEach(() => {
  etags = {};
});

// The scan's two reads, and nothing else: the listing it walks and the bodies it
// pulls. `isObjectNotFound` is left to the stencil's default — the real
// name-based predicate, which the vanished-snapshot case below depends on.
mock.module("./s3.mjs", {
  exports: s3Seam({
    listObjects: async function* () {
      for (const Key of snapshotKeys) {
        yield { Key, ETag: etags[Key] };
      }
    },
    getStream: (/** @type {string} */ uri) => onGetStream(uri),
  }),
});
const { listSnapshotFiles, readNewSnapshots, referencedObjects } =
  await import("./remote.mjs");

const BUCKET = "b";
/** @param {string} set @param {string} name */
const key = (set, name) => `snapshots/${set}/${name}.tsv.gz`;
/** @param {string} name */
const named = (name) => Object.assign(new Error(name), { name });
const gunzipError = () =>
  Object.assign(new Error("incorrect header check"), {
    code: "Z_DATA_ERROR",
  });

describe("referencedObjects snapshot-read error handling (mocked s3)", () => {
  it("skips a snapshot that vanished between LIST and read — not unreadable, no abort", async () => {
    snapshotKeys = [key("s", "20250101T0000"), key("s", "20250102T0000")];
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
    snapshotKeys = [key("s", "20250310T0900")];
    onGetStream = async () => {
      throw gunzipError();
    };

    const bySet = await referencedObjects(BUCKET);
    const result = bySet.get("s");
    assert.ok(result);
    assert.deepEqual(
      result.unreadable.map((u) => u.snapshot),
      ["20250310T0900"],
    );
  });

  it("carries a readable snapshot's refused row into `invalid` — cleanup's abort signal (ADR-0101)", async () => {
    snapshotKeys = [key("s", "20250501T0800")];
    const ok = "a".repeat(64);
    const text =
      HEADING +
      [
        "@SET\tDIR\t\t\t/home/me/",
        `-\t${ok}\t3\t2025-05-01T08:00:00.000Z\t/home/me/ok.txt`,
        `-\t${"b".repeat(64)}\tx\t2025-05-01T08:00:00.000Z\t/home/me/torn.txt`,
        ".",
        "",
      ].join("\n");
    onGetStream = async () => Readable.from([gzipSync(text)]);

    const bySet = await referencedObjects(BUCKET);
    const result = bySet.get("s");
    assert.ok(result);
    assert.equal(result.snapshotsChecked, 1);
    assert.deepEqual([...result.referenced.keys()], [ok]);
    assert.deepEqual(result.invalid, [
      {
        snapshot: "20250501T0800",
        path: "/home/me/torn.txt",
        reason: "its size isn't a whole number of bytes",
      },
    ]);
  });

  it("carries each read snapshot's START, which the deletion rows are dated against", async () => {
    snapshotKeys = [key("s", "20250701T0800"), key("s", "20250702T0800")];
    const start =
      "@SNAPSHOT\tSTART\t\t2025-07-01T08:00:00.000Z\tEurope/London\n";
    onGetStream = async (uri) =>
      Readable.from([
        gzipSync(HEADING + (uri.includes("0701T") ? start : "") + ".\n"),
      ]);

    const bySet = await referencedObjects(BUCKET);

    assert.deepEqual(
      bySet.get("s")?.starts,
      new Map([
        ["20250702T0800", undefined],
        ["20250701T0800", "2025-07-01T08:00:00.000Z"],
      ]),
    );
  });

  it("skips a set's `<set>.info` marker, which sits beside its folder, not in it", async () => {
    snapshotKeys = ["snapshots/s.info", key("s", "20250601T0800")];
    onGetStream = async () => Readable.from([gzipSync(HEADING + ".\n")]);

    const bySet = await referencedObjects(BUCKET);
    assert.deepEqual([...bySet.keys()], ["s"]);
    assert.equal(bySet.get("s")?.snapshotsChecked, 1);
  });

  it("enumerates a set whose marker is listed with nothing under it — nothing checked, not absent", async () => {
    // A set whose snapshots are all gone is still a set: `verify` reports it
    // rather than passing a set it never looked at (ADR-0117).
    snapshotKeys = ["snapshots/s.info"];

    const bySet = await referencedObjects(BUCKET);
    assert.deepEqual([...bySet.keys()], ["s"]);
    assert.equal(bySet.get("s")?.snapshotsChecked, 0);
    assert.deepEqual(bySet.get("s")?.unreadable, []);
  });

  it("registers no set for a stray key that isn't a canonical set's", async () => {
    // Keys a console can make beside the real ones: none may become a phantom
    // set that `verify` reports as `no snapshots` on every run.
    snapshotKeys = [
      "snapshots/.info",
      "snapshots/Photos.info",
      "snapshots/notes.old.info",
      "snapshots/readme.txt",
      "snapshots/",
    ];

    const bySet = await referencedObjects(BUCKET);
    assert.deepEqual([...bySet.keys()], []);
  });

  it("keeps a canonical folder with no valid snapshot in it as a set with none", async () => {
    // `snapshots/old-copy/readme.txt` is a set as far as `list --remote` is
    // concerned, so verify reports it rather than passing over it.
    snapshotKeys = ["snapshots/old-copy/readme.txt"];

    const bySet = await referencedObjects(BUCKET);
    assert.deepEqual([...bySet.keys()], ["old-copy"]);
    assert.equal(bySet.get("old-copy")?.snapshotsChecked, 0);
  });
});

// The listing diff behind cleanup's top-up (ADR-0112 step 4): what appeared
// since the scan's listing, by key *and* by the bytes under it.
describe("readNewSnapshots (mocked s3)", () => {
  const republished = key("s", "20250601T0800");

  it("reads a snapshot republished under a name the earlier listing saw, by its ETag", async () => {
    // A `forget` and a backup in the same minute put other bytes under the
    // same key; by key alone the top-up would skip it and its objects would
    // be deleted as orphans.
    snapshotKeys = [republished];
    etags = { [republished]: '"v1"' };
    onGetStream = async () => Readable.from([gzipSync(HEADING + ".\n")]);
    const known = await listSnapshotFiles(BUCKET);
    etags = { [republished]: '"v2"' };

    const added = await readNewSnapshots(BUCKET, known);

    assert.equal(added.get("s")?.snapshotsChecked, 1);
  });

  it("reads nothing when every key still holds the bytes the listing saw", async () => {
    snapshotKeys = [republished];
    etags = { [republished]: '"v1"' };
    onGetStream = async () => Readable.from([gzipSync(HEADING + ".\n")]);
    const known = await listSnapshotFiles(BUCKET);

    const added = await readNewSnapshots(BUCKET, known);

    assert.equal(added.size, 0);
  });

  it("reads a key again when the store lists it with no ETag", async () => {
    // With nothing to compare the bytes by, the key alone would decide — the
    // comparison this guard exists to replace — so the key is read again.
    snapshotKeys = [republished];
    onGetStream = async () => Readable.from([gzipSync(HEADING + ".\n")]);
    const known = await listSnapshotFiles(BUCKET);

    const added = await readNewSnapshots(BUCKET, known);

    assert.equal(added.get("s")?.snapshotsChecked, 1);
  });

  it("still rethrows an operational error (aborts the scan)", async () => {
    snapshotKeys = [key("s", "20250401T1200")];
    onGetStream = async () => {
      throw named("AccessDenied");
    };

    await assert.rejects(referencedObjects(BUCKET), /AccessDenied/);
  });
});
