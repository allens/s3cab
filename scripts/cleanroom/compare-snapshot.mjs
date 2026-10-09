/**
 * Check a snapshot room's work (ADR-0096): each set's snapshot, as the session's program
 * wrote it, against `s3cab snapshot` of the same trees.
 *
 *   <root>/cleanroom/sets/<set>/                  dirs.txt and exclude.txt, as built
 *   <root>/cleanroom/sets/<set>/snapshots/*.tsv.gz  what the session's program wrote
 *
 * Run once the session has finished, on the machine it ran on, before the sandbox is
 * destroyed: the trees are the sandbox's, and s3cab's snapshot of them is taken here, in a
 * throwaway home, so s3cab's output never exists while the session could read it.
 *
 * What has to match is ADR-0096's list. File rows are compared as a set, exact in hash,
 * size, mtime and path. The excluded, skipped and unreadable paths must match. Metadata
 * payloads are context, so `#EXCLUDED`, `#SKIPPED` and `#ERROR` rows are compared by path
 * only, and snapshot names and instants differ by run. The brief asks for the snapshot's
 * exact bytes, so the session's file is also held to the column padding, LF endings, the
 * header block and the trailer that guide/format.md describes.
 *
 * Two differences are reported as notes, not mismatches, because the spec doesn't decide
 * them yet: the time zone in the header (Python's standard library can't name the local
 * IANA zone, ADR-0096's first expected case), and an excluded directory written as one row
 * where the other side wrote a row per file in it, or the reverse
 * (proposals/cleanroom-fixtures.md). Either one is for the run's report to discuss.
 *
 * Exits 1 if anything mismatched, 0 if only notes or nothing.
 *
 * Usage:
 *   node scripts/cleanroom/compare-snapshot.mjs <root>
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { gunzipSync } from "node:zlib";
import { cli, sandboxPath } from "./cleanroom.mjs";

const [arg, ...extra] = process.argv.slice(2);
if (!arg || extra.length > 0) {
  console.error(
    "usage: node scripts/cleanroom/compare-snapshot.mjs <root>\n\n" +
      "e.g. node scripts/cleanroom/compare-snapshot.mjs ~/s3cab.sandbox",
  );
  process.exit(2);
}
const root = sandboxPath(arg);
const setsDir = join(root, "cleanroom", "sets");
if (!existsSync(setsDir)) {
  console.error(
    `${setsDir} doesn't exist, so ${root} isn't a snapshot sandbox. Pass the root\n` +
      "that build-snapshot-cleanroom.mjs built, not the cleanroom inside it.",
  );
  process.exit(2);
}

const snapshotName = /^\d{4}-\d{2}-\d{2}T\d{4}$/;
const instant = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const sha256 = /^[0-9a-f]{64}$/;

/**
 * @typedef {object} Snapshot
 * @property {string} set the header's set name
 * @property {string} name the header's snapshot name
 * @property {string} zone the header's time zone, or "" if it has none
 * @property {string[]} dirs the `#DIR` headers
 * @property {Map<string, { hash: string, size: string, mtime: string }>} files by path
 * @property {Map<string, Set<string>>} metadata paths by row kind (`#EXCLUDED`, …)
 */

/**
 * Read a snapshot as guide/format.md describes it. Everything that breaks a rule of the
 * format is pushed onto `problems` rather than thrown, so one run reports them all.
 * @param {Buffer} gz the `.tsv.gz` as stored
 * @param {string[]} problems
 * @returns {Snapshot | undefined} undefined if it can't be read at all
 */
function parse(gz, problems) {
  /** @type {string} */
  let text;
  try {
    // ignoreBOM keeps a BOM in the text, so it can be reported rather than skipped.
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      gunzipSync(gz),
    );
  } catch (error) {
    problems.push(`can't be read as gzipped UTF-8 (${String(error)})`);
    return undefined;
  }
  if (text.startsWith("﻿")) {
    problems.push("starts with a byte-order mark");
  }
  if (!text.endsWith("\n")) {
    problems.push("its last line isn't terminated with LF");
  }
  const lines = text.split("\n");
  if (lines.at(-1) === "") {
    lines.pop();
  }
  const withCR = lines.filter((line) => line.endsWith("\r")).length;
  if (withCR > 0) {
    problems.push(`${withCR} line(s) end in CR: lines end with LF alone`);
  }

  /** @type {Snapshot} */
  const snapshot = {
    set: "",
    name: "",
    zone: "",
    dirs: [],
    files: new Map(),
    metadata: new Map(),
  };
  /** @type {string[]} */
  const unpadded = [];
  let headerEnds = 1;
  for (const [index, line] of lines.entries()) {
    const number = index + 1;
    const fields = line.split("\t");
    const [first = "", second = "", third = ""] = fields;
    const kind = first.trim();
    if (fields.length < 4) {
      problems.push(`line ${number} has fewer than four fields`);
      continue;
    }
    // Every line s3cab writes is four columns, padded to 64, right-aligned in 10 and
    // padded to 24, the last never padded. A line pushed past four fields by a tab in a
    // metadata payload has no layout to hold it to.
    if (fields.length === 4) {
      const fourth = fields[3] ?? "";
      const laidOut = [
        first.trim().padEnd(64),
        second.trim().padStart(10),
        third.trim().padEnd(24),
        fourth,
      ].join("\t");
      if (line !== laidOut) {
        unpadded.push(String(number));
      }
    }
    const path = fields.at(-1) ?? "";

    if (index === 0) {
      if (kind !== "#SNAPSHOT") {
        problems.push("doesn't open with a #SNAPSHOT header");
        continue;
      }
      snapshot.set = second.trim();
      if (!instant.test(third.trim())) {
        problems.push(
          `#SNAPSHOT's start instant '${third.trim()}' is malformed`,
        );
      }
      const [name = "", ...zone] = (fields[3] ?? "").split(" ");
      snapshot.name = name;
      snapshot.zone = zone.join(" ");
      continue;
    }
    if (kind === "#DIR") {
      if (index !== headerEnds) {
        problems.push(`#DIR on line ${number} isn't in the header block`);
      }
      headerEnds = index + 1;
      snapshot.dirs.push(path);
      continue;
    }
    if (kind === "#END") {
      if (index !== lines.length - 1) {
        problems.push(`#END on line ${number} isn't the last line`);
      }
      if (second.trim() !== "COMPLETE") {
        problems.push(`#END's status is '${second.trim()}', not COMPLETE`);
      }
      if (!instant.test(third.trim())) {
        problems.push(`#END's instant '${third.trim()}' is malformed`);
      }
      continue;
    }
    if (kind.startsWith("#")) {
      const paths = snapshot.metadata.get(kind) ?? new Set();
      paths.add(path);
      snapshot.metadata.set(kind, paths);
      continue;
    }
    if (fields.length !== 4) {
      problems.push(`file row on line ${number} has ${fields.length} fields`);
      continue;
    }
    const row = { hash: kind, size: second.trim(), mtime: third.trim() };
    if (!sha256.test(row.hash) || !/^\d+$/.test(row.size)) {
      problems.push(`file row on line ${number} has a malformed hash or size`);
    }
    if (!instant.test(row.mtime)) {
      problems.push(`file row on line ${number} has a malformed mtime`);
    }
    if (snapshot.files.has(path)) {
      problems.push(`${show(path)} has a second row, on line ${number}`);
    }
    snapshot.files.set(path, row);
  }
  if (lines.at(-1)?.split("\t")[0]?.trim() !== "#END") {
    problems.push("has no #END trailer as its last line");
  }
  if (unpadded.length > 0) {
    problems.push(
      `${unpadded.length} line(s) aren't laid out in the padded columns, such as line ` +
        unpadded.slice(0, 5).join(", "),
    );
  }
  return snapshot;
}

/**
 * Whether one path is the other or lies inside it, by whole segments.
 * @param {string} a
 * @param {string} b
 */
const nested = (a, b) =>
  a === b || a.startsWith(b + sep) || b.startsWith(a + sep);

/**
 * A path or zone as JSON, so what makes two of them differ can be seen: the fixtures'
 * names hold `\v`, U+0085 and edge spaces, and a stray CR prints as nothing at all.
 * @param {string} text
 */
const show = (text) => JSON.stringify(text);

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

/**
 * The snapshots in `dir`, by name, oldest first. Only the spec's own file names: the
 * dot-files a run leaves while it works are never part of the set's history.
 * @param {string} dir
 */
const snapshotsIn = (dir) =>
  existsSync(dir)
    ? readdirSync(dir)
        .filter(
          (entry) =>
            entry.endsWith(".tsv.gz") &&
            snapshotName.test(entry.slice(0, -".tsv.gz".length)),
        )
        .sort()
    : [];

const home = mkdtempSync(join(tmpdir(), "s3cab-compare-snapshot-"));
const { mustRun } = cli(home);
let mismatched = false;

try {
  const setNames = readdirSync(setsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map(({ name }) => name)
    .sort();
  for (const set of setNames) {
    const roomSet = join(setsDir, set);
    /** @type {string[]} */
    const mismatches = [];
    /** @type {string[]} */
    const notes = [];

    // s3cab's snapshot of the same trees, from the same two files the session was given.
    const homeSet = join(home, "sets", set);
    mkdirSync(homeSet, { recursive: true });
    copyFileSync(join(roomSet, "dirs.txt"), join(homeSet, "dirs.txt"));
    if (existsSync(join(roomSet, "exclude.txt"))) {
      copyFileSync(join(roomSet, "exclude.txt"), join(homeSet, "exclude.txt"));
    }
    // A local set has to name a bucket; `snapshot` never reaches it.
    writeFileSync(
      join(homeSet, "env"),
      "S3CAB_BUCKET=s3cab-compare-snapshot\n",
    );
    mustRun(["snapshot", set]);
    const [referenceName = ""] = snapshotsIn(join(homeSet, "snapshots"));
    /** @type {string[]} */
    const referenceProblems = [];
    const reference = parse(
      readFileSync(join(homeSet, "snapshots", referenceName)),
      referenceProblems,
    );
    if (!reference || referenceProblems.length > 0) {
      throw new Error(
        `s3cab's own snapshot of ${set} broke the format:${some(referenceProblems)}`,
      );
    }

    const written = snapshotsIn(join(roomSet, "snapshots"));
    const latest = written.at(-1);
    if (!latest) {
      mismatches.push(
        "no snapshot in snapshots/, where the spec's local side puts a set's snapshots",
      );
    } else {
      if (written.length > 1) {
        notes.push(
          `${written.length} snapshots; compared the latest, ${latest}`,
        );
      }
      /** @type {string[]} */
      const problems = [];
      const ours = parse(
        readFileSync(join(roomSet, "snapshots", latest)),
        problems,
      );
      mismatches.push(...problems);
      if (ours) {
        const name = latest.slice(0, -".tsv.gz".length);
        if (ours.set !== set) {
          mismatches.push(`#SNAPSHOT names the set '${ours.set}'`);
        }
        if (ours.name !== name) {
          mismatches.push(`#SNAPSHOT names the snapshot '${ours.name}'`);
        }
        if (ours.zone !== reference.zone) {
          notes.push(
            `#SNAPSHOT's zone is ${show(ours.zone)}, where s3cab wrote ${show(reference.zone)}`,
          );
        }

        const dirsOnlyOurs = ours.dirs.filter(
          (dir) => !reference.dirs.includes(dir),
        );
        const dirsOnlyTheirs = reference.dirs.filter(
          (dir) => !ours.dirs.includes(dir),
        );
        if (dirsOnlyOurs.length > 0 || dirsOnlyTheirs.length > 0) {
          mismatches.push(
            `#DIR headers differ: only here${some(dirsOnlyOurs.map(show))}\n    only in s3cab's${some(dirsOnlyTheirs.map(show))}`,
          );
        }

        /** @type {string[]} */
        const missing = [];
        /** @type {string[]} */
        const differing = [];
        for (const [path, theirs] of reference.files) {
          const row = ours.files.get(path);
          if (!row) {
            missing.push(path);
          } else {
            for (const field of /** @type {const} */ ([
              "hash",
              "size",
              "mtime",
            ])) {
              if (row[field] !== theirs[field]) {
                differing.push(
                  `${show(path)}: ${field} ${row[field]}, s3cab ${theirs[field]}`,
                );
              }
            }
          }
        }
        const extra = [...ours.files.keys()].filter(
          (path) => !reference.files.has(path),
        );
        if (missing.length > 0) {
          mismatches.push(
            `file rows s3cab wrote and this didn't:${some(missing.map(show))}`,
          );
        }
        if (extra.length > 0) {
          mismatches.push(
            `file rows this wrote and s3cab didn't:${some(extra.map(show))}`,
          );
        }
        if (differing.length > 0) {
          mismatches.push(`file rows that differ:${some(differing)}`);
        }

        const kinds = new Set([
          ...ours.metadata.keys(),
          ...reference.metadata.keys(),
        ]);
        for (const kind of [...kinds].sort()) {
          const here = ours.metadata.get(kind) ?? new Set();
          const there = reference.metadata.get(kind) ?? new Set();
          const onlyHere = [...here].filter((path) => !there.has(path));
          const onlyThere = [...there].filter((path) => !here.has(path));
          if (onlyHere.length === 0 && onlyThere.length === 0) {
            continue;
          }
          if (!["#EXCLUDED", "#SKIPPED", "#ERROR"].includes(kind)) {
            notes.push(
              `${kind} rows, a kind the spec doesn't name:${some(onlyHere.map(show))}`,
            );
            continue;
          }
          // The same files excluded, written at a different granularity: every path only
          // one side has sits inside, or around, a path the other side has.
          const regrained =
            kind === "#EXCLUDED" &&
            onlyHere.every((path) => [...there].some((t) => nested(path, t))) &&
            onlyThere.every((path) => [...here].some((h) => nested(path, h)));
          (regrained ? notes : mismatches).push(
            `${kind} paths differ${regrained ? ", but only in how a directory is written" : ""}: only here${some(onlyHere.map(show))}\n    only in s3cab's${some(onlyThere.map(show))}`,
          );
        }
      }
    }

    mismatched ||= mismatches.length > 0;
    console.log(
      `${set}${latest ? `  ${latest}` : ""}  ${mismatches.length === 0 ? "matches" : `${mismatches.length} mismatch${mismatches.length === 1 ? "" : "es"}`}`,
    );
    for (const mismatch of mismatches) {
      console.log(`  mismatch: ${mismatch}`);
    }
    for (const note of notes) {
      console.log(`  note: ${note}`);
    }
  }
} finally {
  rmSync(home, { recursive: true, force: true });
}

process.exit(mismatched ? 1 : 0);
