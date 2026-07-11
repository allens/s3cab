import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after } from "node:test";
import { loadEnv } from "../../src/lib/env.mjs";
import { deleteObject } from "../../src/lib/s3.mjs";
import { remoteSetPrefix } from "../../src/lib/set-marker.mjs";
import { useTempHome } from "./temp-home.mjs";

// Shared harness for the gated real-bucket integration tests in test/integration/
// (see docs/design/testing.md). They round-trip against a real S3 bucket, gated on
// `S3CAB_TEST_BUCKET` (+ ambient AWS credentials).
//
// These suites only run when integration is explicitly opted into
// (`npm run test:integration` / `test:all`); a plain `npm test` never globs this
// folder (ADR-0049). So a missing bucket is a *misconfigured request*, not a run to
// skip — importing this harness HARD-FAILS with an actionable error rather than
// silently passing off nothing (the old `skip` flag let an integration run "pass"
// having tested nothing). Hard-fail > silently-skipped, wherever integration was asked
// for.

const TEST_BUCKET = process.env.S3CAB_TEST_BUCKET;

if (!TEST_BUCKET) {
  throw new Error(
    "No test bucket configured. Integration tests need a real S3 bucket.\n\n" +
      "    export S3CAB_TEST_BUCKET=your-bucket    # then re-run\n" +
      "    # or run `npm test` for the unit suite (no bucket needed)\n",
  );
}

/** The gated bucket — guaranteed set (the import above throws otherwise). */
export const bucket = TEST_BUCKET;

// These suites call the S3 ops directly (no CLI entry point), so they must trip
// the env-loaded flag client() asserts (ADR-0022) — ambient AWS credentials
// supply the real creds; this just sets the flag, at import time (before any test
// body runs), so a static import of this harness is enough.
//
// Relocate S3CAB_HOME to a throwaway dir *first* (the isolation
// docs/integration-testing.md promises): otherwise `loadEnv()` reads the
// developer's real ~/.s3cab/env and merges its AWS_PROFILE / region / endpoint into
// process.env, leaking their machine's set config into the suite — the very way a
// stale `AWS_PROFILE=…` there once shadowed .env.test and broke a run. Per-test
// useTempHome() overrides this again; credentials are untouched (they resolve from
// ~/.aws via HOME, which we leave alone). Cleaned up once the file's suite ends so
// runs don't accumulate empty s3cab-it-* dirs (matching the mkdtempDisposable
// hygiene the unit tests use).
const isolatedHome = mkdtempSync(join(tmpdir(), "s3cab-it-"));
useTempHome(isolatedHome);
loadEnv();
after(() => rmSync(isolatedHome, { recursive: true, force: true }));

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
