import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import {
  deleteObject,
  getText,
  listObjects,
  objectExists,
  putText,
} from "../../../src/lib/s3.mjs";
import { RealS3, bucket } from "./real-s3.mjs";

// Tier 2: what the production seam's primitives actually do against real S3 —
// the storage semantics the Tier 1 fake only declares (CAPABILITIES.md).
// Whole-bucket state, sole-owner bucket, wiped up front.

const real = new RealS3();

/** @type {NodeJS.ProcessEnv} */
let savedEnv;
beforeEach(() => {
  savedEnv = { ...process.env };
});
afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in savedEnv)) {
      delete process.env[key];
    }
  }
  Object.assign(process.env, savedEnv);
});

describe("conformance: store semantics", () => {
  before(async () => {
    await real.wipe(bucket);
  });
  after(async () => {
    await real.wipe(bucket);
  });

  it(
    "conditional PUT is atomic: one winner among concurrent claimants",
    { timeout: 120_000 },
    async (t) => {
      if (!real.capabilities.has("conditional-put")) {
        t.skip("backend does not declare conditional-put");
        return;
      }
      const uri = `s3://${bucket}/sets/atomic-probe/info`;
      const results = await Promise.all(
        Array.from({ length: 8 }, (_, i) =>
          putText(uri, `claimant ${i}`, { noClobber: true }),
        ),
      );
      const winners = results.filter(Boolean);
      assert.equal(
        winners.length,
        1,
        `exactly one concurrent conditional PUT may win (got ${winners.length})`,
      );
      // And the stored content is one claimant's, intact — not an interleaving.
      const stored = await getText(uri);
      assert.match(/** @type {string} */ (stored), /^claimant [0-7]$/);
    },
  );

  it(
    "DELETE hides the key from s3cab while versioning quietly retains it",
    { timeout: 120_000 },
    async (t) => {
      if (!real.capabilities.has("versioning")) {
        t.skip("backend does not declare versioning");
        return;
      }
      const key = "sets/marker-probe/dirs.txt";
      const uri = `s3://${bucket}/${key}`;
      await putText(uri, "C:\\data\n");
      assert.equal(await objectExists(uri), true);
      await deleteObject(uri);

      // Everything s3cab can see says the object is gone…
      assert.equal(await objectExists(uri), false);
      const listed = [];
      for await (const object of listObjects(
        `s3://${bucket}/sets/marker-probe/`,
      )) {
        listed.push(object.Key);
      }
      assert.deepEqual(listed, []);

      // …while the bucket retains a recoverable noncurrent version behind a
      // delete marker. No s3cab code path checks versioning is on
      // (proposals/engine-robustness.md) — this pins what that backstop
      // actually holds, and that it is invisible through the seam.
      const { versions, deleteMarkers } = await real.listVersions(bucket, key);
      assert.equal(
        versions.length,
        1,
        "the overwritten bytes survive as a noncurrent version",
      );
      assert.equal(versions[0]?.latest, false);
      assert.equal(
        deleteMarkers.length,
        1,
        "the DELETE wrote a marker, not an erasure",
      );
      assert.equal(deleteMarkers[0]?.latest, true);
    },
  );

  it(
    "prefix listing respects the segment boundary",
    { timeout: 120_000 },
    async () => {
      // `alpha` vs `alphabet`: a prefix that forgets its trailing slash would
      // leak the neighbour's snapshots into the listing.
      await putText(
        `s3://${bucket}/snapshots/alpha/2026-01-01T0000.tsv.zst`,
        "a",
      );
      await putText(
        `s3://${bucket}/snapshots/alphabet/2026-01-01T0000.tsv.zst`,
        "b",
      );

      const alpha = [];
      for await (const object of listObjects(
        `s3://${bucket}/snapshots/alpha/`,
      )) {
        alpha.push(object.Key);
      }
      assert.deepEqual(alpha, ["snapshots/alpha/2026-01-01T0000.tsv.zst"]);
    },
  );

  it(
    "a unicode set name is stored under its own raw-UTF-8 key (found by this tier — fixed)",
    { timeout: 120_000 },
    async () => {
      // parseS3Uri (src/lib/s3.mjs) once took `new URL(uri).pathname`, which
      // percent-encodes — `café`'s keys landed in the bucket as `caf%C3%A9`,
      // breaking the format spec's promise that keys are `snapshots/<set>/…`
      // under the set's own name. Only this tier's independent inspector could
      // see it: every seam call encoded identically, so s3cab's own round-trip
      // always worked (and the Tier 1 fake shared the parsing). The parse is a
      // plain string split now; the *stored* key must be the raw spelling.
      await putText(
        `s3://${bucket}/snapshots/café/2026-01-01T0000.tsv.zst`,
        "c",
      );

      const raw = await real.listAll(bucket);
      const stored = raw.map(({ key }) => key).filter((k) => k.includes("caf"));
      assert.deepEqual(stored, ["snapshots/café/2026-01-01T0000.tsv.zst"]);

      // And the seam's own view agrees with the inspector's — listing and
      // fetching under the raw name round-trips.
      const seamListed = [];
      for await (const object of listObjects(
        `s3://${bucket}/snapshots/café/`,
      )) {
        seamListed.push(object.Key);
      }
      assert.deepEqual(seamListed, ["snapshots/café/2026-01-01T0000.tsv.zst"]);
      const body = await getText(
        `s3://${bucket}/snapshots/café/2026-01-01T0000.tsv.zst`,
      );
      assert.equal(body, "c");
    },
  );
});
