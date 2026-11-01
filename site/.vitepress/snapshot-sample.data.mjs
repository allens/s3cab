// The sample snapshot the snapshot-anatomy page shows, written by s3cab's own
// writer at build time so it follows every format change: a VitePress data
// loader, so the page gets the text and none of this reaches the browser. Nothing here touches
// a real tree: the walk's findings are given, and `getProps` hashes made-up
// bytes, which is the writer's own test seam.
//
// The paths are built with `node:path`, so the sample is spelled as s3cab
// writes it on the machine building the docs: the writer ends a folder with
// that machine's separator, and a POSIX folder ending in `\` would hold no
// file. Cloudflare builds on Linux, so the site shows POSIX paths.

import assert from "node:assert/strict";
import crypto from "node:crypto";
import { mkdtempDisposable, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { gunzipSync } from "node:zlib";
import { formatLine, writeSnapshot } from "../../src/lib/snapshot-file.mjs";

const root = sep === "\\" ? "C:\\Users\\me" : "/home/me";
const photos = join(root, "Photos");
const pictures = join(root, "Pictures");

// Fixed, so a rebuild writes the same text. London in June, so the name (local
// time) and START (UTC) visibly differ.
const START = {
  name: "20260612T0915",
  instant: "2026-06-12T08:15:32.123Z",
  zone: "Europe/London",
};
const FINISH = "2026-06-12T09:15:40.871+01:00[Europe/London]";
const BY = "me@laptop";

/**
 * The files the sample records, in the order a walk might find them. `content`
 * names the bytes, so two files with the same one share a hash; one with an
 * `error` fails while it is read.
 * @type {({ path: string, content: string, size: number, mtime: string } | { path: string, error: string })[]}
 */
const files = [
  {
    path: join(photos, "2025", "beach.jpg"),
    content: "beach",
    size: 4915200,
    mtime: "2025-06-01T12:00:00.000Z",
  },
  {
    path: join(photos, "2025", "sunset.jpg"),
    content: "sunset",
    size: 3870211,
    mtime: "2025-06-01T20:41:07.512Z",
  },
  {
    path: join(photos, "2025", "busy.jpg"),
    error: `EBUSY: resource busy or locked, open '${join(photos, "2025", "busy.jpg")}'`,
  },
  {
    path: join(photos, ".nomedia"),
    content: "",
    size: 0,
    mtime: "2024-01-01T00:00:00.000Z",
  },
  {
    path: join(pictures, "2019", "hike.jpg"),
    content: "hike",
    size: 2210483,
    mtime: "2019-09-14T08:02:51.000Z",
  },
  {
    path: join(pictures, "from-phone", "beach.jpg"),
    content: "beach",
    size: 4915200,
    mtime: "2025-06-02T07:30:12.004Z",
  },
];

/**
 * The sample snapshot, decompressed: the text `gunzip` would give.
 * @returns {Promise<string>}
 */
export async function sampleSnapshot() {
  const byPath = new Map(files.map((file) => [file.path, file]));
  await using dir = await mkdtempDisposable(join(tmpdir(), "s3cab-sample-"));
  // FINISH is read from s3cab's clock seam (`readClock` in
  // src/lib/format.mjs) and HOME from `S3CAB_HOME`, so both are pinned for the
  // write. The build calls this once.
  const clock = Temporal.Now.zonedDateTimeISO;
  const home = process.env.S3CAB_HOME;
  Temporal.Now.zonedDateTimeISO = () => Temporal.ZonedDateTime.from(FINISH);
  process.env.S3CAB_HOME = join(root, ".s3cab");
  try {
    const path = await writeSnapshot(dir.path, START, {
      set: {
        name: "photos",
        bucket: "my-backups",
        endpoint: "https://0123456789abcdef.r2.cloudflarestorage.com",
        dirs: [photos, pictures],
        patterns: ["*.tmp", "cache/"],
      },
      files: byPath.keys(),
      excluded: [
        { pattern: "*.tmp", path: join(photos, "upload.tmp"), isDir: false },
        { pattern: "cache/", path: join(photos, "cache"), isDir: true },
      ],
      errors: [
        {
          path: join(pictures, "Shared") + sep,
          reason: `link to a folder outside the backup: ${join(root, "..", "shared")}`,
        },
      ],
      getProps: async (path) => {
        const file = byPath.get(path);
        assert(file);
        if ("error" in file) {
          throw new Error(file.error);
        }
        const bytes = Buffer.alloc(file.size, file.content);
        return {
          size: file.size,
          mtime: file.mtime,
          hash: crypto.hash("sha256", bytes, "hex"),
        };
      },
    });
    const text = gunzipSync(await readFile(path)).toString("utf8");
    // `BY` is the one value the writer takes from the machine with no seam to
    // set it, and the builder's own login has no place on a public page.
    const by = /^@SNAPSHOT\tBY *\t.*\n/m;
    assert.match(text, by, "the sample's @SNAPSHOT BY row has changed shape");
    return text.replace(by, formatLine("@SNAPSHOT", "BY", "", "", BY));
  } finally {
    Temporal.Now.zonedDateTimeISO = clock;
    if (home === undefined) {
      delete process.env.S3CAB_HOME;
    } else {
      process.env.S3CAB_HOME = home;
    }
  }
}

export default {
  // Relative to this file. Without it `docs:dev` keeps the old sample.
  watch: ["../../src/lib/snapshot-file.mjs"],
  load: () => sampleSnapshot(),
};
