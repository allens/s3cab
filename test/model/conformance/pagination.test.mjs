import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { listObjects } from "../../../src/lib/s3.mjs";
import { RealS3, bucket } from "./real-s3.mjs";

// Tier 2: LIST pagination. S3 truncates a listing at 1000 keys; a client
// that reads only the first page sees a complete-looking store that is
// missing objects — which upstream turns into re-uploads at best and a
// cleanup deleting "orphans" that are merely on page two at worst. The
// Tier 1 fake returns everything in one page (CAPABILITIES.md), so only this
// tier can catch it.
//
// This test doubles as the tier split's seeded-bug proof (the brief's "seed a
// bug that only manifests under real S3 semantics"): on 2026-08-14 the
// production continuation loop was deliberately cut to first-page-only
// (`return` after the first `yield*` in listObjects) — the full Tier 1 run
// (1011 tests: every unit tier mocks above this loop, the model tier's fake
// replaces it) stayed green, while this test went red with `1000 !== 1010`.
// Reverted after the run; if the loop ever regresses for real, expect exactly
// that signature here and nowhere else.

const real = new RealS3();
const COUNT = 1010;

/** @param {number} i */
const contentOf = (i) => Buffer.from(`pagination probe object ${i}\n`);

describe("conformance: listing pagination", () => {
  before(async () => {
    await real.wipe(bucket);
    // Content-addressed keys, like the real store — each object's key is the
    // sha256 of its bytes, so this state is also a *legal* repository store.
    /** @type {Promise<void>[]} */
    let batch = [];
    for (let i = 0; i < COUNT; i++) {
      const content = contentOf(i);
      const hash = createHash("sha256").update(content).digest("hex");
      batch.push(real.putBytes(bucket, `objects/${hash}`, content));
      if (batch.length === 50) {
        await Promise.all(batch);
        batch = [];
      }
    }
    await Promise.all(batch);
  });
  after(async () => {
    await real.wipe(bucket);
  });

  it(
    `the production LIST walks every page of ${COUNT} keys`,
    { timeout: 600_000 },
    async (t) => {
      if (!real.capabilities.has("list-pagination")) {
        t.skip("backend does not declare list-pagination");
        return;
      }
      const keys = new Set();
      for await (const object of listObjects(`s3://${bucket}/objects/`)) {
        keys.add(object.Key);
      }
      assert.equal(
        keys.size,
        COUNT,
        "a LIST that stopped at one page would report 1000",
      );
      // Spot-check both extremes are present, not just the count.
      for (const i of [0, COUNT - 1]) {
        const hash = createHash("sha256").update(contentOf(i)).digest("hex");
        assert.ok(
          keys.has(`objects/${hash}`),
          `object ${i} missing from the listing`,
        );
      }
    },
  );
});
