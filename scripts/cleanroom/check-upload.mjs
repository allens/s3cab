/**
 * Check an upload room's work (ADR-0096): the backup bucket, after the session's program
 * has uploaded the snapshots build-upload-cleanroom.mjs handed it.
 *
 *   <root>/.s3cab/sets/<set>/   what the room was handed, as s3cab wrote it: dirs.txt,
 *                               exclude.txt and the intact snapshots
 *
 * Run once the session has finished, on the machine the sandbox was built on, before the
 * sandbox is destroyed. Restoring the bucket is not enough on its own: no restore reads
 * `dirs.txt` or `exclude.txt`, and a restore can't say whether the room refused the two
 * snapshots it should have. So this checks the bucket against what the spec says an upload
 * leaves, and only then has s3cab reattach and restore it:
 *
 * - **Layout**: every key is one guide/format.md documents. An upload deletes nothing, so a
 *   deletion record is out of place too.
 * - **Objects**: each one hashes to its key. Every object is downloaded to see.
 * - **Snapshots**: each published one is byte-identical to the one handed over, and none
 *   is missing. Two must not be published, as s3cab publishes neither: `corrupt`'s, since
 *   `b-corrupt.txt` changed after it was taken and its bytes are no longer the ones its
 *   row names, and `faults`'s with no `#END` trailer.
 * - **Objects first**: every object a published snapshot names is stored.
 * - **`sets/<set>/`**: `info` is two `KEY=value` lines, `OWNER` then `CREATED`; `dirs.txt`
 *   is the parsed list with LF endings; `exclude.txt` is a byte copy of the set's own.
 * - **s3cab accepts it**: each set reattaches, and each published snapshot restores.
 *
 * `reattach` writes to the bucket (it re-stamps each set's `info` with this machine as
 * OWNER), which is why it comes after `info` has been read.
 *
 * Exits 1 if anything mismatched, 0 if only notes or nothing.
 *
 * Usage:
 *   node --env-file=.env.test scripts/cleanroom/check-upload.mjs <root>
 */
import { GetObjectCommand } from "@aws-sdk/client-s3";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { cli, client, listAll, sandboxPath } from "./cleanroom.mjs";
import { oneMinuteBefore } from "./fixtures.mjs";

const usage =
  "usage: node --env-file=.env.test scripts/cleanroom/check-upload.mjs <root>\n\n" +
  "e.g. node --env-file=.env.test scripts/cleanroom/check-upload.mjs ~/s3cab.sandbox";
const [arg, ...extra] = process.argv.slice(2);
if (!arg || extra.length > 0) {
  console.error(usage);
  process.exit(2);
}
const bucket = process.env.S3CAB_TEST_BUCKET_CLEANROOM_BACKUP;
if (!bucket) {
  console.error(
    "No clean-room bucket is set (S3CAB_TEST_BUCKET_CLEANROOM_BACKUP). Run with the\n" +
      "test environment, which names it:\n\n" +
      `    node --env-file=.env.test scripts/cleanroom/check-upload.mjs ${arg}\n`,
  );
  process.exit(2);
}
const root = sandboxPath(arg);
const handed = join(root, ".s3cab", "sets");
if (!existsSync(handed)) {
  console.error(
    `${handed} doesn't exist, so ${root} isn't an upload sandbox. Pass the root\n` +
      "that build-upload-cleanroom.mjs built, not the cleanroom inside it.",
  );
  process.exit(2);
}

const instant = "\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z";
const info = new RegExp(`^OWNER=([^\\n]+)\\nCREATED=${instant}\\n$`);

/** @type {string[]} */
const mismatches = [];
/** @type {string[]} */
const notes = [];

/**
 * Up to ten of `items`, one per line, and how many more there were.
 * @param {string[]} items
 */
const some = (items) =>
  items
    .slice(0, 10)
    .map((item) => `\n      ${item}`)
    .join("") +
  (items.length > 10 ? `\n      … and ${items.length - 10} more` : "");

/** @param {string} key */
async function get(key) {
  const response = await client.send(
    new GetObjectCommand({ Bucket: bucket, Key: key }),
  );
  const bytes = await /** @type {NonNullable<typeof response.Body>} */ (
    response.Body
  ).transformToByteArray();
  return Buffer.from(bytes);
}

/**
 * The hashes a snapshot's file rows name: every line that isn't metadata, first field.
 * @param {Buffer} gz
 */
const namedHashes = (gz) =>
  gunzipSync(gz)
    .toString("utf8")
    .split("\n")
    .filter((line) => line && !line.split("\t")[0]?.trim().startsWith("#"))
    .map((line) => line.split("\t")[0]?.trim() ?? "");

/** @param {string} text a `dirs.txt` as written: trimmed lines, no blanks or comments */
const parsedLines = (text) =>
  text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));

// What the room was handed: each set's own files and the intact snapshots, from s3cab's
// home. The damaged `faults` snapshot was written only into the room, a minute before
// the intact one (build-upload-cleanroom.mjs), so its name is worked out the same way.
const sets = readdirSync(handed).sort();
/** @type {Map<string, Map<string, Buffer>>} */
const originals = new Map();
for (const set of sets) {
  const dir = join(handed, set, "snapshots");
  originals.set(
    set,
    new Map(
      readdirSync(dir)
        .filter((entry) => entry.endsWith(".tsv.gz") && !entry.startsWith("."))
        .map((entry) => [
          entry.slice(0, -".tsv.gz".length),
          readFileSync(join(dir, entry)),
        ]),
    ),
  );
}
const [faultsIntact = ""] = [...(originals.get("faults")?.keys() ?? [])];
const faultsDamaged = oneMinuteBefore(faultsIntact);

// ── Layout ──────────────────────────────────────────────────────────────────

const keys = await listAll(bucket);
/** @type {Set<string>} */
const objects = new Set();
/** @type {Map<string, string[]>} */
const published = new Map();
/** @type {Set<string>} */
const setFiles = new Set();
/** @type {string[]} */
const strays = [];
for (const key of keys) {
  const object = /^objects\/([0-9a-f]{64})$/.exec(key);
  const snapshot =
    /^snapshots\/([^/]+)\/(\d{4}-\d{2}-\d{2}T\d{4})\.tsv\.gz$/.exec(key);
  if (object?.[1]) {
    objects.add(object[1]);
  } else if (snapshot?.[1] && snapshot[2]) {
    published.set(snapshot[1], [
      ...(published.get(snapshot[1]) ?? []),
      snapshot[2],
    ]);
  } else if (/^sets\/[^/]+\/(info|dirs\.txt|exclude\.txt)$/.test(key)) {
    setFiles.add(key);
  } else {
    strays.push(key);
  }
}
console.log(
  `s3://${bucket}: ${objects.size} objects, ` +
    `${[...published.values()].flat().length} snapshots, ${setFiles.size} set files`,
);
if (strays.length > 0) {
  mismatches.push(
    `keys outside the layout format.md documents (an upload deletes nothing, so a ` +
      `deletion record counts):${some(strays)}`,
  );
}

// ── Objects ─────────────────────────────────────────────────────────────────

/** @type {string[]} */
const misfiled = [];
const pending = [...objects];
// Eight at a time: one is slow over 1,250 objects, and more buys little.
while (pending.length > 0) {
  await Promise.all(
    pending.splice(0, 8).map(async (hash) => {
      const bytes = await get(`objects/${hash}`);
      const actual = createHash("sha256").update(bytes).digest("hex");
      if (actual !== hash) {
        misfiled.push(`objects/${hash} holds bytes that hash to ${actual}`);
      }
    }),
  );
}
if (misfiled.length > 0) {
  mismatches.push(
    `objects whose bytes aren't the ones their key names:${some(misfiled)}`,
  );
}

// ── Snapshots, and objects first ────────────────────────────────────────────

for (const set of new Set([...sets, ...published.keys()])) {
  const handedHere = originals.get(set) ?? new Map();
  const names = published.get(set) ?? [];
  for (const name of names) {
    const label = `snapshots/${set}/${name}.tsv.gz`;
    const bytes = await get(label);
    const original = handedHere.get(name);
    if (set === "corrupt") {
      mismatches.push(
        `${label} is published, but b-corrupt.txt changed after it was taken, so the ` +
          "object its row names can't be stored; s3cab publishes no snapshot for corrupt",
      );
    } else if (set === "faults" && name === faultsDamaged) {
      mismatches.push(
        `${label} is published, the snapshot handed over with no #END trailer`,
      );
    } else if (!original) {
      mismatches.push(
        `${label} is published, and is no snapshot it was handed`,
      );
    } else if (!bytes.equals(original)) {
      mismatches.push(
        `${label} isn't byte-identical to the snapshot it was handed`,
      );
    }
    /** @type {string[]} */
    let hashes = [];
    try {
      hashes = namedHashes(bytes);
    } catch (error) {
      mismatches.push(`${label} can't be decompressed (${String(error)})`);
    }
    const absent = [...new Set(hashes)].filter((hash) => !objects.has(hash));
    if (absent.length > 0) {
      mismatches.push(
        `${label} names objects that aren't stored, so objects-first is broken:` +
          some(absent.map((hash) => `objects/${hash}`)),
      );
    }
  }
  if (set !== "corrupt") {
    for (const name of handedHere.keys()) {
      if (!names.includes(name)) {
        mismatches.push(`snapshots/${set}/${name}.tsv.gz was never published`);
      }
    }
  }
}

// ── sets/<set>/ ─────────────────────────────────────────────────────────────

for (const set of sets) {
  const prefix = `sets/${set}/`;
  if (![...setFiles].some((key) => key.startsWith(prefix))) {
    // `corrupt` publishes nothing, so a program that leaves the whole set alone has a
    // reading the spec allows; every other set has a snapshot to mark.
    (set === "corrupt" ? notes : mismatches).push(`${prefix} doesn't exist`);
    continue;
  }

  if (setFiles.has(`${prefix}info`)) {
    const text = (await get(`${prefix}info`)).toString("utf8");
    const match = info.exec(text);
    if (!match) {
      mismatches.push(
        `${prefix}info isn't 'OWNER=…' then 'CREATED=<instant>', each ending LF: ` +
          JSON.stringify(text),
      );
    } else if (match[1] !== hostname()) {
      notes.push(
        `${prefix}info names OWNER ${JSON.stringify(match[1])}, where this machine's ` +
          `hostname is ${JSON.stringify(hostname())}`,
      );
    }
  } else {
    mismatches.push(`${prefix}info doesn't exist`);
  }

  const localDirs = readFileSync(join(handed, set, "dirs.txt"), "utf8");
  const expectedDirs = parsedLines(localDirs).join("\n") + "\n";
  if (!setFiles.has(`${prefix}dirs.txt`)) {
    mismatches.push(`${prefix}dirs.txt doesn't exist`);
  } else {
    const text = (await get(`${prefix}dirs.txt`)).toString("utf8");
    if (text !== expectedDirs) {
      mismatches.push(
        `${prefix}dirs.txt isn't the parsed list, one per line, LF-terminated: ` +
          `${JSON.stringify(text)}, not ${JSON.stringify(expectedDirs)}`,
      );
    }
  }

  const localExclude = join(handed, set, "exclude.txt");
  const remoteExclude = setFiles.has(`${prefix}exclude.txt`);
  if (existsSync(localExclude)) {
    const local = readFileSync(localExclude);
    if (!remoteExclude) {
      mismatches.push(`${prefix}exclude.txt doesn't exist`);
    } else {
      const remote = await get(`${prefix}exclude.txt`);
      if (!remote.equals(local)) {
        mismatches.push(
          `${prefix}exclude.txt isn't a byte copy of the set's own: ` +
            `${JSON.stringify(remote.toString("utf8"))}, not ` +
            JSON.stringify(local.toString("utf8")),
        );
      }
    }
  } else if (remoteExclude) {
    notes.push(`${prefix}exclude.txt exists for a set that has none`);
  }
}

// ── s3cab accepts it ────────────────────────────────────────────────────────

const home = mkdtempSync(join(tmpdir(), "s3cab-check-upload-"));
const { run } = cli(home);
try {
  for (const set of sets) {
    if (![...setFiles].some((key) => key.startsWith(`sets/${set}/`))) {
      continue;
    }
    const reattached = run(["reattach", set, "--bucket", bucket]);
    if (reattached.code !== 0) {
      mismatches.push(
        `s3cab couldn't reattach ${set}:${some(
          `${reattached.out}\n${reattached.err}`
            .split("\n")
            .filter((line) => line.trim() && !line.startsWith("Using ")),
        )}`,
      );
      continue;
    }
    for (const name of published.get(set) ?? []) {
      const restored = run([
        "restore",
        "--set",
        set,
        "--snapshot",
        name,
        "--output",
        join(home, "restored", `${set}-${name}`),
      ]);
      if (restored.code !== 0) {
        mismatches.push(
          `s3cab couldn't restore ${set} ${name} whole:${some(
            `${restored.out}\n${restored.err}`
              .split("\n")
              .filter(
                (line) => line.trim() && !/^(Restoring|Using) /.test(line),
              ),
          )}`,
        );
      }
    }
  }
} finally {
  rmSync(home, { recursive: true, force: true });
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
process.exit(mismatches.length > 0 ? 1 : 0);
