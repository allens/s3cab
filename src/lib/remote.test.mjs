import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { remoteSnapshotUri, remoteSnapshotsPrefix } from "./remote.mjs";

describe("remoteSnapshotsPrefix", () => {
  it("places a set's snapshots under snapshots/<set>/", () => {
    assert.equal(remoteSnapshotsPrefix("photos"), "snapshots/photos/");
  });
});

describe("remoteSnapshotUri", () => {
  it("addresses a snapshot at snapshots/<set>/<name>.tsv.zst", () => {
    // The repository layout the format spec promises a recoverer — spelled
    // out independently so a change to prefix or extension fails here.
    assert.equal(
      remoteSnapshotUri("my-bucket", "photos", "2026-06-12T0915"),
      "s3://my-bucket/snapshots/photos/2026-06-12T0915.tsv.zst",
    );
  });
});
