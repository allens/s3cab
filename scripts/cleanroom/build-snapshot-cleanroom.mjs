/**
 * Build a snapshot sandbox (ADR-0096): a clean room for the Python snapshot program, the
 * first half of the clean-room backup, and the trees it walks.
 *
 *   <root>/cleanroom/   the session's: spec, brief, and sets/ — each set's dirs.txt and
 *                       exclude.txt, the two files the spec says a set carries, pointing
 *                       into fixtures/. The session writes each set's snapshots beside
 *                       them.
 *   <root>/fixtures/    the trees (fixtures.mjs)
 *
 * No network and nothing of s3cab's. A snapshot is a local file, so the room has no
 * bucket and no credentials: its rows are checked afterwards against `s3cab snapshot` of
 * the same trees, which is local too. The session runs neither s3cab setup nor anything
 * else that would write the set files, so they are written here. The trees stay outside
 * cleanroom/ although the session reads them, so the session's own files are never mixed
 * in with what it walks.
 *
 * Built on every platform, as a restore sandbox is: the session can only test its program
 * on the machine it runs on, and each platform changes what a snapshot has to get right.
 *
 * Usage:
 *   node scripts/cleanroom/build-snapshot-cleanroom.mjs <root>
 */
import { join } from "node:path";
import { handover, readRoot, writeCleanroom } from "./cleanroom.mjs";
import { buildFixtures, reportFixtures, writeSetFiles } from "./fixtures.mjs";

const root = readRoot("build-snapshot-cleanroom.mjs");
const cleanroom = join(root, "cleanroom");
const fixtures = join(root, "fixtures");

writeCleanroom(cleanroom, "snapshot");
const { sets, skipped } = buildFixtures(fixtures);
for (const [name, dirs] of sets) {
  writeSetFiles(join(cleanroom, "sets", name), name, dirs);
}
reportFixtures(fixtures, sets, skipped);

handover(root, [
  "install Python 3 if this machine lacks it: the brief tells the session not to\n" +
    "    install anything.",
]);
