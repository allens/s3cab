// Tier 2's real-AWS backend: the gate for the conformance bucket, in front of
// the shared out-of-band inspector (harness/real-inspector.mjs — extracted
// when the crash tier became its second consumer).
//
// The conformance bucket is sole-owner and assertions cover whole-bucket
// state (docs/integration-testing.md, "Create a bucket"), which is why
// `wipe()` exists and why this gate refuses to point at anything outside the
// test-bucket naming convention.

export { REAL_CAPABILITIES, RealS3 } from "../harness/real-inspector.mjs";

const CONFORMANCE_BUCKET = process.env.S3CAB_CONFORMANCE_BUCKET;

if (!CONFORMANCE_BUCKET) {
  throw new Error(
    "No conformance bucket configured. Tier 2 conformance tests need a real,\n" +
      "versioned, sole-owner S3 bucket (docs/integration-testing.md):\n\n" +
      "    export S3CAB_CONFORMANCE_BUCKET=test-s3cab-<you>-conformance\n\n" +
      "  Working in a worktree? `.env.test` is gitignored and stays in the\n" +
      "  main checkout. Copy it across:\n" +
      "    cp ../../../.env.test .env.test\n",
  );
}
if (
  !CONFORMANCE_BUCKET.startsWith("test-s3cab-") ||
  !CONFORMANCE_BUCKET.endsWith("-conformance")
) {
  // wipe() deletes every version of every object — the name convention is the
  // safety boundary that keeps that away from real backups and from the
  // shared integration bucket.
  throw new Error(
    `Refusing conformance bucket '${CONFORMANCE_BUCKET}': the name must match ` +
      "test-s3cab-<owner>-conformance (docs/integration-testing.md). " +
      "Conformance tests wipe the whole bucket between cases.",
  );
}

/** The gated bucket — guaranteed set (the check above throws otherwise). */
export const bucket = CONFORMANCE_BUCKET;
