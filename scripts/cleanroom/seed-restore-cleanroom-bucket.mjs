/**
 * Seed the clean-room restore bucket with the golden set (ADR-0096): s3cab's backup of
 * the fixtures on every platform, then deliberate damage, stamped with a hash of the
 * spec's date, the fixtures and the seed it was made from. Every restore build reads this
 * bucket and refuses one stamped from anything else, or missing any platform's sets, so
 * this runs when the format or the fixtures change, not once per clean-room run.
 *
 * Run by .github/workflows/cleanroom-seed.yml in three steps, the platforms taking turns
 * between the first and the last:
 *
 *   --empty   if the bucket's stamp isn't this checkout's: unstamp it and empty it
 *   <root>    one platform's turn: back up its sets, suffixed with its name (`edge-linux`)
 *   --stamp   check every platform's sets are there, and stamp the bucket
 *
 *   <root>/fixtures/   the trees s3cab backs up (fixtures.mjs)
 *   <root>/.s3cab/     s3cab's home while it does
 *
 * A turn backs up what fixtures.mjs declares for its platform, and stops before touching
 * the bucket if any of it failed to build: that platform's sets would be partial for
 * every run after it. Every file's content carries the platform's name, so no two
 * platforms' sets share an object, and one's damage can't reach another's.
 *
 * Usage:
 *   node --env-file=.env.test scripts/cleanroom/seed-restore-cleanroom-bucket.mjs --empty
 *   node --env-file=.env.test scripts/cleanroom/seed-restore-cleanroom-bucket.mjs <root>
 *   node --env-file=.env.test scripts/cleanroom/seed-restore-cleanroom-bucket.mjs --stamp
 */
import {
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import {
  appendFileSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import {
  cli,
  client,
  listAll,
  readBucket,
  readCommandLine,
} from "./cleanroom.mjs";
import {
  buildFixtures,
  excludes,
  goldenSet,
  oneMinuteBefore,
  platform,
  platforms,
  reportFixtures,
  withoutTrailer,
} from "./fixtures.mjs";
import {
  missingSets,
  seedHash,
  seededHash,
  stampSeed,
} from "./restore-bucket.mjs";

const script = "seed-restore-cleanroom-bucket.mjs";
const variable = "S3CAB_TEST_BUCKET_CLEANROOM_RESTORE";
const [mode] = process.argv.slice(2);

if (mode === "--empty") {
  await empty(readBucket(script, variable, mode));
} else if (mode === "--stamp") {
  await stamp(readBucket(script, variable, mode));
} else {
  await seed(readCommandLine(script, variable));
}

/**
 * Empty the bucket for a new golden set, unless it already holds this checkout's whole.
 * Under GitHub Actions it sets the step's `reseed` output, which the platforms' turns
 * wait on.
 * @param {string} bucket
 */
async function empty(bucket) {
  // Missing sets too, or a stamped bucket that lost objects could never be reseeded by
  // the workflow the restore build sends you to.
  const stamped = await seededHash(bucket);
  const missing = await missingSets(bucket);
  const stale = stamped !== seedHash() || missing.length > 0;
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `reseed=${stale}\n`);
  }
  if (!stale) {
    console.log(
      `s3://${bucket} is already seeded from this checkout's spec, fixtures and seed.`,
    );
    return;
  }

  // A seed needs an empty repository: snapshots are immutable and a set name belongs to
  // whoever claimed it first, so `setup` would refuse, with advice (`reattach`) written
  // for a user rather than for a seed.
  //
  // There is never a reason to keep the previous golden set, so the question worth asking
  // is not "may I clear this?" but "is this bucket mine to clear?" — a variable pointing
  // somewhere forgotten, or other work under other names. The set names answer it: a
  // bucket that is a repository holding only our own names is the last seed's and goes;
  // anything else and we stop and say what we found. Ours is any name with a platform's
  // suffix, not only today's `goldenSets`: a set renamed or removed in the fixtures
  // leaves the last seed's name behind. A flag would have put that judgement on the
  // operator at the moment they are least likely to check.
  //
  // Every key is read, not just the `<set>.info` markers: a clear that died partway, going
  // in listing order, can leave a set's snapshots with neither its `.s3cab/sets/<set>/`
  // config nor its `<set>.info` beside them, and those stale snapshots would end up
  // stamped as part of the new seed.
  const keys = await listAll(bucket);
  /** @type {Set<string>} */
  const present = new Set();
  /** @type {string[]} */
  const strays = [];
  for (const key of keys) {
    const [top, name = "", set = ""] = key.split("/");
    if (top === "snapshots") {
      present.add(name.replace(/\.info$/, ""));
    } else if (top === ".s3cab" && name === "sets") {
      present.add(set);
    } else if (top !== "objects" && !/^objects\.deleted-\d+\.tsv$/.test(key)) {
      strays.push(key);
    }
  }
  // A folder marker (`snapshots/`, `.s3cab/sets/`), as the S3 console's "Create folder"
  // makes, names no set.
  present.delete("");
  const foreign = [...present].filter(
    (name) => !platforms.some((suffix) => name.endsWith(goldenSet("", suffix))),
  );
  /** @type {string[]} */
  const found = [];
  if (foreign.length > 0) {
    found.push(
      `${foreign.length} backup set${foreign.length === 1 ? "" : "s"} no ` +
        `platform's seed would name: ${foreign.join(", ")}`,
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
  await stampSeed(bucket, undefined);
  if (keys.length === 0) {
    console.log(`s3://${bucket}/ is empty and unstamped`);
    return;
  }
  console.log(
    `emptying s3://${bucket}/ — ${keys.length} object${keys.length === 1 ? "" : "s"}, ` +
      `all of it under the seeds' set names (${[...present].join(", ")})`,
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

/**
 * Stamp the bucket, once every platform's turn has left its sets there.
 * @param {string} bucket
 */
async function stamp(bucket) {
  const missing = await missingSets(bucket);
  if (missing.length > 0) {
    console.error(
      `Not stamping s3://${bucket}: it holds no snapshot of ${missing.join(", ")}.\n` +
        "A platform's turn didn't finish, so every restore build refuses the bucket until\n" +
        "a seed does.",
    );
    process.exit(2);
  }
  const hash = seedHash();
  await stampSeed(bucket, hash);
  console.log(`stamped s3://${bucket} ${hash.slice(0, 12)}…`);
}

/**
 * This platform's turn: its sets, backed up and damaged.
 * @param {{ root: string, bucket: string }} commandLine
 */
async function seed({ root, bucket }) {
  const fixtures = join(root, "fixtures");
  const home = join(root, ".s3cab");
  const { mustRun, mustWrite } = cli(home);
  /** @param {string} name a set's name in fixtures.mjs */
  const own = (name) => goldenSet(name, platform);

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

  // Built before the bucket is touched. Built for s3cab's patterns: the surrogate under
  // `edge`'s, and none of the sets a backup must refuse.
  const built = buildFixtures(fixtures, { patterns: true });
  const { sets, skipped } = built;
  reportFixtures(fixtures, built);
  if (skipped.length > 0) {
    console.error(
      `\nNot seeding: the golden set has to hold every fixture declared for ${platform}.\n` +
        "This turn wrote nothing to the bucket.",
    );
    process.exit(2);
  }

  // ── Back them up ──────────────────────────────────────────────────────────

  for (const { name, dirs } of sets) {
    console.log(`setup ${own(name)}`);
    mustRun(["setup", "--set", own(name), "--bucket", bucket, ...dirs]);
  }

  // Before the first backup, or the #excluded row never appears. A set with no patterns
  // loses setup's starter file, and backup then deletes the remote copy to match.
  for (const { name } of sets) {
    const excludePath = join(home, "sets", own(name), "exclude.txt");
    const exclude = excludes.get(name);
    if (exclude) {
      writeFileSync(excludePath, exclude);
    } else {
      rmSync(excludePath, { force: true });
    }
  }

  for (const { name } of sets) {
    console.log(`backup ${own(name)}`);
    mustWrite(["backup", own(name)], own(name));
  }

  // ── The damage ────────────────────────────────────────────────────────────

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
  mustWrite(["backup", own("edge")], own("edge"));

  // F7, unexplained damage: remove an object from the store *without* a deletion record.
  // Done through the SDK rather than `s3cab delete`, because delete's whole job is to
  // leave the record that makes an absence expected — and it is the unexplained case the
  // spec legislates for ("report it, carry on, exit nonzero") that has never been staged.
  const tornHash = sha256(join(fixtures, "faults", "torn.txt"));
  console.log(
    `tearing objects/${tornHash.slice(0, 12)}… out of the store (F7)`,
  );
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

  // Right key, wrong bytes. Not `s3cab delete` and not a tear: the object is *present*
  // and hashes to something else, so a restorer that trusts the key restores corrupt
  // content under a clean exit. s3cab catches it in writeFileAtomic (ADR-0001), skips the
  // file and carries on — the answer the spec now gives, where run 2 found it silent.
  const corruptHash = sha256(join(fixtures, "corrupt", "b-corrupt.txt"));
  console.log(
    `replacing objects/${corruptHash.slice(0, 12)}… with wrong bytes`,
  );
  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: `objects/${corruptHash}`,
      Body: "not the bytes this key promises\n",
    }),
  );

  // A snapshot cut off after its last file row, as a backup killed mid-write leaves it.
  // The closing `.` is the format's answer to that, and it has only ever been staged
  // *present* — so nothing has tested the one thing it exists for, and run 2 could only
  // note that its own completeness check went unexercised. It is published under `faults`
  // as a second snapshot (`withoutTrailer`, fixtures.mjs), backdated so the intact one
  // stays the set's latest: a *later* name would make the damaged snapshot the newest,
  // and a bare `restore --set faults` would stop there — hiding F7, which is the same
  // set's point.
  const faults = own("faults");
  const wholeName = readdirSync(join(home, "sets", faults, "snapshots"))
    .filter((entry) => entry.endsWith(".tsv.gz"))
    .sort()
    .at(-1);
  const damagedName = oneMinuteBefore(
    /** @type {string} */ (wholeName).replace(/\.tsv\.gz$/, ""),
  );
  console.log(
    `publishing snapshots/${faults}/${damagedName} cut off after its last file row`,
  );
  const whole = await client.send(
    new GetObjectCommand({
      Bucket: bucket,
      Key: `snapshots/${faults}/${wholeName}`,
    }),
  );
  const wholeBytes = await /** @type {NonNullable<typeof whole.Body>} */ (
    whole.Body
  ).transformToByteArray();
  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: `snapshots/${faults}/${damagedName}.tsv.gz`,
      Body: withoutTrailer(wholeBytes),
    }),
  );

  console.log(
    `\nseeded ${platform}'s sets into s3://${bucket}. The bucket is stamped once every\n` +
      `platform has had its turn, by --stamp. Nothing in ${root} is needed from here.`,
  );
}
