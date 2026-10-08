/**
 * Build a restore sandbox (ADR-0096): a clean room for a restorer, and the reference
 * trees its output is compared with, restored from the golden set that
 * seed-restore-cleanroom-bucket.mjs put in the restore bucket.
 *
 *   <root>/cleanroom/   the session's: spec, brief, credentials, and reference/ — what
 *                       s3cab itself restores from every snapshot in the bucket
 *   <root>/.s3cab/      s3cab's home while it does. Never the session's to see, which is
 *                       why it is beside cleanroom/
 *
 * The same on every platform, and it has to run on the platform under test: what a
 * *correct* restore leaves behind differs by platform — names NTFS refuses are absent,
 * the case-colliding pair restores as one file, and mtimes land exact to the millisecond
 * where ext4 keeps a sub-microsecond float error. A reference built elsewhere would score
 * a restorer against a restore it could not have produced. The session doesn't run s3cab
 * for its own comparison: the npm package ships source (ADR-0017), so installing it would
 * put src/ in reach.
 *
 * `reference/` holds what s3cab restored, not the fixtures: a correct restore
 * legitimately differs from its source (no empty directories, no symlinks, mtimes
 * rounded to the millisecond), so comparing against the trees would fail a restorer for
 * being right.
 *
 * Usage:
 *   node --env-file=.env.test scripts/cleanroom/build-restore-cleanroom.mjs <root>
 */
import { mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  handover,
  readCommandLine,
  sessionCredentials,
  writeCleanroom,
} from "./cleanroom.mjs";
import { count, files, setNames } from "./fixtures.mjs";
import { cli, listAll, seededSpec, specHash } from "./restore-bucket.mjs";

const { root, bucket } = readCommandLine(
  "build-restore-cleanroom.mjs",
  "S3CAB_TEST_BUCKET_CLEANROOM_RESTORE",
);
const credentials = await sessionCredentials(bucket);
const cleanroom = join(root, "cleanroom");
const reference = join(cleanroom, "reference");
const { run, mustRun } = cli(join(root, ".s3cab"));

// A restorer written from today's spec fails against a golden set in yesterday's format
// through no fault of its own, and the session would spend its run reporting that as
// spec gaps.
const seeded = await seededSpec(bucket);
if (seeded !== specHash()) {
  console.error(
    `The restore bucket '${bucket}' ${
      seeded
        ? "was seeded from a different guide/format.md than this checkout's"
        : "has no golden set seeded from any guide/format.md"
    }, so a\n` +
      "restorer written from the spec here would be measured against another format.\n" +
      "Reseed it from Linux or WSL first:\n" +
      "\n" +
      "    node --env-file=.env.test scripts/cleanroom/seed-restore-cleanroom-bucket.mjs ~/s3cab.sandbox\n",
  );
  process.exit(2);
}

writeCleanroom(cleanroom, "restore", bucket, credentials);

// `reattach` is how a second machine gets a set to restore from, and this sandbox's
// `.s3cab/` starts empty. It writes one thing to the bucket: each set's `info`, re-stamped
// with this machine as OWNER — the value, never the syntax F12 measures.
for (const name of setNames) {
  console.log(`reattach ${name}`);
  mustRun(["reattach", name, "--bucket", bucket]);
}

// Every snapshot in the bucket, one tree each, so a clean-room run can tell "I found
// nothing" from "I never looked". Enumerated from the bucket rather than from s3cab's
// local history: the damaged `faults` snapshot was published straight to S3 and exists
// nowhere else.
mkdirSync(reference, { recursive: true });
/** @type {string[]} */
const exits = [];
for (const name of setNames) {
  const prefix = `snapshots/${name}/`;
  const keys = await listAll(bucket, prefix);
  const snapshots = keys
    .filter((key) => key.endsWith(".tsv.gz"))
    .map((key) => key.slice(prefix.length, -".tsv.gz".length));
  for (const snapshot of snapshots) {
    const target = join(reference, `${name}-${snapshot}`);
    console.log(`restore ${name} ${snapshot}`);
    const result = run([
      "restore",
      "--set",
      name,
      "--snapshot",
      snapshot,
      "--output",
      target,
    ]);
    if (result.code !== 0) {
      // Its own report, minus the progress counter: a set that is not broken on
      // purpose needs reading. Both streams, because restore lists the files it
      // couldn't write on stdout and puts only an abort on stderr.
      const said = `${result.out}\n${result.err}`
        .split("\n")
        .filter((line) => line.trim() && !line.startsWith("Restoring"))
        .map((line) => `      ${line}`);
      exits.push(
        `${name}/${snapshot} → ${result.code}`,
        ...(name === "faults" || name === "corrupt" ? [] : said),
      );
    }
    // `hollow` restores nothing, so s3cab prints "Nothing to restore" and creates no
    // output directory at all — correct, and it would leave the F16 snapshot as the one
    // in the bucket with no reference tree beside it. The empty directory here is the
    // harness's, not the tool's: it makes "nothing" a comparable answer rather than a
    // missing file, so a restorer that finds the set can tell it was meant to find it.
    // The damaged snapshot lands here too, with whatever s3cab wrote before it gave up —
    // a partial tree is the honest reference for a partial restore.
    mkdirSync(target, { recursive: true });
  }
}

console.log(`\nreference trees in ${reference}`);
for (const entry of readdirSync(reference)) {
  console.log(`  ${entry}  (${files(count(join(reference, entry)))})`);
}
if (exits.length > 0) {
  // `faults` and `corrupt` are broken on purpose, so a nonzero exit is theirs to give, and
  // `edge`'s off Linux, whose disks refuse or fold its [POSIX] names (fixtures.mjs). Any
  // other set here is one s3cab could not restore whole on this platform, and the
  // difference matters: a refusal it reported and carried past is a valid reference,
  // an abort that stopped the restore halfway is not.
  const expected =
    process.platform === "linux"
      ? "faults and corrupt are"
      : "faults, corrupt and edge are";
  console.log(
    `\nnonzero restore exits (${expected} the behaviour under test; read\n` +
      "any other before handing the clean room over):\n  " +
      exits.join("\n  "),
  );
}

handover(
  root,
  process.platform === "win32"
    ? [
        "install the toolchain: nothing comes as standard on Windows, and the brief\n" +
          "    tells the session not to install one.",
      ]
    : [],
);
