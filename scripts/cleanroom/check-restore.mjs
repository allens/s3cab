/**
 * Check a restore clean room's work (ADR-0096): run each restorer the session built,
 * `s3cab-restore` (`.exe` on Windows), once per snapshot reconcile-restore-cleanroom.mjs
 * restored a reference tree from, and compare each tree it writes with that reference
 * (compare.py). Then, for each set with more than one snapshot, once with no snapshot
 * named, against the reference of the set's last snapshot name, which s3cab takes as the
 * latest.
 *
 * Two restorers, each with its own verdict: the one in `spec-only/`, as the session left it
 * before it saw a reference, which is the evidence about the format; then the final one in
 * `cleanroom/`, which is the program harvested.
 *
 *   <root>/check/<program>-<set>-<snapshot>/restored/   what the restorer wrote
 *   <root>/check/<program>-<set>-<snapshot>.log         its and compare.py's output
 *
 * The references sit beside the clean room while it runs, at `<root>/reference`, so a
 * restorer can't copy its answers from them, and go back when it ends.
 *
 * The restorer's directory is one level down so that a file it writes outside it lands
 * where the check can see it: `faults`' hand-edited `..` row walks a naive join up two
 * levels, out of `restored/` and its set's folder. Anything new beside `restored/` or in
 * `check/` is a mismatch.
 *
 * That output is printed too, so the clean room's `check.txt` keeps it.
 *
 * Its exit has to agree with s3cab's, zero or not, from `reference-exits.json`, which
 * reconcile-restore-cleanroom.mjs leaves beside the clean room: nonzero for `faults` and
 * `corrupt`. Off Linux, an `edge` set that s3cab exited nonzero on may exit zero as a note,
 * since what a restore does with a name the disk won't hold is the tool's choice
 * (guide/format.md); its tree must still match. A signal or a timeout is a mismatch whatever s3cab's exit was.
 *
 * The restorer is handed the bucket's credentials as static keys resolved here, not the
 * clean room's, which may have expired by the time the session finishes.
 *
 * Exits 1 if anything mismatched in either restorer, 2 if the check itself couldn't run, 0
 * if only notes or nothing.
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
  readdirSync,
  renameSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import {
  client,
  exampleRoot,
  readBucket,
  restoreProgram,
  sandboxPath,
  sessionCredentials,
} from "./cleanroom.mjs";

const usage =
  "usage: node --env-file=.env.test scripts/cleanroom/check-restore.mjs <root>\n\n" +
  `e.g. node --env-file=.env.test scripts/cleanroom/check-restore.mjs ${exampleRoot}`;
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
    `${exitsFile} doesn't exist, so ${root} isn't a restore sandbox handed its\n` +
      "references. Pass the root reconcile-restore-cleanroom.mjs ran on, not the cleanroom\n" +
      "inside it.",
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
const reference = join(cleanroom, "reference");
const aside = join(root, "reference");
if (!existsSync(reference) && !existsSync(aside)) {
  console.error(
    `${reference} doesn't exist, so there is nothing to compare with. Run\n` +
      "reconcile-restore-cleanroom.mjs on this root first.",
  );
  process.exit(2);
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

/** @typedef {{ name: string, dir: string, mismatches: string[], notes: string[] }} Restorer */
/** @type {Restorer[]} */
const restorers = [
  {
    name: "spec-only",
    dir: join(root, "spec-only"),
    mismatches: [],
    notes: [],
  },
  { name: "final", dir: cleanroom, mismatches: [], notes: [] },
];
/** Each run's folder and log: anything else in `check/` is a stray. */
const known = new Set();

/**
 * Run a restorer once, into `<root>/check/<label>/restored`, and compare what it wrote with
 * the reference tree of `<set>-<snapshot>`.
 * @param {Restorer} restorer
 * @param {string} set
 * @param {string} snapshot the reference to compare with
 * @param {number} expected s3cab's exit restoring it
 * @param {string} label
 * @param {string[]} named the snapshot argument, or none for the latest
 * @returns {boolean} false if compare.py itself failed, so the check can't go on
 */
function check(
  { dir: cwd, mismatches, notes },
  set,
  snapshot,
  expected,
  label,
  named,
) {
  const dir = join(out, label, "restored");
  mkdirSync(join(out, label));
  known.add(label).add(`${label}.log`);
  // Into a file, not a pipe: spawnSync kills a child whose piped output passes maxBuffer.
  const logFile = join(out, `${label}.log`);
  const log = openSync(logFile, "w");
  const result = spawnSync(
    join(cwd, restoreProgram),
    [bucket, set, dir, ...named],
    {
      cwd,
      env,
      stdio: ["ignore", log, log],
      timeout: minutes * 60 * 1000,
      killSignal: "SIGKILL",
    },
  );
  // Whatever the exit, and removed once reported, so a later run isn't charged with it
  // and one writing the same name is still caught.
  const outside = [
    ...readdirSync(join(out, label))
      .filter((name) => name !== "restored")
      .map((name) => join(label, name)),
    ...readdirSync(out).filter((name) => !known.has(name)),
  ];
  /** @type {string[]} */
  const kept = [];
  for (const name of outside) {
    try {
      rmSync(join(out, name), { recursive: true, force: true });
    } catch (e) {
      // Windows won't delete a file still open, as by a child the timeout's kill missed.
      known.add(name);
      kept.push(
        `couldn't remove ${name} (${/** @type {NodeJS.ErrnoException} */ (e).code})`,
      );
    }
  }
  if (outside.length > 0) {
    mismatches.push(
      `${label}: wrote outside its directory: ${[outside.join(", "), ...kept].join("; ")}`,
    );
  }
  const error = /** @type {NodeJS.ErrnoException | undefined} */ (result.error);
  /** @type {string | undefined} */
  let broke;
  if (error?.code === "ETIMEDOUT") {
    mismatches.push(`${label}: timed out after ${minutes} minutes`);
  } else if (error) {
    mismatches.push(`${label}: couldn't run it (${error.message})`);
  } else if (result.signal) {
    mismatches.push(`${label}: killed by ${result.signal}`);
  } else {
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
        join(aside, `${set}-${snapshot}`),
      ],
      { stdio: ["ignore", log, log] },
    );
    if (compared.status === 1) {
      mismatches.push(`${label}: not the reference tree`);
    } else if (compared.status !== 0) {
      broke =
        compared.error?.message ?? compared.signal ?? `exit ${compared.status}`;
    }
  }
  closeSync(log);
  console.log(`-- ${label}`);
  // Raw bytes: a restorer may print the `edge` sets' names, which aren't all UTF-8.
  const said = readFileSync(logFile);
  process.stdout.write(said);
  if (said.length > 0 && said.at(-1) !== 0x0a) {
    process.stdout.write("\n");
  }
  if (broke) {
    console.log(`couldn't run compare.py (${broke})`);
    return false;
  }
  return true;
}

// A check that stopped partway has left them aside already.
if (existsSync(reference)) {
  renameSync(reference, aside);
}
let stopped = false;
try {
  restorers: for (const restorer of restorers) {
    if (!existsSync(join(restorer.dir, restoreProgram))) {
      restorer.mismatches.push(`no ${restoreProgram} in ${restorer.dir}`);
      continue;
    }
    for (const [set, exits] of Object.entries(codes)) {
      const snapshots = Object.entries(exits).sort(([a], [b]) =>
        a < b ? -1 : 1,
      );
      for (const [snapshot, expected] of snapshots) {
        const label = `${restorer.name}-${set}-${snapshot}`;
        stopped = !check(restorer, set, snapshot, expected, label, [snapshot]);
        if (stopped) {
          break restorers;
        }
      }
      const latest = snapshots.at(-1);
      if (latest && snapshots.length > 1) {
        const label = `${restorer.name}-${set}-latest`;
        stopped = !check(restorer, set, ...latest, label, []);
        if (stopped) {
          break restorers;
        }
      }
    }
  }
} finally {
  renameSync(aside, reference);
}

for (const { name, mismatches, notes } of restorers) {
  const found =
    mismatches.length === 0
      ? "matches"
      : `${mismatches.length} mismatch${mismatches.length === 1 ? "" : "es"}`;
  console.log(`${name}: ${found}`);
  for (const mismatch of mismatches) {
    console.log(`  mismatch: ${mismatch}`);
  }
  for (const note of notes) {
    console.log(`  note: ${note}`);
  }
}
if (stopped) {
  console.log("stopped: compare.py failed");
}
process.exitCode = stopped
  ? 2
  : restorers.some(({ mismatches }) => mismatches.length > 0)
    ? 1
    : 0;
