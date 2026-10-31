// The bucket behind the recover-by-hand challenge (site/challenge.md): a
// repository laid out as guide/format.md says, written as static files into
// the built site, so the challenge needs no real bucket to pay for or keep
// keys to. The snapshots are written by s3cab's own writer from the sample
// files in site/challenge/samples/, so the bucket follows the format of the
// s3cab that builds it. Every instant is fixed here, so a rebuild serves the
// same bytes.

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

/** @import { Props } from "../../src/lib/snapshot-file.mjs" */

const samples = new URL("../challenge/samples/", import.meta.url);
const bucket = "my-backups";
const set = "photos";
const home = "/home/me/";
const dir = `${home}Photos/`;
const by = "me@laptop";
const claimed = "2026-06-14T17:58:47.613Z";
// S3 keeps a key's LastModified to the second.
const claimUploaded = "2026-06-14T17:58:48.000Z";

/**
 * The set's snapshots, oldest first. Between them beach.jpg was edited and
 * moved into 2026/, a copy of the edit became the wallpaper, and the hike
 * photo moved into 2019/ unchanged. Each row is a path under `dir`, its
 * sample file, and its modification time; `uploaded` is when the run's keys
 * landed in the bucket.
 * @type {{ name: string, start: string, finish: string, uploaded: string, rows: [string, string, string][] }[]}
 */
const snapshots = [
  {
    name: "20260614T1902",
    start: "2026-06-14T18:02:11.482Z",
    finish: "2026-06-14T18:02:12.907Z",
    uploaded: "2026-06-14T18:02:14.000Z",
    rows: [
      ["beach.jpg", "beach-original.jpg", "2026-06-08T10:41:22.000Z"],
      ["hike-2019.jpg", "hike.jpg", "2019-07-21T14:03:51.000Z"],
      ["notes.txt", "notes.txt", "2026-06-14T17:55:40.127Z"],
    ],
  },
  {
    name: "20260902T2047",
    start: "2026-09-02T19:47:36.205Z",
    finish: "2026-09-02T19:47:37.561Z",
    uploaded: "2026-09-02T19:47:39.000Z",
    rows: [
      ["2019/hike.jpg", "hike.jpg", "2019-07-21T14:03:51.000Z"],
      ["2026/beach.jpg", "beach.jpg", "2026-08-30T19:12:05.318Z"],
      ["notes.txt", "notes.txt", "2026-06-14T17:55:40.127Z"],
      ["wallpaper.jpg", "beach.jpg", "2026-08-30T19:14:47.090Z"],
    ],
  },
];

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
    ["@CLIENT", "HOME", `${home}.s3cab/`],
    ["@SET", "NAME", set],
    ["@SET", "BUCKET", `s3://${bucket}`],
    ["@SET", "DIR", dir],
    ["@SNAPSHOT", "NAME", name],
    ["@SNAPSHOT", "BY", by],
    ["@SNAPSHOT", "START", "Europe/London", start],
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

  put(`.s3cab/sets/${set}/dirs.txt`, `${dir.slice(0, -1)}\n`, claimUploaded);
  put(
    `snapshots/${set}.info`,
    formatInfo({ owner: by, claimed, created: claimed }),
    claimUploaded,
  );

  const stored = new Set();
  for (const { name, start, finish, uploaded, rows } of snapshots) {
    /** @type {Map<string, Props>} */
    const entries = new Map();
    for (const [path, sample, mtime] of rows) {
      const bytes = readFileSync(new URL(sample, samples));
      const hash = createHash("sha256").update(bytes).digest("hex");
      entries.set(dir + path, { hash, size: bytes.length, mtime });
      if (!stored.has(hash)) {
        stored.add(hash);
        put(`objects/${hash}`, bytes, uploaded);
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
