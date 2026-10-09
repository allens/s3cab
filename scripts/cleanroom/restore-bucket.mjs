/**
 * What both sides of the clean-room restore bucket share (ADR-0096): the seed that fills
 * it with the golden set, and the build that restores s3cab's reference from it. Both
 * drive the real CLI to do it, through `cli` in cleanroom.mjs.
 *
 * The golden set is stamped with a hash of what made it, as a bucket tag rather than a key:
 * a restorer works out the bucket's contents from a listing, and a key the spec doesn't
 * describe would reach its report as a finding.
 */
import {
  DeleteBucketTaggingCommand,
  GetBucketTaggingCommand,
  ListObjectsV2Command,
  PutBucketTaggingCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const client = new S3Client({});

const seedTag = "s3cab-cleanroom-seed";

// What decides the golden set's contents: the spec it is written to, the trees backed up,
// and the damage done to them. A change to any of them makes a new golden set, so the
// stamp covers all three. Each is hashed under its name, so moving a line from one file
// to another still changes the stamp. Every one is checked out with LF endings on every
// platform (.gitattributes), so a Windows build agrees with the Linux seed.
const seedInputs = [
  join("guide", "format.md"),
  join("scripts", "cleanroom", "fixtures.mjs"),
  join("scripts", "cleanroom", "seed-restore-cleanroom-bucket.mjs"),
];

/**
 * Every key in the bucket, paged. `ListObjectsV2` truncates at 1000 without saying so —
 * the very hazard `bulk` exists to expose in a restorer — so a whole listing has to
 * follow the continuation token itself.
 * @param {string} bucket
 * @param {string} [prefix]
 */
export async function listAll(bucket, prefix) {
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
}

/** The hash of this checkout's seed inputs: the spec, the fixtures and the seed. */
export function seedHash() {
  const repo = join(import.meta.dirname, "..", "..");
  const hash = createHash("sha256");
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
