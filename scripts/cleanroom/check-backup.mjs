/**
 * Check a backup room's work (ADR-0096): the backup bucket, after the session's program
 * has backed up the sets build-backup-cleanroom.mjs handed it.
 *
 *   <root>/fixtures/<set>/   the trees it was handed, read again here for s3cab's own
 *                            snapshot of them
 *
 * Run once the session has finished, on the machine the sandbox was built on, before the
 * sandbox is destroyed: the trees are the sandbox's, and s3cab's snapshot of them is taken
 * here, in a throwaway home, so s3cab's output never exists while the session could read
 * it. Restoring the bucket is not enough on its own: no restore reads a set's `.info`, a
 * restore can't say whether the room refused the sets it should have, and a snapshot that
 * restores can still have recorded the trees differently from s3cab. So this checks the
 * bucket against what the spec says a backup leaves, each published snapshot against
 * s3cab's, and only then has s3cab reattach and restore it:
 *
 * - **Layout**: every key is one guide/format.md documents, the room's own `.<name>/`
 *   folder included but not `.s3cab/`, which is s3cab's. A backup deletes nothing, so a
 *   deletion record is out of place too.
 * - **Objects**: each one hashes to its key. Every object is downloaded to see.
 * - **Headers**: no object or snapshot carries a Content-Encoding or `x-amz-meta-*`; one on
 *   a `.info` is a note, since the checklist names only objects and snapshots.
 * - **Each set, as the fixtures expect it** (`builtSets`): a set s3cab backs up has a
 *   snapshot published, and its latest is compared with s3cab's row for row
 *   (compare-snapshot.mjs). A set a backup must refuse — a name with no UTF-8 form, a tab
 *   in a name — has none, as the spec's "stop without writing a snapshot" says; a `.info`
 *   claimed before the walk refused it is a note, since whether a claim waits for the walk
 *   is a reading.
 * - **Every published snapshot** is held to the format's rules, the earlier ones of a set
 *   too: a bad first run stays in the set's history whatever the second wrote.
 * - **Objects first**: every object a published snapshot names is stored.
 * - **`snapshots/<set>.info`**, for every set with a published snapshot: `OWNER`,
 *   `CLAIMED` and `CREATED` lines, each once and ending LF, the instants in `mtime`'s
 *   form, and `CREATED` equal to `CLAIMED`, since every claim in an empty bucket is a new
 *   one. A key of the room's own is a note, as the reading rule skips it. No `.info`
 *   claims a set the room wasn't handed.
 * - **s3cab accepts it**: each set with a published snapshot or a `.info` reattaches, and
 *   each published snapshot restores.
 *
 * Exits 1 if anything mismatched, 0 if only notes or nothing.
 *
 * Usage:
 *   node --env-file=.env.test scripts/cleanroom/check-backup.mjs <root>
 */
import { GetObjectCommand } from "@aws-sdk/client-s3";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { hostname, tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { cli, client, listAll, sandboxPath } from "./cleanroom.mjs";
import { compareSnapshot, parse, some } from "./compare-snapshot.mjs";
import { builtSets } from "./fixtures.mjs";

/** @import { Snapshot } from "./compare-snapshot.mjs" */

const usage =
  "usage: node --env-file=.env.test scripts/cleanroom/check-backup.mjs <root>\n\n" +
  "e.g. node --env-file=.env.test scripts/cleanroom/check-backup.mjs ~/s3cab.sandbox";
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
      `    node --env-file=.env.test scripts/cleanroom/check-backup.mjs ${arg}\n`,
  );
  process.exit(2);
}
const root = sandboxPath(arg);
const fixtures = join(root, "fixtures");
if (!existsSync(fixtures)) {
  console.error(
    `${fixtures} doesn't exist, so ${root} isn't a backup sandbox. Pass the root\n` +
      "that build-backup-cleanroom.mjs built, not the cleanroom inside it.",
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

// What the room was handed: the sets this platform could build, each with what a backup
// has to do with it. The same list the build gave ENVIRONMENT.md, minus nothing.
const handed = builtSets(fixtures);
const sets = handed.map(({ name }) => name);
const refused = new Set(
  handed.filter((set) => set.refused).map(({ name }) => name),
);

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
    `keys outside the layout format.md documents (a backup deletes nothing, so a ` +
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

// ── Each set: its snapshot against s3cab's, and objects first ───────────────

const home = mkdtempSync(join(tmpdir(), "s3cab-check-backup-"));
const { mustWrite, snapshotsOf } = cli(home);

/**
 * s3cab's snapshot of the set's trees, taken now in the throwaway home. The set names
 * the backup bucket, so `@SET BUCKET` compares like with like; `snapshot` never reaches it.
 * A reference s3cab couldn't take, or that breaks the format itself, is this set's
 * mismatch, not the run's: the other sets still get their comparison.
 * @param {{ name: string, dirs: string[] }} set
 * @returns {Snapshot | undefined}
 */
function reference({ name, dirs }) {
  const dir = join(home, "sets", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "dirs.txt"), dirs.join("\n") + "\n");
  writeFileSync(join(dir, "env"), `S3CAB_BUCKET=${bucket}\n`);
  /** @type {string[]} */
  const problems = [];
  /** @type {Snapshot | undefined} */
  let parsed;
  try {
    mustWrite(["snapshot", name], name);
    const [written = ""] = snapshotsOf(name);
    parsed = parse(
      readFileSync(join(dir, "snapshots", written)),
      problems,
      problems,
    );
  } catch (error) {
    problems.push(error instanceof Error ? error.message : String(error));
  }
  if (!parsed || problems.length > 0) {
    mismatches.push(
      `s3cab's own snapshot of ${name} couldn't be taken, or broke the format, so ` +
        `${name} is uncompared:${some(problems)}`,
    );
    return undefined;
  }
  return parsed;
}

try {
  for (const set of handed) {
    const names = (published.get(set.name) ?? []).sort();
    const latest = names.at(-1);
    /** @type {Snapshot | undefined} */
    let theirs;
    if (set.refused) {
      // The spec's "stop without writing a snapshot": what the room's program said when
      // it stopped is in the session's report, not the bucket.
      for (const name of names) {
        mismatches.push(
          `snapshots/${set.name}/${name}.tsv.gz is published, where the set holds a name ` +
            "the spec says to stop on, with no snapshot written",
        );
      }
    } else if (!latest) {
      mismatches.push(`nothing of ${set.name} is published`);
    } else {
      if (names.length > 1) {
        notes.push(
          `${set.name} has ${names.length} snapshots published; compared the latest, ${latest}`,
        );
      }
      theirs = reference(set);
    }
    // Every published snapshot is held to the format and to objects-first, the latest to
    // s3cab's rows too. One download each: `get` records a header on every call.
    for (const name of names) {
      const label = `snapshots/${set.name}/${name}.tsv.gz`;
      /** @type {string[]} */
      const problems = [];
      /** @type {string[]} */
      const remarks = [];
      const gz = await get(label);
      const ours = parse(gz, problems, remarks);
      mismatches.push(...problems.map((text) => `${label}: ${text}`));
      notes.push(...remarks.map((text) => `${label}: ${text}`));
      if (!ours) {
        continue;
      }
      if (name === latest && theirs) {
        const compared = compareSnapshot(ours, { set: set.name, name }, theirs);
        mismatches.push(
          ...compared.mismatches.map((text) => `${label}: ${text}`),
        );
        notes.push(...compared.notes.map((text) => `${label}: ${text}`));
      }
      const named = new Set([...ours.files.values()].map(({ hash }) => hash));
      const absent = [...named].filter((hash) => !objects.has(hash));
      if (absent.length > 0) {
        mismatches.push(
          `${label} names objects that aren't stored, so objects-first is broken:` +
            some(absent.map((hash) => `objects/${hash}`)),
        );
      }
    }
  }
  for (const set of published.keys()) {
    if (!sets.includes(set)) {
      mismatches.push(
        `snapshots/${set}/ holds snapshots of a set the room wasn't handed`,
      );
    }
  }

  if (headered.length > 0) {
    mismatches.push(
      `stored with a Content-Encoding or x-amz-meta-* metadata, which format.md's ` +
        `Uploading rules out:${some(headered)}`,
    );
  }

  // ── snapshots/<set>.info ──────────────────────────────────────────────────

  const claimedSets = [...infos].map((key) =>
    key.slice("snapshots/".length, -".info".length),
  );
  for (const set of new Set([...sets, ...claimedSets])) {
    const key = `snapshots/${set}.info`;
    if (!sets.includes(set)) {
      mismatches.push(`${key} claims a set the room wasn't handed`);
      continue;
    }
    // A refused set has nothing to publish, so a claim is neither right nor wrong: whether
    // a claim waits for the walk is a reading. Nothing to say when it didn't claim.
    if (refused.has(set) && !published.has(set) && infos.has(key)) {
      notes.push(`${key} claims ${set}, whose walk then stopped`);
    }
    if (!infos.has(key)) {
      if (published.has(set)) {
        mismatches.push(
          `${key} doesn't exist, yet the set has snapshots published`,
        );
      }
      continue;
    }
    const info = await get(key);
    const text = info.toString("utf8");
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

  // ── s3cab accepts it ──────────────────────────────────────────────────────
  // In a second throwaway home: the first holds s3cab's own snapshots of the sets, and
  // `reattach` would meet them.

  const accepting = mkdtempSync(join(tmpdir(), "s3cab-check-backup-accepts-"));
  const accepts = cli(accepting);
  const output = join(accepting, "restored");
  try {
    mkdirSync(output);
    if (process.platform === "win32") {
      // `edge`'s case pair restores whole only into a case-sensitive directory, which
      // the directories restore creates inside it inherit. Anywhere else the pair
      // collides, which is the disk's doing, not the room's. Where the flag can't be
      // set, the build dropped the pair too, and the restore has nothing to collide on.
      try {
        execFileSync("fsutil", [
          "file",
          "setCaseSensitiveInfo",
          output,
          "enable",
        ]);
      } catch (error) {
        notes.push(
          `couldn't make ${output} case-sensitive for s3cab's restore (${error instanceof Error ? error.message : String(error)})`,
        );
      }
    }
    for (const set of sets) {
      if (!published.has(set) && !infos.has(`snapshots/${set}.info`)) {
        continue;
      }
      const reattached = accepts.run(["reattach", set, "--bucket", bucket]);
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
        const restored = accepts.run([
          "restore",
          "--set",
          set,
          "--snapshot",
          name,
          "--output",
          join(output, `${set}-${name}`),
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
    rmSync(accepting, { recursive: true, force: true });
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
