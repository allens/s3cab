/**
 * Between a restore clean room's two phases (ADR-0096): keep the clean room as phase 1 left
 * it, then hand it fresh keys, s3cab's own restores of every snapshot to compare against,
 * and PHASE2.md.
 *
 *   <root>/phase1/               the clean room as phase 1 left it, credentials removed, so
 *                                its report provably predates every reference
 *   <root>/cleanroom/reference/  what s3cab itself restores from every snapshot in the bucket
 *   <root>/reference-exits.json  each of those restores' exit, for check-restore.mjs
 *
 * Built only now, not with the clean room, so no reference exists anywhere while phase 1
 * runs: on Windows nothing but the brief keeps a session inside its clean room.
 *
 * It has to run on the platform under test: what a *correct* restore leaves behind differs
 * by platform — names NTFS refuses are absent, the case-colliding pair restores as one file,
 * and mtimes land exact to the millisecond where ext4 keeps a sub-microsecond float error. A
 * reference built elsewhere would score a restorer against a restore it could not have
 * produced. The session doesn't run s3cab for its own comparison: the npm package ships
 * source (ADR-0017), so installing it would put src/ in reach.
 *
 * `reference/` holds what s3cab restored, not the fixtures: a correct restore
 * legitimately differs from its source (no empty directories, no symlinks, mtimes
 * rounded to the millisecond), so comparing against the trees would fail a restorer for
 * being right.
 *
 * Usage:
 *   node --env-file=.env.test scripts/cleanroom/phase2-restore-cleanroom.mjs <root>
 */
import { HeadBucketCommand } from "@aws-sdk/client-s3";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import {
  cli,
  client,
  credentialsFile,
  listAll,
  readBucket,
  runCommand,
  sandboxPath,
  sessionCredentials,
  writeCredentials,
  writePhase2,
} from "./cleanroom.mjs";
import { count, files, goldenSets } from "./fixtures.mjs";

const usage =
  "usage: node --env-file=.env.test scripts/cleanroom/phase2-restore-cleanroom.mjs <root>\n\n" +
  "e.g. node --env-file=.env.test scripts/cleanroom/phase2-restore-cleanroom.mjs ~/s3cab.sandbox";
const [arg, ...extra] = process.argv.slice(2);
if (!arg || extra.length > 0) {
  console.error(usage);
  process.exit(2);
}
const bucket = readBucket(
  "phase2-restore-cleanroom.mjs",
  "S3CAB_TEST_BUCKET_CLEANROOM_RESTORE",
  arg,
);
const root = sandboxPath(arg);
const cleanroom = join(root, "cleanroom");
const frozen = join(root, "phase1");
const reference = join(cleanroom, "reference");
if (!existsSync(join(root, ".s3cab"))) {
  console.error(
    `${root} isn't a restore sandbox: pass the root that build-restore-cleanroom.mjs\n` +
      "built, not the cleanroom inside it.",
  );
  process.exit(2);
}
if (existsSync(frozen)) {
  console.error(
    `${root} has been handed its references already, and a second freeze would\n` +
      "overwrite the report phase 1 left.",
  );
  process.exit(2);
}

// Before the freeze, which blocks a rerun: a lapsed SSO session fails here with nothing
// written.
const credentials = await sessionCredentials(bucket);
// The bucket's own region, as the build named it in ENVIRONMENT.md.
const { BucketRegion } = await client.send(
  new HeadBucketCommand({ Bucket: bucket }),
);
process.env.AWS_REGION = BucketRegion;

cpSync(cleanroom, frozen, {
  recursive: true,
  filter: (path) => basename(path) !== credentialsFile,
});
console.log(`phase 1's clean room kept in ${frozen}`);

// Fresh keys, since when phase 2 starts is the operator's to choose and the build's may
// have lapsed by then; PHASE2.md states their expiry. Not the whole clean room again:
// that would hand phase 2 this tree's spec and brief, not the ones phase 1 read.
writeCredentials(cleanroom, credentials, bucket, BucketRegion);

const { run } = cli(join(root, ".s3cab"));

// Every snapshot in the bucket, one tree each, so a clean-room run can tell "I found
// nothing" from "I never looked". Enumerated from the bucket rather than from s3cab's
// local history: the damaged `faults` snapshot was published straight to S3 and exists
// nowhere else. A reference/ phase 1 made of its own is kept in phase1/.
rmSync(reference, { recursive: true, force: true });
mkdirSync(reference);
/** @type {string[]} */
const exits = [];
/** @type {Record<string, Record<string, number>>} each reference tree's exit, by set and snapshot, for check-restore.mjs */
const codes = {};
for (const name of goldenSets) {
  codes[name] = {};
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
    codes[name][snapshot] = result.code;
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
writePhase2(cleanroom, credentials);

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
      "any other before resuming the session):\n  " +
      exits.join("\n  "),
  );
}
console.log(
  `\nResume the session from ${cleanroom}, with phase 1's session id:\n` +
    `    ${runCommand("restore", true)}`,
);
