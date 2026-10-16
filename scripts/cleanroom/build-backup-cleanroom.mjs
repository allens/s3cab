/**
 * Build a backup sandbox (ADR-0096): a clean room for the Python backup program, and the
 * trees it backs up.
 *
 *   <root>/cleanroom/   the session's: spec, brief, credentials, and ENVIRONMENT.md naming
 *                       each set's member directories in fixtures/
 *   <root>/fixtures/    the trees (fixtures.mjs)
 *
 * Nothing of s3cab's reaches the room: no set files (the spec is the repository format
 * alone, ADR-0107), no exclude patterns, and no snapshot of the trees. s3cab's own snapshot
 * of them is taken afterwards, by check-backup.mjs, in a throwaway home. The session is
 * handed every set, the two a backup must refuse included: ENVIRONMENT.md names each set's
 * directories and nothing of what makes any of them hard. The trees stay outside
 * cleanroom/ although the session reads them, so its own files are never mixed in with
 * what it walks.
 *
 * Built on every platform, as a restore sandbox is: the session can only test its program
 * on the machine it runs on, and each platform changes what a backup has to get right.
 *
 * Usage:
 *   node --env-file=.env.test scripts/cleanroom/build-backup-cleanroom.mjs <root>
 */
import { join } from "node:path";
import {
  handover,
  readCommandLine,
  sessionCredentials,
  writeCleanroom,
} from "./cleanroom.mjs";
import { buildFixtures, reportFixtures } from "./fixtures.mjs";

const { root, bucket } = readCommandLine(
  "build-backup-cleanroom.mjs",
  "S3CAB_TEST_BUCKET_CLEANROOM_BACKUP",
);
const credentials = await sessionCredentials(bucket);
const fixtures = join(root, "fixtures");

const built = buildFixtures(fixtures);
reportFixtures(fixtures, built);
console.log("");
writeCleanroom(
  join(root, "cleanroom"),
  "backup",
  bucket,
  credentials,
  built.sets,
);

handover(root, [
  "empty the bucket: the backup's turn starts from nothing.",
  "install Python 3 and boto3 if this machine lacks them: the brief tells the\n" +
    "    session not to install anything.",
  "raise the bucket's expiry past the run: scripts/setup-test-bucket.mjs --days",
]);
