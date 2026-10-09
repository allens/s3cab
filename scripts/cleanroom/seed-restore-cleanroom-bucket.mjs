/**
 * Seed the clean-room restore bucket with the golden set (ADR-0096): s3cab's backup of
 * the fixtures, then deliberate damage, stamped with the guide/format.md it was made
 * from. Every restore build reads this bucket and refuses one stamped from another spec,
 * so this runs when the format changes, not once per clean-room run.
 *
 *   <root>/fixtures/   the trees s3cab backs up (fixtures.mjs)
 *   <root>/.s3cab/     s3cab's home while it does
 *
 * Nothing in the root is needed once the bucket is seeded: delete it.
 *
 * Linux only, on a Linux filesystem. Every fixture has to exist, because the golden set
 * is what every platform's restorer meets: Windows refuses the [POSIX] names, and macOS's
 * APFS silently folds names differing only in case or Unicode normalization into one
 * file. Under WSL that means a root in the Linux home, not on /mnt/c, which is NTFS.
 *
 * Usage:
 *   node --env-file=.env.test scripts/cleanroom/seed-restore-cleanroom-bucket.mjs <root>
 */
import {
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import { readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { cli, readCommandLine } from "./cleanroom.mjs";
import {
  buildFixtures,
  excludes,
  oneMinuteBefore,
  reportFixtures,
  setNames,
  withoutTrailer,
} from "./fixtures.mjs";
import { client, listAll, specHash, stampSpec } from "./restore-bucket.mjs";

if (process.platform !== "linux") {
  console.error(
    "The restore bucket's golden set can only be seeded on Linux: every fixture has to\n" +
      "exist, and this platform can't hold them all. Run it from Linux or WSL:\n" +
      "\n" +
      "    node --env-file=.env.test scripts/cleanroom/seed-restore-cleanroom-bucket.mjs ~/s3cab.sandbox\n",
  );
  process.exit(2);
}

const { root, bucket } = readCommandLine(
  "seed-restore-cleanroom-bucket.mjs",
  "S3CAB_TEST_BUCKET_CLEANROOM_RESTORE",
);
const fixtures = join(root, "fixtures");
const home = join(root, ".s3cab");
const { mustRun } = cli(home);
const spec = specHash();

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

// Built before the bucket is touched: a golden set missing a fixture would be partial for
// every run that reads it, not just this one.
const { sets, skipped } = buildFixtures(fixtures);
reportFixtures(fixtures, sets, skipped);
if (skipped.length > 0) {
  console.error(
    "\nNot seeding: the golden set has to hold every fixture. The bucket is untouched.",
  );
  process.exit(2);
}

// ── Is the bucket ours to empty? ────────────────────────────────────────────

// A seed needs an empty repository: snapshots are immutable and a set name belongs to
// whoever claimed it first, so `setup` would refuse, with advice (`reattach`) written
// for a user rather than for a seed.
//
// There is never a reason to keep the previous golden set, so the question worth asking
// is not "may I clear this?" but "is this bucket mine to clear?" — an `.env.test`
// pointing somewhere forgotten, or other work under other names. The set names answer
// it: a bucket that is a repository holding only our own names is the last seed's and
// goes; anything else and we stop and say what we found. A flag would have put that
// judgement on the operator at the moment they are least likely to check.
//
// Every key is read, not just the `sets/` markers: a clear that died partway leaves
// `snapshots/` with no marker beside it (keys go in listing order, and `sets/` sorts
// before `snapshots/`), and those stale snapshots would end up stamped as part of the
// new seed.
const keys = await listAll(bucket);
/** @type {Set<string>} */
const present = new Set();
/** @type {string[]} */
const strays = [];
for (const key of keys) {
  const [top, name = ""] = key.split("/");
  if (top === "sets" || top === "snapshots") {
    present.add(name);
  } else if (top !== "objects" && !/^objects\.deleted-\d+\.tsv$/.test(key)) {
    strays.push(key);
  }
}
const foreign = [...present].filter((name) => !setNames.includes(name));
/** @type {string[]} */
const found = [];
if (foreign.length > 0) {
  found.push(
    `${foreign.length} backup set${foreign.length === 1 ? "" : "s"} these ` +
      `fixtures don't name: ${foreign.join(", ")}`,
  );
}
if (strays.length > 0) {
  found.push(
    `${strays.length} key${strays.length === 1 ? "" : "s"} outside an s3cab ` +
      `repository's layout, such as ${strays[0]}`,
  );
}
if (found.length > 0) {
  console.error(
    `The bucket '${bucket}' holds ${found.join(", and ")}.\n` +
      "Emptying it would take them with it, so nothing in the bucket has been touched.\n" +
      "Clear it yourself once you are sure what is in there:\n" +
      "\n" +
      `    aws s3 rm s3://${bucket}/ --recursive\n`,
  );
  process.exit(2);
}

// Unstamped first, so a seed that stops anywhere from here leaves a bucket every
// restore build refuses.
await stampSpec(bucket, undefined);
if (keys.length > 0) {
  console.log(
    `emptying s3://${bucket}/ — ${keys.length} object${keys.length === 1 ? "" : "s"}, ` +
      `all of it under these fixtures' set names (${[...present].join(", ")})`,
  );
  // 1000 per request is the API's limit, not a batch size worth tuning.
  for (let index = 0; index < keys.length; index += 1000) {
    const { Errors } = await client.send(
      new DeleteObjectsCommand({
        Bucket: bucket,
        Delete: {
          Objects: keys.slice(index, index + 1000).map((Key) => ({ Key })),
        },
      }),
    );
    // A 200 can still carry per-key failures.
    const refused = Errors ?? [];
    if (refused.length > 0) {
      throw new Error(
        `could not empty s3://${bucket}/: ${refused.length} key(s) refused, ` +
          `first ${refused[0]?.Key} (${refused[0]?.Code})`,
      );
    }
  }
}

// ── Back them up ────────────────────────────────────────────────────────────

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

// ── The damage ──────────────────────────────────────────────────────────────

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
// own completeness check went unexercised. It is published under `faults` as a second
// snapshot (`withoutTrailer`, fixtures.mjs), backdated so the intact one stays the set's
// latest: a *later* name would make the damaged snapshot the newest, and a bare
// `restore --set faults` would stop there — hiding F7, which is the same set's point.
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
await client.send(
  new PutObjectCommand({
    Bucket: bucket,
    Key: `snapshots/faults/${damagedName}.tsv.gz`,
    Body: withoutTrailer(wholeBytes),
  }),
);

// Last, so only a seed that finished is ever stamped.
await stampSpec(bucket, spec);
console.log(
  `\nseeded s3://${bucket} from guide/format.md ${spec.slice(0, 12)}…\n` +
    "\nStill to do:\n" +
    `  - delete ${root}: the bucket is all that is needed from here.\n` +
    "  - raise the bucket's expiry past the runs it has to serve, or it sweeps out from\n" +
    "    under them: scripts/setup-test-bucket.mjs --days",
);
