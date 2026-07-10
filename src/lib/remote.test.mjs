import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { remoteSnapshotsPrefix } from "./remote.mjs";

describe("remoteSnapshotsPrefix", () => {
  it("places a set's snapshots under snapshots/<set>/", () => {
    assert.equal(remoteSnapshotsPrefix("photos"), "snapshots/photos/");
  });
});
