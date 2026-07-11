import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { remoteSetPrefix } from "./set-marker.mjs";

// The pure prefix builder. The remote `sets/<set>/` marker's S3 behaviour (claim,
// listing, config publish) is exercised against a real bucket in
// test/integration/set-marker.test.mjs.

describe("remoteSetPrefix", () => {
  it("places a set's marker under sets/<set>/", () => {
    assert.equal(remoteSetPrefix("photos"), "sets/photos/");
  });
});
