/**
 * Build a restore sandbox (ADR-0096): a clean room for a restorer, reading the golden set that
 * seed-restore-cleanroom-bucket.mjs put in the restore bucket.
 *
 *   <root>/cleanroom/   the session's: spec, brief, credentials
 *   <root>/.s3cab/      s3cab's home, with every golden set reattached for
 *                       reconcile-restore-cleanroom.mjs to restore the references from.
 *                       Never the session's to see, which is why it is beside cleanroom/
 *
 * No reference trees yet: the spec-only phase writes the restorer and its report without
 * them, and reconcile-restore-cleanroom.mjs builds them once it has exited.
 *
 * Usage:
 *   node --env-file=.env.test scripts/cleanroom/build-restore-cleanroom.mjs <root>
 */
import { HeadBucketCommand } from "@aws-sdk/client-s3";
import { join } from "node:path";
import {
  cli,
  client,
  handover,
  readCommandLine,
  sessionCredentials,
  writeCleanroom,
} from "./cleanroom.mjs";
import { goldenSets } from "./fixtures.mjs";
import { missingSets, seedHash, seededHash } from "./restore-bucket.mjs";

const { root, bucket } = readCommandLine(
  "build-restore-cleanroom.mjs",
  "S3CAB_TEST_BUCKET_CLEANROOM_RESTORE",
);
const credentials = await sessionCredentials(bucket);
const cleanroom = join(root, "cleanroom");
const { mustRun } = cli(join(root, ".s3cab"));

// The bucket's own region, whatever AWS_REGION says: at home the restore bucket is CI's,
// in another region from the personal ones. ENVIRONMENT.md hands the restorer this
// variable, and a request signed for the wrong region is refused.
const { BucketRegion } = await client.send(
  new HeadBucketCommand({ Bucket: bucket }),
);
process.env.AWS_REGION = BucketRegion;

// A restorer written from today's spec fails against a golden set in yesterday's format
// through no fault of its own, and the session would spend its run reporting that as
// spec gaps. Yesterday's fixtures are subtler: the run passes, measured against a corpus
// missing whatever was added since. A platform's sets missing is the same corpus short.
const seeded = await seededHash(bucket);
const missing = await missingSets(bucket);
const reseed =
  "Reseed it from main, where the workflow's role may write it:\n" +
  "\n" +
  "    gh workflow run cleanroom-seed.yml --ref main\n";
const measured =
  "so a restorer written from the spec here would be measured against another golden set.\n";
if (seeded && seeded !== seedHash()) {
  // CI seeds from main, so a checkout behind it or on a branch differs as much as a
  // bucket main has moved past, and only the second is fixed by reseeding.
  console.error(
    `The restore bucket '${bucket}' was seeded from a different spec or fixtures than\n` +
      `this checkout's, ${measured}` +
      "If this checkout isn't main as it is now, bring it up to date:\n" +
      "\n" +
      "    git switch main && git pull\n" +
      "\n" +
      `If it is, main has changed since the last seed. ${reseed}`,
  );
  process.exit(2);
}
if (!seeded || missing.length > 0) {
  console.error(
    `The restore bucket '${bucket}' ${
      seeded
        ? `holds no snapshot of ${missing.join(", ")}`
        : "carries no stamp from a finished seed"
    },\n${measured}${reseed}`,
  );
  process.exit(2);
}

writeCleanroom(cleanroom, "restore", bucket, credentials);

// `reattach` is how a second machine gets a set to restore from, and this sandbox's
// `.s3cab/` starts empty. Every platform's sets: a restorer restores what each backed up.
for (const name of goldenSets) {
  console.log(`reattach ${name}`);
  mustRun(["reattach", name, "--bucket", bucket]);
}

handover(root, "restore", []);
