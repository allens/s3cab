/**
 * A snapshot the clean-room backup wrote, against `s3cab snapshot` of the same trees
 * (ADR-0096). check-backup.mjs downloads each published snapshot and hands it here, with
 * s3cab's reference taken there and then in a throwaway home, so s3cab's output never
 * exists while the session could read it.
 *
 * What has to match is ADR-0096's list. File rows are compared as a set, exact in hash,
 * size, mtime and path. The excluded and unreadable paths must match, but the spec doesn't
 * fix which pattern an `#excluded` row names or how an `#error` row's message is worded,
 * so those rows are compared by path only; snapshot names and instants differ by run. The
 * session's file is also held to the format's rules: five fields a line, LF endings, the
 * heading row first, the `.` last, and `FILES` and `SIZE` agreeing with its file rows. The
 * padding and `SIZE`'s readable form are recommendations (guide/format.md, "Canonical
 * form"), so a departure there is a note.
 *
 * Two more differences are reported as notes, not mismatches, because the spec leaves them
 * to the writer: `@SET BUCKET` left out, which the spec makes optional, so it is compared
 * only when written; and the time zone in `@SNAPSHOT START` (Python's standard library
 * can't name the local IANA zone, ADR-0096's first expected case). Each is for the run's
 * report to discuss.
 */
import { gunzipSync } from "node:zlib";

const instant = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const sha256 = /^[0-9a-f]{64}$/;

/**
 * One line as s3cab lays it out: the type unpadded, column 2 padded to 64, the size
 * right-aligned in 12, the time padded to 24, the last column never padded. Widths count
 * code points, where `padEnd` counts UTF-16 units.
 * @param {string[]} fields
 */
const laidOut = ([type = "", col2 = "", size = "", time = "", last = ""]) =>
  [
    type.trim(),
    col2.trim() + " ".repeat(Math.max(0, 64 - [...col2.trim()].length)),
    size.trim().padStart(12),
    time.trim().padEnd(24),
    last,
  ].join("\t");

const heading = laidOut([
  "@S3CAB",
  "FORMAT",
  "size",
  "time",
  "https://s3cab.plantegral.com/guide/format",
]);

/**
 * @typedef {object} Snapshot
 * @property {string} set `@SET NAME`
 * @property {string | undefined} bucket `@SET BUCKET`, or undefined if there is no row
 * @property {string} name `@SNAPSHOT NAME`
 * @property {string} zone `@SNAPSHOT START`'s time zone, or "" if it has none
 * @property {string} size `@SNAPSHOT SIZE`'s value, or "" if it has none
 * @property {string[]} dirs the `@SET DIR` rows
 * @property {Map<string, { hash: string, size: string, mtime: string }>} files the
 *   file rows, by path
 * @property {Map<string, Set<string>>} metadata paths by row type (`#excluded`, …)
 */

/**
 * Read a snapshot as guide/format.md describes it. Everything that breaks a rule of the
 * format is pushed onto `problems` rather than thrown, so one run reports them all; a
 * departure from a recommendation (the padding) onto `notes`.
 * @param {Buffer} gz the `.tsv.gz` as stored
 * @param {string[]} problems
 * @param {string[]} notes
 * @returns {Snapshot | undefined} undefined if it can't be read at all
 */
export function parse(gz, problems, notes) {
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
    bucket: undefined,
    name: "",
    zone: "",
    size: "",
    dirs: [],
    files: new Map(),
    metadata: new Map(),
  };
  /** @type {string[]} */
  const unpadded = [];
  /** @type {Set<string>} */
  const paths = new Set();
  let objects = 0;
  let bytes = 0;
  /** @type {Record<string, string>} */
  const declared = {};
  for (const [index, line] of lines.entries()) {
    const number = index + 1;
    if (line === ".") {
      if (index !== lines.length - 1) {
        problems.push(`the . on line ${number} isn't the last line`);
      }
      continue;
    }
    const fields = line.split("\t");
    if (fields.length !== 5) {
      problems.push(`line ${number} has ${fields.length} fields, not five`);
      continue;
    }
    if (line !== laidOut(fields)) {
      unpadded.push(String(number));
    }
    const [type = "", col2 = "", size = "", time = ""] = fields
      .slice(0, 4)
      .map((field) => field.trim());
    const last = fields[4] ?? "";

    if (index === 0) {
      // A rule, read as s3cab's parser reads it: fields trimmed, the address exact.
      if (laidOut(fields) !== heading) {
        problems.push("doesn't open with the heading row");
      }
      continue;
    }
    if (type.startsWith("@")) {
      const property = `${type} ${col2}`;
      if (property === "@SET NAME") {
        snapshot.set = last;
      } else if (property === "@SET BUCKET") {
        snapshot.bucket = last;
      } else if (property === "@SET DIR") {
        snapshot.dirs.push(last);
      } else if (property === "@SNAPSHOT NAME") {
        snapshot.name = last;
      } else if (property === "@SNAPSHOT START") {
        if (!instant.test(time)) {
          problems.push(`@SNAPSHOT START's instant '${time}' is malformed`);
        }
        snapshot.zone = last;
      } else if (property === "@SNAPSHOT FINISH") {
        if (!instant.test(time)) {
          problems.push(`@SNAPSHOT FINISH's instant '${time}' is malformed`);
        }
      } else if (
        property === "@SNAPSHOT FILES" ||
        property === "@SNAPSHOT SIZE"
      ) {
        declared[col2] = last;
        if (col2 === "SIZE") {
          snapshot.size = last;
        }
      }
      continue;
    }
    if (["-", "#excluded", "#error"].includes(type)) {
      if (paths.has(last)) {
        problems.push(`${show(last)} is in a second row, on line ${number}`);
      }
      paths.add(last);
    }
    if (type === "-") {
      objects += 1;
      bytes += Number(size);
      if (!sha256.test(col2) || !/^\d+$/.test(size)) {
        problems.push(
          `file row on line ${number} has a malformed hash or size`,
        );
      }
      if (!instant.test(time)) {
        problems.push(`file row on line ${number} has a malformed mtime`);
      }
      snapshot.files.set(last, { hash: col2, size, mtime: time });
    } else if (type.startsWith("#")) {
      const rows = snapshot.metadata.get(type) ?? new Set();
      rows.add(last);
      snapshot.metadata.set(type, rows);
    } else {
      problems.push(
        `line ${number} has the type '${type}', starting with neither @ nor #, which the spec doesn't name`,
      );
    }
  }
  if (lines.at(-1) !== ".") {
    problems.push("has no . as its last line");
  }
  if (!lines.at(-2)?.startsWith("@SNAPSHOT\tFINISH")) {
    problems.push("has no @SNAPSHOT FINISH row just before the .");
  }
  // Only when present, like every whole-snapshot row: what a clean room can write in
  // them is ADR-0096's open question, but the spec says these two are exact.
  if (declared.FILES !== undefined && declared.FILES !== String(objects)) {
    problems.push(
      `@SNAPSHOT FILES says ${declared.FILES}, where there are ${objects} file rows`,
    );
  }
  if (
    declared.SIZE !== undefined &&
    declared.SIZE.split(" ")[0] !== String(bytes)
  ) {
    problems.push(
      `@SNAPSHOT SIZE says ${declared.SIZE}, where the size column sums to ${bytes}`,
    );
  }
  if (unpadded.length > 0) {
    notes.push(
      `${unpadded.length} line(s) aren't laid out in the padded columns, such as line ` +
        unpadded.slice(0, 5).join(", "),
    );
  }
  return snapshot;
}

/**
 * A path or zone as JSON, so what makes two of them differ can be seen: the fixtures'
 * names hold `\v`, U+0085 and edge spaces, and a stray CR prints as nothing at all.
 * @param {string | undefined} text
 */
const show = (text) => JSON.stringify(text);

/**
 * Up to ten of `items`, one per line, and how many more there were.
 * @param {string[]} items
 */
export const some = (items) =>
  items
    .slice(0, 10)
    .map((item) => `\n      ${item}`)
    .join("") +
  (items.length > 10 ? `\n      … and ${items.length - 10} more` : "");

/**
 * The session's snapshot, parsed, against s3cab's: the rows, once {@link parse} has held
 * the file to the format's rules.
 * @param {Snapshot} ours the session's snapshot
 * @param {{ set: string, name: string }} filed the set it is filed under and its name
 *   without `.tsv.gz`, which its own rows have to agree with
 * @param {Snapshot} reference s3cab's snapshot of the same trees
 * @returns {{ mismatches: string[], notes: string[] }}
 */
export function compareSnapshot(ours, filed, reference) {
  /** @type {string[]} */
  const mismatches = [];
  /** @type {string[]} */
  const notes = [];
  if (ours.set !== filed.set) {
    mismatches.push(`@SET NAME names the set '${ours.set}'`);
  }
  if (ours.name !== filed.name) {
    mismatches.push(`@SNAPSHOT NAME names the snapshot '${ours.name}'`);
  }
  if (ours.bucket === undefined) {
    notes.push(
      `no @SET BUCKET row, which the spec makes optional; s3cab wrote ${show(reference.bucket)}`,
    );
  } else if (ours.bucket !== reference.bucket) {
    mismatches.push(
      `@SET BUCKET is ${show(ours.bucket)}, where s3cab wrote ${show(reference.bucket)}`,
    );
  }
  if (ours.size !== reference.size) {
    notes.push(
      `@SNAPSHOT SIZE is ${show(ours.size)}, where s3cab wrote ${show(reference.size)}`,
    );
  }
  if (ours.zone !== reference.zone) {
    notes.push(
      `@SNAPSHOT START's zone is ${show(ours.zone)}, where s3cab wrote ${show(reference.zone)}`,
    );
  }

  const dirsOnlyOurs = ours.dirs.filter((dir) => !reference.dirs.includes(dir));
  const dirsOnlyTheirs = reference.dirs.filter(
    (dir) => !ours.dirs.includes(dir),
  );
  if (dirsOnlyOurs.length > 0 || dirsOnlyTheirs.length > 0) {
    mismatches.push(
      `@SET DIR rows differ: only here${some(dirsOnlyOurs.map(show))}\n    only in s3cab's${some(dirsOnlyTheirs.map(show))}`,
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
      for (const field of /** @type {const} */ (["hash", "size", "mtime"])) {
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
    if (!["#excluded", "#error"].includes(kind)) {
      notes.push(
        `${kind} rows, a kind the spec doesn't name:${some(onlyHere.map(show))}`,
      );
      continue;
    }
    mismatches.push(
      `${kind} paths differ: only here${some(onlyHere.map(show))}\n    only in s3cab's${some(onlyThere.map(show))}`,
    );
  }
  return { mismatches, notes };
}
