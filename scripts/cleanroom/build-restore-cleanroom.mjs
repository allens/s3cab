/**
 * Build a restore sandbox (ADR-0096): a clean room for a restorer, the bucket it restores
 * from, and the reference trees its output is compared with.
 *
 *   <root>/cleanroom/   the session's: spec, brief, credentials, and reference/ — what
 *                       s3cab itself restores from every snapshot in the bucket
 *   <root>/fixtures/    the trees s3cab backs up (fixtures.mjs)
 *   <root>/.s3cab/      s3cab's home while it does: setup, snapshots. Never the
 *                       session's to see, which is why it is beside cleanroom/
 *
 * Runs the real CLI as a subprocess, so `reference/` is what the tool itself produces
 * and the script has no privileged access to s3cab's internals. S3CAB_HOME is pointed
 * at `<root>/.s3cab`, so the fixture sets never touch your real ~/.s3cab while ~/.aws
 * credentials keep working. The session doesn't run s3cab for its own comparison: the
 * npm package ships source (ADR-0017), so installing it would put src/ in reach.
 *
 * `reference/` holds what s3cab restored, not the fixtures: a correct restore
 * legitimately differs from its source (no empty directories, no symlinks, mtimes
 * rounded to the millisecond), so comparing against the trees would fail a restorer for
 * being right.
 *
 * Usage:
 *   node --env-file=.env.test scripts/cleanroom/build-restore-cleanroom.mjs [--reference-only] <root>
 *   … --reference-only   the Windows half of a run: the bucket was filled by a full
 *                        build from WSL, where every fixture can exist; this builds the
 *                        clean room and reference/ from it, with no fixtures and no
 *                        emptying
 */
import {
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { spawnSync } from "node:child_process";
import {
  handover,
  readCommandLine,
  sessionCredentials,
  writeCleanroom,
} from "./cleanroom.mjs";
import {
  buildFixtures,
  count,
  excludes,
  files,
  reportFixtures,
  setNames,
} from "./fixtures.mjs";

const { root, bucket, values } = readCommandLine(
  "build-restore-cleanroom.mjs",
  ["reference-only"],
);
const referenceOnly = values["reference-only"] === true;
const credentials = await sessionCredentials(bucket);
const cleanroom = join(root, "cleanroom");
const reference = join(cleanroom, "reference");
const fixtures = join(root, "fixtures");
const home = join(root, ".s3cab");
const s3cab = join(import.meta.dirname, "..", "..", "src", "s3cab.mjs");
const windows = process.platform === "win32";

/**
 * Run the real CLI, with s3cab's home pointed at the sandbox. Returns the exit code
 * rather than throwing on failure: `faults` restores from a deliberately torn
 * repository, where a nonzero exit is the behaviour under test.
 * @param {string[]} argv
 */
const run = (argv) => {
  const result = spawnSync(process.execPath, [s3cab, ...argv], {
    env: { ...process.env, S3CAB_HOME: home },
    encoding: "utf8",
  });
  if (result.error) {
    throw result.error;
  }
  return { code: result.status ?? 1, out: result.stdout, err: result.stderr };
};

/** @param {string[]} argv */
const mustRun = (argv) => {
  const result = run(argv);
  if (result.code !== 0) {
    throw new Error(
      `s3cab ${argv.join(" ")} exited ${result.code}\n${result.out}\n${result.err}`,
    );
  }
  return result;
};

/** @param {string} path */
const sha256 = (path) =>
  createHash("sha256").update(readFileSync(path)).digest("hex");

// Wall-clock minute precision names a snapshot, and a second snapshot of a set in the
// same minute is an error rather than an overwrite (guide/format.md, "Snapshots are
// immutable"). Sets are backed up round-robin so the clock moves on its own where it
// can; this is the fallback when a set genuinely needs two generations back to back.
const waitForNextMinute = async () => {
  const start = new Date().getMinutes();
  process.stdout.write("  waiting for the clock to tick over");
  while (new Date().getMinutes() === start) {
    await new Promise((r) => setTimeout(r, 2000));
    process.stdout.write(".");
  }
  process.stdout.write("\n");
};

/**
 * The snapshot name one minute before this one. Used once, to name the damaged copy
 * staged below: a snapshot name is a timestamp, so a *later* one would make the damaged
 * snapshot `faults`'s newest and a bare `restore --set faults` would stop there — hiding
 * F7, which is the same set's point. Backdating leaves the intact snapshot as the latest
 * and the damaged one reachable only by asking for it by name.
 *
 * Snapshot names are *local* time, so this parses and prints as UTC throughout: both
 * ends of the arithmetic use the same zone, so the answer is the local name one minute
 * back, and no offset is ever applied.
 * @param {string} name e.g. `2026-08-20T1432`
 */
const oneMinuteBefore = (name) => {
  const stamp = new Date(`${name.slice(0, 13)}:${name.slice(13)}:00Z`);
  stamp.setUTCMinutes(stamp.getUTCMinutes() - 1);
  return stamp.toISOString().slice(0, 16).replace(":", "");
};

// ── The bucket ──────────────────────────────────────────────────────────────

const client = new S3Client({});

/**
 * Every key in the bucket, paged. `ListObjectsV2` truncates at 1000 without saying so —
 * the very hazard `bulk` exists to expose in a restorer — so the one place this script
 * reads a whole listing has to follow the continuation token itself.
 * @param {string} [prefix]
 */
const listAll = async (prefix) => {
  /** @type {string[]} */
  const keys = [];
  /** @type {string | undefined} */
  let token;
  do {
    const page = await client.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefix,
        ContinuationToken: token,
      }),
    );
    keys.push(...(page.Contents ?? []).map(({ Key }) => Key ?? ""));
    token = page.NextContinuationToken;
  } while (token);
  return keys;
};

writeCleanroom(cleanroom, "restore", bucket, credentials);

// ── --reference-only: the Windows half of a run ─────────────────────────────

// The fixtures are already in the bucket, built elsewhere, and only the comparison target
// is built here. This is for Windows, which cannot build the [POSIX] fixtures but is
// exactly where a restorer has to cope with them: build in full from WSL, then run this on
// Windows, because what a *correct* restore leaves behind differs by platform — names NTFS
// refuses are absent, the case-colliding pair restores as one file, and mtimes land exact
// to the millisecond where ext4 keeps a sub-microsecond float error. A reference built on
// Linux would score a Windows restorer against a restore it could not have produced.
//
// It writes one thing to the bucket: `reattach` is how a second machine gets a set to
// restore from, and it re-stamps each set's `info` with this machine as OWNER — the
// value, never the syntax F12 measures. Nothing is emptied.
if (referenceOnly) {
  for (const name of setNames) {
    console.log(`reattach ${name}`);
    mustRun(["reattach", name, "--bucket", bucket]);
  }
  await restoreReferences();
  handover(root, windowsTodo());
  process.exit(0);
}

// ── Is the bucket ours to empty? ────────────────────────────────────────────

// A build needs an empty repository: snapshots are immutable and a set name belongs to
// whoever claimed it first, so `setup` would refuse — minutes in, after the trees are
// built, with advice (`reattach`) written for a user rather than for a build.
//
// There is never a reason to keep the previous run's sets, so the question worth asking
// is not "may I clear this?" but "is this bucket mine to clear?" — an `.env.test`
// pointing somewhere forgotten, or a backup run still in progress under other names. The
// set names answer it: a bucket holding only our own names is this script's or the
// clean-room backup's leftovers and goes; anything else and we stop and say what we
// found. A flag would have put that judgement on the operator at the moment they are
// least likely to check.
const listing = await client.send(
  new ListObjectsV2Command({
    Bucket: bucket,
    Prefix: "sets/",
    Delimiter: "/",
  }),
);
const present = (listing.CommonPrefixes ?? []).map((entry) =>
  (entry.Prefix ?? "").slice("sets/".length).replace(/\/$/, ""),
);
const foreign = present.filter((name) => !setNames.includes(name));
if (foreign.length > 0) {
  console.error(
    `The bucket '${bucket}' holds ${foreign.length} backup ` +
      `set${foreign.length === 1 ? "" : "s"} these fixtures don't name: ` +
      `${foreign.join(", ")}.\n` +
      "Emptying it would take them with it, so nothing in the bucket has been touched.\n" +
      "Clear it yourself once you are sure what is in there:\n" +
      "\n" +
      `    aws s3 rm s3://${bucket}/ --recursive\n`,
  );
  process.exit(2);
}
if (present.length > 0) {
  const keys = await listAll();
  console.log(
    `emptying s3://${bucket}/ — ${keys.length} object${keys.length === 1 ? "" : "s"}, ` +
      `all of it under these fixtures' set names (${present.join(", ")})`,
  );
  // 1000 per request is the API's limit, not a batch size worth tuning.
  for (let index = 0; index < keys.length; index += 1000) {
    await client.send(
      new DeleteObjectsCommand({
        Bucket: bucket,
        Delete: {
          Objects: keys.slice(index, index + 1000).map((Key) => ({ Key })),
        },
      }),
    );
  }
}

// ── Back them up ────────────────────────────────────────────────────────────

const { sets, skipped } = buildFixtures(fixtures);
reportFixtures(fixtures, sets, skipped);

for (const [name, dirs] of sets) {
  console.log(`setup ${name}`);
  mustRun(["setup", "--set", name, "--bucket", bucket, ...dirs]);
}

// Before the first backup, or the #EXCLUDED row never appears. A set with no patterns
// loses setup's starter file, and backup then deletes the remote copy to match.
for (const [name] of sets) {
  const excludePath = join(home, "sets", name, "exclude.txt");
  const exclude = excludes.get(name);
  if (exclude) {
    writeFileSync(excludePath, exclude);
  } else {
    rmSync(excludePath, { force: true });
  }
}

for (const [name] of sets) {
  console.log(`backup ${name}`);
  mustRun(["backup", name]);
}

// F5, presence wins: delete a file's content from the repository (which writes a
// deletion record and removes the object), then back the set up again with the file
// still on disk. The object returns; the record stays forever. A restorer that treats
// records as authoritative skips a file it could have restored — silently, reporting
// success. The first snapshot is the one that exercises it, so it has to already exist.
console.log("delete + re-backup (F5: presence wins)");
mustRun([
  "delete",
  "--bucket",
  bucket,
  "--force",
  sha256(join(fixtures, "edge", "dedup-a.txt")),
]);
await waitForNextMinute();
mustRun(["backup", "edge"]);

// F7, unexplained damage: remove an object from the store *without* a deletion record.
// Done through the SDK rather than `s3cab delete`, because delete's whole job is to
// leave the record that makes an absence expected — and it is the unexplained case the
// spec legislates for ("report it, carry on, exit nonzero") that has never been staged.
const tornHash = sha256(join(fixtures, "faults", "torn.txt"));
console.log(`tearing objects/${tornHash.slice(0, 12)}… out of the store (F7)`);
await client.send(
  new DeleteObjectCommand({ Bucket: bucket, Key: `objects/${tornHash}` }),
);

// The explained absence, and the counterpart to F5 above: the same `delete`, with no
// re-backup after it. The snapshot still names the file, the object is gone, and a
// record says so — which is the case the spec answers with "skips them gracefully with
// their date" and the one run 2 reported it had never been able to run.
console.log("delete without re-backup (the recorded-deletion skip)");
mustRun([
  "delete",
  "--bucket",
  bucket,
  "--force",
  sha256(join(fixtures, "faults", "deleted.txt")),
]);

// Right key, wrong bytes. Not `s3cab delete` and not a tear: the object is *present* and
// hashes to something else, so a restorer that trusts the key restores corrupt content
// under a clean exit. s3cab catches it in writeFileAtomic (ADR-0001), skips the file and
// carries on — the answer the spec now gives, where run 2 found it silent.
const corruptHash = sha256(join(fixtures, "corrupt", "b-corrupt.txt"));
console.log(`replacing objects/${corruptHash.slice(0, 12)}… with wrong bytes`);
await client.send(
  new PutObjectCommand({
    Bucket: bucket,
    Key: `objects/${corruptHash}`,
    Body: "not the bytes this key promises\n",
  }),
);

// A snapshot with its `#END` trailer cut off. The trailer is the format's answer to a
// backup killed mid-write (ADR-0082), and it has only ever been staged *present* — so
// nothing has tested the one thing it exists for, and run 2 could only note that its
// own completeness check went unexercised. Truncating the *compressed* bytes would test
// gunzip's own check instead, so this decompresses, drops the trailer line, and
// recompresses: a well-formed gzip stream missing its last line, which is precisely what a
// reader has to notice. It is published under `faults` as a second snapshot, backdated
// so the intact one stays the set's latest.
const wholeName = readdirSync(join(home, "sets", "faults", "snapshots"))
  .filter((entry) => entry.endsWith(".tsv.gz"))
  .sort()
  .at(-1);
const damagedName = oneMinuteBefore(
  /** @type {string} */ (wholeName).replace(/\.tsv\.gz$/, ""),
);
console.log(`publishing snapshots/faults/${damagedName} with no #END trailer`);
const whole = await client.send(
  new GetObjectCommand({
    Bucket: bucket,
    Key: `snapshots/faults/${wholeName}`,
  }),
);
const wholeBytes = await /** @type {NonNullable<typeof whole.Body>} */ (
  whole.Body
).transformToByteArray();
const text = gunzipSync(wholeBytes).toString("utf8");
await client.send(
  new PutObjectCommand({
    Bucket: bucket,
    Key: `snapshots/faults/${damagedName}.tsv.gz`,
    Body: gzipSync(
      Buffer.from(text.slice(0, text.lastIndexOf("#END")), "utf8"),
    ),
  }),
);

// ── The reference restores ──────────────────────────────────────────────────

await restoreReferences();
handover(root, windows ? windowsTodo() : []);

/** What a Windows build leaves to do by hand. */
function windowsTodo() {
  return [
    "install the toolchain: nothing comes as standard on Windows, and the brief\n" +
      "    tells the session not to install one.",
  ];
}

/**
 * Restore every snapshot in the bucket into `reference/`, one tree each, so a clean-room
 * run can tell "I found nothing" from "I never looked". Enumerated from the bucket, not
 * from s3cab's local history: the damaged `faults` snapshot was published straight to S3
 * and exists nowhere else, and under --reference-only there is no local history at all.
 */
async function restoreReferences() {
  mkdirSync(reference, { recursive: true });

  /** @type {string[]} */
  const exits = [];
  for (const name of setNames) {
    const prefix = `snapshots/${name}/`;
    const keys = await listAll(prefix);
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
    // `faults` and `corrupt` are broken on purpose, so a nonzero exit is theirs to give.
    // Any other set here is one s3cab could not restore whole on this platform, and the
    // difference matters: a refusal it reported and carried past is a valid reference,
    // an abort that stopped the restore halfway is not.
    console.log(
      "\nnonzero restore exits (faults and corrupt are the behaviour under test; read\n" +
        "any other before handing the clean room over):\n  " +
        exits.join("\n  "),
    );
  }
}
