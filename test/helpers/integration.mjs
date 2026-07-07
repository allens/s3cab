import { loadEnv } from "../../src/lib/env.mjs";
import { deleteObject } from "../../src/lib/s3.mjs";
import { remoteSetPrefix } from "../../src/lib/set-marker.mjs";

// Shared harness for the gated real-bucket integration tests (the
// `*.integration.test.mjs` tier — see docs/design/testing.md). They round-trip
// against a real S3 bucket, gated on `S3CAB_TEST_BUCKET` (+ ambient AWS
// credentials); when it is unset every gated `describe(..., { skip })` block is
// skipped with a message, so a plain `npm test` with no bucket stays green.

export const TEST_BUCKET = process.env.S3CAB_TEST_BUCKET;

export const skip = TEST_BUCKET
  ? false
  : "set S3CAB_TEST_BUCKET (and AWS credentials) to run S3 integration tests";

// These suites call the S3 ops directly (no CLI entry point), so they must trip
// the env-loaded flag client() asserts (ADR-0022) — ambient AWS credentials
// supply the real creds; this just sets the flag, at import time (before any test
// body runs), so a static import of this harness is enough.
if (TEST_BUCKET) {
  loadEnv();
}

/** The gated bucket, typed non-optional for use inside `{ skip }` blocks. */
export const bucket = /** @type {string} */ (TEST_BUCKET);

/**
 * Best-effort teardown of a set's remote `sets/<name>/` marker files, so the
 * shared bucket doesn't accumulate markers across runs.
 * @param {string} name
 */
export async function cleanupSetMarker(name) {
  for (const file of ["info", "dirs.txt", "exclude.txt"]) {
    await deleteObject(`s3://${bucket}/${remoteSetPrefix(name)}${file}`).catch(
      () => {},
    );
  }
}
