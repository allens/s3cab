/**
 * Build an upload sandbox (ADR-0096): a clean room for the Python upload program, the
 * second half of the clean-room backup, and snapshots of the trees for it to upload.
 *
 *   <root>/cleanroom/   the session's: spec, brief, credentials, and sets/ — each set's
 *                       dirs.txt and exclude.txt, and snapshots/, what s3cab snapshotted
 *                       of fixtures/
 *   <root>/fixtures/    the trees (fixtures.mjs)
 *   <root>/.s3cab/      s3cab's home while it snapshots them
 *
 * The snapshots are s3cab's: the one place a backup room is handed s3cab's output. An
 * upload has to start from a snapshot, and s3cab's is the one the spec describes;
 * the clean-room snapshot's would hang this run's result on that run's reading. They
 * are input, not something to compare against, which is the imitation ADR-0096 keeps
 * out, and every restorer reads s3cab's snapshots the same way. The price is real all
 * the same: an encoding question the examples settle drops out of this room's report.
 * The brief says to read them as the spec describes them, not as they look, and the
 * snapshot room, whose job is writing them, is where those questions get asked.
 *
 * `s3cab snapshot` is offline once a set exists, so each set is written straight into
 * .s3cab/ rather than through `setup`, which would claim the name in the bucket and
 * publish its `sets/` entry. Writing that entry is the session's job, and the bucket
 * starts its turn empty.
 *
 * Two sets are damaged once s3cab has snapshotted them, each the upload side of the
 * restore bucket's damage under the same name (seed-restore-cleanroom-bucket.mjs):
 *
 * - `corrupt`'s b-corrupt.txt is rewritten, keeping its size and mtime, so only hashing
 *   what is uploaded can tell. Stored as it now is, its bytes go under a key they don't
 *   hash to: the very object the seed plants by hand, made the way a real one is, by a
 *   file changing between the walk and the upload. s3cab leaves the file out and
 *   publishes no snapshot for the set. The spec defines a key as its content's hash
 *   and says nothing of a file that changed since its snapshot, so what the session
 *   does here is a reading of the spec, not a test against a stated rule.
 * - `faults` gets a second snapshot with no `#END` trailer, backdated a minute. The spec
 *   calls such a snapshot damaged goods, and s3cab refuses to upload one; publishing it
 *   would put a truncated record in the bucket.
 *
 * Usage:
 *   node --env-file=.env.test scripts/cleanroom/build-upload-cleanroom.mjs <root>
 */
import {
  copyFileSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  cli,
  handover,
  readCommandLine,
  sessionCredentials,
  writeCleanroom,
} from "./cleanroom.mjs";
import {
  buildFixtures,
  oneMinuteBefore,
  reportFixtures,
  withoutTrailer,
  writeSetFiles,
} from "./fixtures.mjs";

const { root, bucket } = readCommandLine(
  "build-upload-cleanroom.mjs",
  "S3CAB_TEST_BUCKET_CLEANROOM_BACKUP",
);
const credentials = await sessionCredentials(bucket);
const cleanroom = join(root, "cleanroom");
const fixtures = join(root, "fixtures");
const home = join(root, ".s3cab");
const { mustRun } = cli(home);

writeCleanroom(cleanroom, "upload", bucket, credentials);
const { sets, skipped } = buildFixtures(fixtures);
reportFixtures(fixtures, sets, skipped);

console.log("");
for (const [name, dirs] of sets) {
  const set = join(home, "sets", name);
  writeSetFiles(set, name, dirs);
  // A local set has to name its bucket. `snapshot` never reaches it.
  writeFileSync(join(set, "env"), `S3CAB_BUCKET=${bucket}\n`);
  console.log(`snapshot ${name}`);
  mustRun(["snapshot", name]);
}

// Same size, same mtime, different bytes: a check of size and mtime alone passes it.
// The time is put back through milliseconds, which is the resolution a snapshot row keeps.
const changed = join(fixtures, "corrupt", "b-corrupt.txt");
const { size, atimeMs, mtimeMs } = statSync(changed);
writeFileSync(changed, Buffer.alloc(size, "?"));
utimesSync(changed, atimeMs / 1000, mtimeMs / 1000);
console.log(
  "rewrote corrupt/b-corrupt.txt after its snapshot, size and mtime kept",
);

/** @param {string} name */
const snapshotsOf = (name) => join(home, "sets", name, "snapshots");
for (const [name, dirs] of sets) {
  const set = join(cleanroom, "sets", name);
  writeSetFiles(set, name, dirs);
  mkdirSync(join(set, "snapshots"));
  // Not the dot-files s3cab keeps beside them while it works: those are never uploaded.
  for (const entry of readdirSync(snapshotsOf(name))) {
    if (entry.endsWith(".tsv.gz") && !entry.startsWith(".")) {
      copyFileSync(
        join(snapshotsOf(name), entry),
        join(set, "snapshots", entry),
      );
    }
  }
}

const [intact = ""] = readdirSync(snapshotsOf("faults")).filter(
  (entry) => entry.endsWith(".tsv.gz") && !entry.startsWith("."),
);
const damaged = `${oneMinuteBefore(intact.slice(0, -".tsv.gz".length))}.tsv.gz`;
writeFileSync(
  join(cleanroom, "sets", "faults", "snapshots", damaged),
  withoutTrailer(readFileSync(join(snapshotsOf("faults"), intact))),
);
console.log(`added faults/${damaged} beside ${intact}, with no #END trailer`);

handover(root, [
  "empty the bucket: the upload's turn starts from nothing.",
  "install Python 3 and boto3 if this machine lacks them: the brief tells the\n" +
    "    session not to install anything.",
  "raise the bucket's expiry past the run: scripts/setup-test-bucket.mjs --days",
]);
