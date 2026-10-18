/**
 * Check a restore clean room's work (ADR-0096): run the restorer the session built,
 * `cleanroom/s3cab-restore` (`.exe` on Windows), once per snapshot build-restore-cleanroom.mjs
 * restored a reference tree from, and compare each tree it writes with that reference
 * (compare.py). Then, for each set with more than one snapshot, once with no snapshot named,
 * against the reference of the set's last snapshot name, which s3cab takes as the latest.
 *
 *   <root>/check/<set>-<snapshot>/   what the restorer wrote, and its output beside it
 *
 * The restorer's output is printed too, so the clean room's `check.txt` keeps it.
 *
 * Its exit has to agree with s3cab's, zero or not, from `reference-exits.json`, which the
 * build leaves beside the clean room: nonzero for `faults` and `corrupt`. Off Linux, an `edge`
 * set that s3cab exited nonzero on may exit zero as a note, since what a restore does with a
 * name the disk won't hold is the tool's choice (guide/format.md); its tree must still match. A signal or a timeout is a
 * mismatch whatever s3cab's exit was.
 *
 * The restorer is handed the bucket's credentials as static keys resolved here, not the
 * clean room's, which may have expired by the time the session finishes.
 *
 * Exits 1 if anything mismatched, 2 if the check itself couldn't run, 0 if only notes or
 * nothing.
 *
 * Usage:
 *   node --env-file=.env.test scripts/cleanroom/check-restore.mjs <root>
 */
import { HeadBucketCommand } from "@aws-sdk/client-s3";
import { spawnSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import {
  client,
  readBucket,
  restoreProgram,
  sandboxPath,
  sessionCredentials,
} from "./cleanroom.mjs";

const usage =
  "usage: node --env-file=.env.test scripts/cleanroom/check-restore.mjs <root>\n\n" +
  "e.g. node --env-file=.env.test scripts/cleanroom/check-restore.mjs ~/s3cab.sandbox";
const [arg, ...extra] = process.argv.slice(2);
if (!arg || extra.length > 0) {
  console.error(usage);
  process.exit(2);
}
const bucket = readBucket(
  "check-restore.mjs",
  "S3CAB_TEST_BUCKET_CLEANROOM_RESTORE",
  arg,
);
const root = sandboxPath(arg);
const cleanroom = join(root, "cleanroom");
const exitsFile = join(root, "reference-exits.json");
if (!existsSync(exitsFile)) {
  console.error(
    `${exitsFile} doesn't exist, so ${root} isn't a restore sandbox. Pass the root\n` +
      "that build-restore-cleanroom.mjs built, not the cleanroom inside it.",
  );
  process.exit(2);
}
/** @type {Record<string, Record<string, number>>} */
const codes = JSON.parse(readFileSync(exitsFile, "utf8"));
if (!Object.values(codes).some((exits) => Object.keys(exits).length > 0)) {
  console.error(
    `${exitsFile} lists no snapshots, so there is nothing to check.`,
  );
  process.exit(2);
}
const program = join(cleanroom, restoreProgram);
if (!existsSync(program)) {
  console.log(
    `1 mismatch\n  mismatch: the session left no ${restoreProgram} in ${cleanroom}`,
  );
  process.exit(1);
}

const credentials = await sessionCredentials(bucket);
const { BucketRegion } = await client.send(
  new HeadBucketCommand({ Bucket: bucket }),
);
/** @type {NodeJS.ProcessEnv} */
const env = {
  ...process.env,
  AWS_ACCESS_KEY_ID: credentials.accessKeyId,
  AWS_SECRET_ACCESS_KEY: credentials.secretAccessKey,
  AWS_SESSION_TOKEN: credentials.sessionToken,
  AWS_REGION: BucketRegion,
  BUCKET: bucket,
};

const out = join(root, "check");
rmSync(out, { recursive: true, force: true });
mkdirSync(out);
const minutes = 20;

/** @type {string[]} */
const mismatches = [];
/** @type {string[]} */
const notes = [];

/**
 * Run the restorer once, into `<root>/check/<label>`, and compare what it wrote with the
 * reference tree of `<set>-<snapshot>`.
 * @param {string} set
 * @param {string} snapshot the reference to compare with
 * @param {number} expected s3cab's exit restoring it
 * @param {string} label
 * @param {string[]} named the snapshot argument, or none for the latest
 */
function check(set, snapshot, expected, label, named) {
  const dir = join(out, label);
  // Into a file, not a pipe: spawnSync kills a child whose piped output passes maxBuffer.
  const logFile = join(out, `${label}.log`);
  const log = openSync(logFile, "w");
  const result = spawnSync(program, [bucket, set, dir, ...named], {
    cwd: cleanroom,
    env,
    stdio: ["ignore", log, log],
    timeout: minutes * 60 * 1000,
    killSignal: "SIGKILL",
  });
  closeSync(log);
  console.log(`-- ${label}`);
  // Raw bytes: a restorer may print the `edge` sets' names, which aren't all UTF-8.
  const said = readFileSync(logFile);
  process.stdout.write(said);
  if (said.length > 0 && said.at(-1) !== 0x0a) {
    process.stdout.write("\n");
  }
  const error = /** @type {NodeJS.ErrnoException | undefined} */ (result.error);
  if (error?.code === "ETIMEDOUT") {
    mismatches.push(`${label}: timed out after ${minutes} minutes`);
    return;
  }
  if (error) {
    mismatches.push(`${label}: couldn't run it (${error.message})`);
    return;
  }
  if (result.signal) {
    mismatches.push(`${label}: killed by ${result.signal}`);
    return;
  }
  if ((result.status === 0) !== (expected === 0)) {
    (process.platform !== "linux" && set.startsWith("edge-") && expected !== 0
      ? notes
      : mismatches
    ).push(`${label}: exit ${result.status}, where s3cab's was ${expected}`);
  }

  // A restore with nothing to write may make no directory, and the build made the
  // reference an empty one, so that "nothing" compares.
  mkdirSync(dir, { recursive: true });
  // Not python3 on Windows: there it is usually the Store alias, which runs and exits 9009.
  const compared = spawnSync(
    process.platform === "win32" ? "python" : "python3",
    [
      join(import.meta.dirname, "compare.py"),
      dir,
      join(cleanroom, "reference", `${set}-${snapshot}`),
    ],
    { encoding: "utf8" },
  );
  if (compared.status !== 0 && compared.status !== 1) {
    console.error(
      `couldn't run compare.py (${compared.error?.message ?? compared.signal ?? `exit ${compared.status}`})`,
    );
    process.stderr.write(compared.stderr ?? "");
    process.exit(2);
  }
  process.stdout.write(compared.stdout);
  if (compared.status === 1) {
    mismatches.push(`${label}: not the reference tree`);
  }
}

for (const [set, exits] of Object.entries(codes)) {
  const snapshots = Object.entries(exits).sort(([a], [b]) => (a < b ? -1 : 1));
  for (const [snapshot, expected] of snapshots) {
    check(set, snapshot, expected, `${set}-${snapshot}`, [snapshot]);
  }
  const latest = snapshots.at(-1);
  if (latest && snapshots.length > 1) {
    check(set, ...latest, `${set}-latest`, []);
  }
}

console.log(
  mismatches.length === 0
    ? "matches"
    : `${mismatches.length} mismatch${mismatches.length === 1 ? "" : "es"}`,
);
for (const mismatch of mismatches) {
  console.log(`  mismatch: ${mismatch}`);
}
for (const note of notes) {
  console.log(`  note: ${note}`);
}
process.exitCode = mismatches.length > 0 ? 1 : 0;
