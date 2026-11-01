// The bucket behind the recover-by-hand challenge (site/challenge.md): a
// repository laid out as guide/format.md says, written as static files into
// the built site, so the challenge needs no real bucket to pay for or keep
// keys to. It is the docs' story (test/helpers/story.mjs): the photos set's
// backups still in the bucket, written by s3cab's own writer, so the bucket
// follows the format of the s3cab that builds it. Its world is Windows, as
// the story's LAPTOP is. Every instant is a story snapshot's minute plus an
// offset fixed here, so a rebuild on the same OS serves the same bytes: gzip's
// header records the OS, and Cloudflare builds on Linux.

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import pkg from "../../package.json" with { type: "json" };
import { formatInfo } from "../../src/lib/set-marker.mjs";
import {
  formatLine,
  snapshotFileName,
  SPEC_DATE,
  stringifySnapshot,
  withSnapshotFile,
} from "../../src/lib/snapshot-file.mjs";
import {
  backedUp,
  bucket,
  filesAt,
  photo,
  sets,
  timeline,
  worlds,
  zone,
} from "../../test/helpers/story.mjs";

/** @import { Props } from "../../src/lib/snapshot-file.mjs" */

/**
 * The real bytes behind the story's contents, by fill. A file of any other
 * content (the rest of the library, the footage since deleted) is left out,
 * so the bucket stays a few kilobytes.
 * @type {Record<string, string>}
 */
const samples = {
  b: "beach.jpg",
  h: "hike.jpg",
  l: "logo.png",
  n: "notes.txt",
  d: "diary.txt",
};
const samplesDir = new URL("../challenge/samples/", import.meta.url);

const set = "photos";
const { by } = sets[set];
const dir = `${photo("windows")}\\`;

/**
 * The instant `seconds` after the minute snapshot `name` is named for.
 * @param {string} name @param {number} seconds
 */
const after = (name, seconds) =>
  Temporal.PlainDateTime.from(name)
    .toZonedDateTime(zone)
    .add({ milliseconds: Math.round(seconds * 1000) })
    .toInstant()
    .toString({ fractionalSecondDigits: 3 });

const names = backedUp(timeline.at(-1)?.name ?? "").reverse();
const first = names[0] ?? "";
// `setup` a few minutes before the first backup. S3 keeps a key's
// LastModified to the second.
const claimed = after(first, -312.387);
const claimUploaded = after(first, -312);

/**
 * The backup that first uploaded each content, forgotten ones included.
 * @type {Map<string, string>}
 */
const firstUpload = new Map();
for (const { name, by } of timeline) {
  if (by === "backup") {
    for (const { fill } of filesAt(name).values()) {
      if (!firstUpload.has(fill)) {
        firstUpload.set(fill, name);
      }
    }
  }
}

/**
 * A snapshot's rows before the files, in the order `writeSnapshot` writes
 * them. Not `openingRows()`, whose `@CLIENT HOME` is the building machine's.
 * @param {string} name @param {string} start
 */
const preamble = (name, start) =>
  [
    ["@S3CAB", "SPEC", SPEC_DATE],
    ["@CLIENT", "NAME", "s3cab"],
    ["@CLIENT", "VERSION", pkg.version],
    ["@CLIENT", "HOME", `${worlds.windows.home}\\.s3cab\\`],
    ["@SET", "NAME", set],
    ["@SET", "BUCKET", `s3://${bucket}`],
    ["@SET", "DIR", dir],
    ["@SNAPSHOT", "NAME", name],
    ["@SNAPSHOT", "BY", by],
    ["@SNAPSHOT", "START", zone, start],
  ]
    .map(([type = "", property = "", value = "", time = ""]) =>
      formatLine(type, property, "", time, value),
    )
    .join("");

/**
 * Write the bucket into `root`: its objects, snapshots, `.info` and s3cab's
 * copy of the set's directories, and at `index.html` the listing S3 answers
 * a GET of the bucket with, so `/challenge/bucket/` reads like a public
 * bucket's root.
 * @param {string} root
 */
export async function writeChallengeBucket(root) {
  /** @type {{ key: string, modified: string }[]} */
  const keys = [];
  /** @param {string} key @param {string | Buffer} body @param {string} modified */
  const put = (key, body, modified) => {
    mkdirSync(dirname(join(root, key)), { recursive: true });
    writeFileSync(join(root, key), body);
    keys.push({ key, modified });
  };

  put(`.s3cab/sets/${set}/dirs.txt`, `${photo("windows")}\n`, claimUploaded);
  put(
    `snapshots/${set}.info`,
    formatInfo({ owner: by, claimed, created: claimed }),
    claimUploaded,
  );

  const stored = new Set();
  for (const name of names) {
    const start = after(name, 11.482);
    const finish = after(name, 12.907);
    const uploaded = after(name, 14);
    /** @type {Map<string, Props>} */
    const entries = new Map();
    const files = [...filesAt(name)].sort(([a], [b]) => (a < b ? -1 : 1));
    for (const [path, { fill, mtime }] of files) {
      const sample = samples[fill];
      if (!sample) {
        continue;
      }
      const bytes = readFileSync(new URL(sample, samplesDir));
      const hash = createHash("sha256").update(bytes).digest("hex");
      entries.set(photo("windows", path), { hash, size: bytes.length, mtime });
      if (!stored.has(hash)) {
        stored.add(hash);
        put(`objects/${hash}`, bytes, after(firstUpload.get(fill) ?? name, 14));
      }
    }
    await withSnapshotFile(join(root, "snapshots", set), name, (stream) =>
      pipeline(
        stringifySnapshot(entries, {
          start,
          finish,
          preamble: preamble(name, start),
        }),
        stream,
      ),
    );
    keys.push({
      key: `snapshots/${set}/${snapshotFileName(name)}`,
      modified: uploaded,
    });
  }

  const contents = keys
    .sort((a, b) => (a.key < b.key ? -1 : 1))
    .map(({ key, modified }) => {
      const body = readFileSync(join(root, key));
      const etag = createHash("md5").update(body).digest("hex");
      return [
        "  <Contents>",
        `    <Key>${key}</Key>`,
        `    <LastModified>${modified}</LastModified>`,
        `    <ETag>&quot;${etag}&quot;</ETag>`,
        `    <Size>${body.length}</Size>`,
        "    <StorageClass>GLACIER_IR</StorageClass>",
        "  </Contents>",
      ].join("\n");
    });
  writeFileSync(
    join(root, "index.html"),
    [
      `<?xml version="1.0" encoding="UTF-8"?>`,
      `<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">`,
      `  <Name>${bucket}</Name>`,
      "  <Prefix></Prefix>",
      "  <Marker></Marker>",
      "  <MaxKeys>1000</MaxKeys>",
      "  <IsTruncated>false</IsTruncated>",
      ...contents,
      "</ListBucketResult>",
      "",
    ].join("\n"),
  );
}
