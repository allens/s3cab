import assert from "node:assert/strict";
import { posix } from "node:path";
import { it } from "node:test";

import { posix as shim } from "./node-shim.mjs";

it("normalizes every short path exactly as node:path does", () => {
  // Every string of up to six of these characters: each way `.`, `..`, runs of
  // `/` and a trailing `/` can meet, and a `\`, which POSIX leaves alone.
  /** @type {string[]} */
  let layer = [""];
  const all = [""];
  for (let length = 1; length <= 6; length++) {
    layer = layer.flatMap((prefix) =>
      ["a", ".", "/", "\\"].map((c) => prefix + c),
    );
    all.push(...layer);
  }
  const differing = all.filter(
    (path) => shim.normalize(path) !== posix.normalize(path),
  );
  assert.deepEqual(differing, []);
});
