/**
 * Check an upload room's work (ADR-0096): the backup bucket, after the session's program
 * has uploaded the snapshots build-upload-cleanroom.mjs handed it.
 *
 *   <root>/.s3cab/sets/<set>/   what the room was handed, as s3cab wrote it: dirs.txt,
 *                               exclude.txt and the intact snapshots
 *
 * Run once the session has finished, on the machine the sandbox was built on, before the
 * sandbox is destroyed. Restoring the bucket is not enough on its own: no restore reads
 * a set's `.info`, and a restore can't say whether the room refused the two snapshots it
 * should have. So this checks the bucket against what the spec says an upload leaves, and
 * only then has s3cab reattach and restore it:
 *
 * - **Layout**: every key is one guide/format.md documents, the room's own `.<name>/`
 *   folder included but not `.s3cab/`, which is s3cab's. An upload deletes nothing, so a
 *   deletion record is out of place too.
 * - **Objects**: each one hashes to its key. Every object is downloaded to see.
 * - **Headers**: no object or snapshot carries a Content-Encoding or `x-amz-meta-*`; one on
 *   a `.info` is a note, since the checklist names only objects and snapshots.
 * - **Snapshots**: each published one is byte-identical to the one handed over, and none
 *   is missing. Two must not be published, as s3cab publishes neither: `corrupt`'s, since
 *   `b-corrupt.txt` changed after it was taken and its bytes are no longer the ones its
 *   row names, and `faults`'s cut off after its last file row.
 * - **Objects first**: every object a published snapshot names is stored.
 * - **`snapshots/<set>.info`**, for every set with a published snapshot: `OWNER`,
 *   `CLAIMED` and `CREATED` lines, each once and ending LF, the instants in `mtime`'s
 *   form, and `CREATED` equal to `CLAIMED`, since every claim in an empty bucket is a new
 *   one. A key of the room's own is a note, as the reading rule skips it. No `.info`
 *   claims a set the room wasn't handed. A set with nothing published may have one or
 *   not: whether a claim waits for a snapshot is a reading, so which it did is a note.
 * - **s3cab accepts it**: each set with a published snapshot or a `.info` reattaches, and
 *   each published snapshot restores.
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
import { hostname, tmpdir, userInfo } from "node:os";
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

const instant = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const infoKeys = ["OWNER", "CLAIMED", "CREATED"];
const me = `${userInfo().username}@${hostname()}`;

/** @type {string[]} */
const mismatches = [];
/** @type {string[]} */
const notes = [];
/** @type {string[]} */
const headered = [];

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
  // The SDK hands back the stored bytes whatever Content-Encoding says, so the
  // byte comparisons below can't see one: it has to be read off the response.
  const { ContentEncoding, Metadata = {} } = response;
  if (ContentEncoding || Object.keys(Metadata).length > 0) {
    const sent = `${key}: ${JSON.stringify({ ContentEncoding, Metadata })}`;
    if (/^objects\/|^snapshots\/[^/]+\/[^/]+\.tsv\.gz$/.test(key)) {
      headered.push(sent);
    } else {
      notes.push(
        `${sent}, which the checklist rules out only for objects and snapshots`,
      );
    }
  }
  const bytes = await /** @type {NonNullable<typeof response.Body>} */ (
    response.Body
  ).transformToByteArray();
  return Buffer.from(bytes);
}

/**
 * A `.info`'s `KEY=value` lines, held to how the Uploading checklist has a writer write
 * them: each ending LF, with no CR and no blank line. `undefined` if it isn't that.
 * @param {string} text
 */
function infoFields(text) {
  if (!text.endsWith("\n") || text.includes("\r")) {
    return undefined;
  }
  const lines = text.slice(0, -1).split("\n");
  if (!lines.every((line) => line.indexOf("=") > 0)) {
    return undefined;
  }
  return lines.map((line) => {
    const cut = line.indexOf("=");
    return { key: line.slice(0, cut), value: line.slice(cut + 1) };
  });
}

/**
 * The hashes a snapshot's file rows name, from their second column.
 * @param {Buffer} gz
 */
const namedHashes = (gz) =>
  gunzipSync(gz)
    .toString("utf8")
    .split("\n")
    .map((line) => line.split("\t"))
    .filter(([type]) => type?.trim() === "-")
    .map(([, hash]) => hash?.trim() ?? "");

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
const infos = new Set();
/** @type {string[]} */
const ownFolder = [];
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
  } else if (/^snapshots\/[^/]+\.info$/.test(key)) {
    infos.add(key);
  } else if (/^\.[^/]+\//.test(key) && !key.startsWith(".s3cab/")) {
    ownFolder.push(key);
  } else {
    strays.push(key);
  }
}
console.log(
  `s3://${bucket}: ${objects.size} objects, ` +
    `${[...published.values()].flat().length} snapshots, ${infos.size} set markers`,
);
if (strays.length > 0) {
  mismatches.push(
    `keys outside the layout format.md documents (an upload deletes nothing, so a ` +
      `deletion record counts, and .s3cab/ is s3cab's own folder):${some(strays)}`,
  );
}
if (ownFolder.length > 0) {
  notes.push(`the room's own folder holds:${some(ownFolder)}`);
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
        `${label} is published, the snapshot handed over cut off after its last file row`,
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

if (headered.length > 0) {
  mismatches.push(
    `stored with a Content-Encoding or x-amz-meta-* metadata, which format.md's ` +
      `Uploading rules out:${some(headered)}`,
  );
}

// ── snapshots/<set>.info ────────────────────────────────────────────────────

const claimedSets = [...infos].map((key) =>
  key.slice("snapshots/".length, -".info".length),
);
for (const set of new Set([...sets, ...claimedSets])) {
  const key = `snapshots/${set}.info`;
  if (!sets.includes(set)) {
    mismatches.push(`${key} claims a set the room wasn't handed`);
    continue;
  }
  if (!published.has(set)) {
    notes.push(
      `nothing of ${set} is published, and ` +
        (infos.has(key) ? `${key} claims it anyway` : `no ${key} claims it`),
    );
  }
  if (!infos.has(key)) {
    if (published.has(set)) {
      mismatches.push(
        `${key} doesn't exist, yet the set has snapshots published`,
      );
    }
    continue;
  }
  const text = (await get(key)).toString("utf8");
  const fields = infoFields(text);
  if (!fields) {
    mismatches.push(
      `${key} isn't KEY=value lines, each ending LF: ${JSON.stringify(text)}`,
    );
    continue;
  }
  /** @type {string[]} */
  const wrong = [];
  /** @type {Record<string, string>} */
  const value = {};
  for (const name of infoKeys) {
    const [only, ...more] = fields.filter((field) => field.key === name);
    if (!only || more.length > 0) {
      wrong.push(`${name} isn't there exactly once`);
    } else {
      value[name] = only.value;
    }
  }
  for (const name of ["CLAIMED", "CREATED"]) {
    const at = value[name];
    if (at !== undefined && !instant.test(at)) {
      wrong.push(`${name} isn't an instant in mtime's form`);
    }
  }
  if (wrong.length === 0 && value.CLAIMED !== value.CREATED) {
    wrong.push(
      "CREATED isn't CLAIMED, though the room's every claim is a new one",
    );
  }
  if (wrong.length > 0) {
    mismatches.push(`${key}: ${wrong.join(", ")}: ${JSON.stringify(text)}`);
  }
  const extra = fields.filter((field) => !infoKeys.includes(field.key));
  if (extra.length > 0) {
    notes.push(
      `${key} adds keys of its own: ${extra.map((field) => field.key).join(", ")}`,
    );
  }
  if (value.OWNER !== undefined && value.OWNER !== me) {
    notes.push(
      `${key} names OWNER ${JSON.stringify(value.OWNER)}, where this ` +
        `user@machine is ${JSON.stringify(me)}`,
    );
  }
}

// ── s3cab accepts it ────────────────────────────────────────────────────────

const home = mkdtempSync(join(tmpdir(), "s3cab-check-upload-"));
const { run } = cli(home);
try {
  for (const set of sets) {
    if (!published.has(set) && !infos.has(`snapshots/${set}.info`)) {
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
