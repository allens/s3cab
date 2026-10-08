/**
 * Build a backup sandbox (ADR-0096): a clean room for the Python backup, and the trees
 * it backs up.
 *
 *   <root>/cleanroom/   the session's: spec, brief, credentials, and sets/ — each set's
 *                       dirs.txt and exclude.txt, the two files the spec says a set
 *                       carries, pointing into fixtures/
 *   <root>/fixtures/    the trees (fixtures.mjs)
 *
 * No network beyond resolving credentials, and nothing of s3cab's: the session runs
 * neither s3cab setup nor anything else that would write those files, so they are
 * written here. The trees stay outside cleanroom/ although the session reads them, so
 * the session's own files are never mixed in with what it backs up.
 *
 * Usage:
 *   node --env-file=.env.test scripts/cleanroom/build-backup-cleanroom.mjs <root>
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  handover,
  readCommandLine,
  sessionCredentials,
  writeCleanroom,
} from "./cleanroom.mjs";
import { buildFixtures, excludes, reportFixtures } from "./fixtures.mjs";

const { root, bucket } = readCommandLine(
  "build-backup-cleanroom.mjs",
  "S3CAB_TEST_BUCKET_CLEANROOM_BACKUP",
);
const credentials = await sessionCredentials(bucket);
const cleanroom = join(root, "cleanroom");
const fixtures = join(root, "fixtures");

writeCleanroom(cleanroom, "backup", bucket, credentials);
const { sets, skipped } = buildFixtures(fixtures);
for (const [name, dirs] of sets) {
  const set = join(cleanroom, "sets", name);
  mkdirSync(set, { recursive: true });
  writeFileSync(join(set, "dirs.txt"), dirs.join("\n") + "\n");
  const exclude = excludes.get(name);
  if (exclude) {
    writeFileSync(join(set, "exclude.txt"), exclude);
  }
}
reportFixtures(fixtures, sets, skipped);

handover(root, [
  "empty the bucket: the backup's turn starts from nothing.",
  "install Python 3 and boto3 if this machine lacks them: the brief tells the\n" +
    "    session not to install anything.",
  "raise the bucket's expiry past the run: scripts/setup-test-bucket.mjs --days",
]);
