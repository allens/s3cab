import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after } from "node:test";
import { deleteObject } from "../../src/lib/s3.mjs";
import { remoteSetPrefix } from "../../src/lib/set-marker.mjs";
import { useTempHome } from "./temp-home.mjs";

// Shared harness for the gated real-bucket integration tests in test/integration/
// (see docs/design/testing.md). They round-trip against a real S3 bucket, gated on
// `S3CAB_TEST_BUCKET` (+ ambient AWS credentials).
//
// The bucket may hold a co-tenant: fixtures staged for a clean-room restorer
// (scripts/create-cleanroom.mjs) live here because this is the one test bucket whose
// suites scope everything they assert to a unique set name or a specific object hash.
// Keep it that way — an assertion over the whole bucket (every object, every set,
// "the listing is empty") would pass locally and fail against staged fixtures, and
// the same property is why test/crash and test/model/conformance, which do assert
// whole-bucket state, get their own buckets.
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
      "    # or run `npm test` for the unit suite (no bucket needed)\n\n" +
      // The recurring cause, and invisible from the error alone: `.env.test` is
      // gitignored, so a fresh worktree (.claude/worktrees/<name>, CLAUDE.md #7)
      // starts without it and `--env-file-if-exists` quietly loads nothing.
      "  Working in a worktree? Its checkout has no `.env.test` — that file is\n" +
      "  gitignored, so it stays in the main checkout. Copy it across:\n" +
      "    cp ../../../.env.test .env.test\n",
  );
}

/** The gated bucket — guaranteed set (the import above throws otherwise). */
export const bucket = TEST_BUCKET;

// Relocate S3CAB_HOME to a throwaway dir at import time, before any test body runs
// — the isolation docs/integration-testing.md promises. Anything that reads s3cab's
// home (a set's `env`, its `dirs.txt`/`exclude.txt`, the Roles Anywhere identity)
// then sees an empty home rather than the developer's real `~/.s3cab`, so no local
// set config can leak into a suite. That has bitten before: a stale `AWS_PROFILE=…`
// in a real set's env file once shadowed `.env.test` and broke a run.
//
// Credentials are untouched — they resolve from `~/.aws` via HOME, which we leave
// alone, and these suites call the S3 ops directly rather than through the CLI, so
// ambient AWS credentials are what they authenticate with. Per-test useTempHome()
// overrides this again. Cleaned up once the file's suite ends so runs don't
// accumulate empty s3cab-it-* dirs (matching the mkdtempDisposable hygiene the unit
// tests use).
const isolatedHome = mkdtempSync(join(tmpdir(), "s3cab-it-"));
useTempHome(isolatedHome);
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
