/**
 * The restore bucket's stamp (ADR-0096), shared by the seed that writes it and the build
 * that refuses a golden set made from anything but this checkout.
 *
 * The golden set is stamped with a hash of what made it, as a bucket tag rather than a key:
 * a restorer works out the bucket's contents from a listing, and a key the spec doesn't
 * describe would reach its report as a finding.
 */
import {
  DeleteBucketTaggingCommand,
  GetBucketTaggingCommand,
  PutBucketTaggingCommand,
} from "@aws-sdk/client-s3";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { client, listAll } from "./cleanroom.mjs";
import { goldenSets } from "./fixtures.mjs";

const seedTag = "s3cab-cleanroom-seed";

// What decides the golden set's contents: the format it is written in, the trees backed
// up, where they were backed up from (the workflow's roots, which the snapshots record),
// and the damage done to them. The format is the spec's date, not format.md's bytes:
// the date changes when the format does and never for a change of wording, which would
// otherwise void the bucket for nothing. Each file is hashed under its name, so moving a
// line from one to the other still changes the stamp. All are checked out with LF
// endings on every platform (.gitattributes), so a Windows build agrees with every seed.
// The workflow's on.push.paths lists the same files.
const seedInputs = [
  join("scripts", "cleanroom", "fixtures.mjs"),
  join("scripts", "cleanroom", "seed-restore-cleanroom-bucket.mjs"),
  join(".github", "workflows", "cleanroom-seed.yml"),
];

/** The hash of this checkout's seed inputs: the spec's date, the fixtures and the seed. */
export function seedHash() {
  const repo = join(import.meta.dirname, "..", "..");
  const spec = readFileSync(join(repo, "guide", "format.md"), "utf8");
  const [, date] = /This is the spec of (\d{4}-\d{2}-\d{2})\./.exec(spec) ?? [];
  if (!date) {
    throw new Error(
      'guide/format.md names no spec date ("This is the spec of YYYY-MM-DD.")',
    );
  }
  const hash = createHash("sha256");
  hash.update(`spec ${date}\0`);
  for (const input of seedInputs) {
    hash.update(`${input.replaceAll("\\", "/")}\0`);
    hash.update(readFileSync(join(repo, input)));
    hash.update("\0");
  }
  return hash.digest("hex");
}

/**
 * The seed hash the bucket was stamped with, or undefined if it carries none.
 * @param {string} bucket
 */
export async function seededHash(bucket) {
  const tags = await bucketTags(bucket);
  return tags.find(({ Key }) => Key === seedTag)?.Value;
}

/**
 * The golden set's sets the bucket holds no snapshot of: every platform seeds its own, so
 * a seed that stopped after one platform leaves the others' missing.
 * @param {string} bucket
 */
export async function missingSets(bucket) {
  const keys = await listAll(bucket, "snapshots/");
  const snapshots = keys.filter((key) => key.endsWith(".tsv.gz"));
  return goldenSets.filter(
    (name) => !snapshots.some((key) => key.startsWith(`snapshots/${name}/`)),
  );
}

/**
 * Stamp the bucket with a seed hash, or remove the stamp. The seed removes it before it
 * empties the bucket and stamps it last, so a seed that fails halfway leaves a bucket
 * every restore build refuses. Other tags on the bucket are kept: a put replaces the
 * whole set.
 * @param {string} bucket
 * @param {string | undefined} hash
 */
export async function stampSeed(bucket, hash) {
  const others = (await bucketTags(bucket)).filter(
    ({ Key }) => Key !== seedTag,
  );
  const tagSet = hash ? [...others, { Key: seedTag, Value: hash }] : others;
  if (tagSet.length === 0) {
    await client.send(new DeleteBucketTaggingCommand({ Bucket: bucket }));
    return;
  }
  await client.send(
    new PutBucketTaggingCommand({
      Bucket: bucket,
      Tagging: { TagSet: tagSet },
    }),
  );
}

/** @param {string} bucket */
async function bucketTags(bucket) {
  try {
    const response = await client.send(
      new GetBucketTaggingCommand({ Bucket: bucket }),
    );
    return response.TagSet ?? [];
  } catch (error) {
    // A bucket with no tags answers with an error rather than an empty set.
    if (error instanceof Error && error.name === "NoSuchTagSet") {
      return [];
    }
    throw error;
  }
}
