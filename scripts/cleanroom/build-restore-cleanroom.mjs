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
import { HeadBucketCommand } from "@aws-sdk/client-s3";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  cli,
  client,
  handover,
  listAll,
  readCommandLine,
  sessionCredentials,
  writeCleanroom,
} from "./cleanroom.mjs";
import { count, files, goldenSets } from "./fixtures.mjs";
import { missingSets, seedHash, seededHash } from "./restore-bucket.mjs";

const { root, bucket } = readCommandLine(
  "build-restore-cleanroom.mjs",
  "S3CAB_TEST_BUCKET_CLEANROOM_RESTORE",
);
const credentials = await sessionCredentials(bucket);
const cleanroom = join(root, "cleanroom");
const reference = join(cleanroom, "reference");
const { run, mustRun } = cli(join(root, ".s3cab"));

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

// Every snapshot in the bucket, one tree each, so a clean-room run can tell "I found
// nothing" from "I never looked". Enumerated from the bucket rather than from s3cab's
// local history: the damaged `faults` snapshot was published straight to S3 and exists
// nowhere else.
mkdirSync(reference, { recursive: true });
/** @type {string[]} */
const exits = [];
/** @type {Record<string, number>} each reference tree's exit, for check-restore.mjs */
const codes = {};
for (const name of goldenSets) {
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
    codes[`${name}-${snapshot}`] = result.code;
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
        ...(/^(faults|corrupt)-/.test(name) ? [] : said),
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

// Beside cleanroom/, not in it: which restores s3cab refused is the session's to work out.
writeFileSync(
  join(root, "reference-exits.json"),
  JSON.stringify(codes, null, 2) + "\n",
);

console.log(`\nreference trees in ${reference}`);
for (const entry of readdirSync(reference)) {
  console.log(`  ${entry}  (${files(count(join(reference, entry)))})`);
}
if (exits.length > 0) {
  // `faults` and `corrupt` are broken on purpose, so a nonzero exit is theirs to give, and
  // `edge`'s off Linux, whose disks refuse or fold names Linux backed up (fixtures.mjs). Any
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

handover(root, "restore", []);
