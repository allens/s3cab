// What the snapshot-anatomy page says about each part of a snapshot: a note
// for every kind of row and for every column of each, each pointing at the
// section of guide/format.md that defines it. The spec is the authority, so a
// note says what a thing is for, never the rules about it. Browser-safe: the
// page's components import it, and only the sample's generator touches Node.

import { slugify } from "./slugify.mjs";

/**
 * A note, and the guide/format.md section it points at, by its heading. The
 * build fails on a link to a heading that no longer exists (check-links.mjs).
 * @typedef {{ text: string, section: string }} Note
 */
/**
 * A column's note, and its name for this kind of row.
 * @typedef {Note & { label: string }} ColumnNote
 */
/** @typedef {"heading" | "property" | "file" | "excluded" | "error"} Columns */
/**
 * A kind of row: its name, its note, and which notes its columns take. The
 * closing `.` has no columns.
 * @typedef {Note & { title: string, columns?: Columns }} RowNote
 */

/** @param {string} section */
export const specHref = (section) => `/guide/format#${slugify(section)}`;

/**
 * The kind of row a line is: its type, and for an `@` row its property too,
 * since `@SET DIR` and `@SNAPSHOT START` are different things.
 * @param {string} line - Without its LF
 */
export function kindOf(line) {
  const [type = "", property = ""] = line
    .split("\t", 2)
    .map((field) => field.trim());
  return type.startsWith("@") ? `${type} ${property}` : type;
}

/**
 * A line's fields, each split into its value and the spaces that pad it: the
 * size column is padded on the left, the others on the right, and the last
 * field never.
 * @param {string} line - Without its LF
 * @returns {{ value: string, pad: string, padFirst: boolean }[]}
 */
export function cellsOf(line) {
  const [a = "", b = "", c = "", d = "", ...rest] = line.split("\t");
  const leading = [a, b, c, d].map((field, at) => {
    const value = field.trim();
    const pad = " ".repeat(field.length - value.length);
    return { value, pad, padFirst: at === 2 };
  });
  return line.includes("\t")
    ? [...leading, { value: rest.join("\t"), pad: "", padFirst: false }]
    : [{ value: line, pad: "", padFirst: false }];
}

/** @type {Record<Columns, string>} */
export const COLUMN_TITLES = {
  heading: "The heading row",
  property: "An `@` row",
  file: "A file row",
  excluded: "An `#excluded` row",
  error: "An `#error` row",
};

/** @type {Record<Columns, ColumnNote[]>} */
export const COLUMNS = {
  heading: [
    {
      label: "type",
      text: "The heading row is an `@S3CAB` row, like the format's other facts.",
      section: "The columns",
    },
    {
      label: "property",
      text: "`FORMAT`: this row says what kind of file this is.",
      section: "The columns",
    },
    {
      label: "size",
      text: "The word `size`, naming column 3 for a spreadsheet's filter.",
      section: "The columns",
    },
    {
      label: "time",
      text: "The word `time`, naming column 4 the same way.",
      section: "The columns",
    },
    {
      label: "the spec",
      text: "Where the format is explained: the page this one annotates.",
      section: "The columns",
    },
  ],
  property: [
    {
      label: "type",
      text: "What the fact is about: `@S3CAB` the format, `@CLIENT` the tool that wrote the file, `@SET` the backup set, `@SNAPSHOT` this run.",
      section: "The whole-snapshot rows",
    },
    {
      label: "property",
      text: "Which fact this row records.",
      section: "The whole-snapshot rows",
    },
    {
      label: "size",
      text: "Blank: only a file row has a size.",
      section: "The columns",
    },
    {
      label: "instant",
      text: "A UTC instant, for a fact that has one; otherwise blank.",
      section: "The columns",
    },
    {
      label: "value",
      text: "The fact itself.",
      section: "The whole-snapshot rows",
    },
  ],
  file: [
    {
      label: "type",
      text: "`-`: a file.",
      section: "Row types",
    },
    {
      label: "hash",
      text: "The SHA-256 of the file's contents, which is also its key in the bucket: `objects/` and this hash. Two files with the same contents share one, like the two `beach.jpg` rows here.",
      section: "The columns",
    },
    {
      label: "size",
      text: "The file's size in bytes.",
      section: "The columns",
    },
    {
      label: "modified time",
      text: "When the file was last changed, in UTC, to the millisecond.",
      section: "The columns",
    },
    {
      label: "path",
      text: "Where the file was, in full. It comes last and is never padded, so a name can hold spaces.",
      section: "Paths",
    },
  ],
  excluded: [
    {
      label: "type",
      text: "`#excluded`: something left out of the backup on purpose.",
      section: "Row types",
    },
    {
      label: "why",
      text: "Why it was left out: here, the exclude pattern that matched it.",
      section: "Row types",
    },
    {
      label: "size",
      text: "Blank: nothing was backed up, so nothing is recorded about it.",
      section: "Row types",
    },
    {
      label: "time",
      text: "Blank, for the same reason.",
      section: "Row types",
    },
    {
      label: "path",
      text: "What was left out. A path ending in a separator is a folder, or a link to one.",
      section: "Row types",
    },
  ],
  error: [
    {
      label: "type",
      text: "`#error`: something that should have been backed up and wasn't.",
      section: "Row types",
    },
    {
      label: "message",
      text: "What went wrong, in words. A message too long for its column runs past it rather than being cut.",
      section: "Canonical form",
    },
    {
      label: "size",
      text: "Blank: nothing was backed up.",
      section: "Row types",
    },
    {
      label: "time",
      text: "Blank, for the same reason.",
      section: "Row types",
    },
    {
      label: "path",
      text: "What wasn't backed up. A path ending in a separator is a folder, or a link to one.",
      section: "Row types",
    },
  ],
};

/**
 * Every kind of row s3cab writes in a snapshot, keyed by {@link kindOf}.
 * @type {Record<string, RowNote>}
 */
export const ROWS = {
  "@S3CAB FORMAT": {
    title: "The heading row",
    text: "The first line of every s3cab file, always the same. It names columns 3 and 4 and says where the format is explained, so a file found on its own explains itself.",
    section: "The columns",
    columns: "heading",
  },
  "@S3CAB SPEC": {
    title: "`@S3CAB SPEC`",
    text: "The date of the spec this file follows.",
    section: "The whole-snapshot rows",
    columns: "property",
  },
  "@CLIENT NAME": {
    title: "`@CLIENT NAME`",
    text: "The tool that wrote the file.",
    section: "The whole-snapshot rows",
    columns: "property",
  },
  "@CLIENT VERSION": {
    title: "`@CLIENT VERSION`",
    text: "Which release of that tool.",
    section: "The whole-snapshot rows",
    columns: "property",
  },
  "@CLIENT HOME": {
    title: "`@CLIENT HOME`",
    text: "One of s3cab's own rows: the folder it keeps its settings in. Any `@CLIENT` row beyond `NAME` and `VERSION` belongs to the tool that wrote it.",
    section: "The whole-snapshot rows",
    columns: "property",
  },
  "@CLIENT EXCLUDE": {
    title: "`@CLIENT EXCLUDE`",
    text: "One of s3cab's own rows: an exclude pattern this run used, one row each.",
    section: "The whole-snapshot rows",
    columns: "property",
  },
  "@SET NAME": {
    title: "`@SET NAME`",
    text: "The backup set's name.",
    section: "The whole-snapshot rows",
    columns: "property",
  },
  "@SET BUCKET": {
    title: "`@SET BUCKET`",
    text: "The bucket the snapshot was made for.",
    section: "The whole-snapshot rows",
    columns: "property",
  },
  "@SET ENDPOINT": {
    title: "`@SET ENDPOINT`",
    text: "Where the bucket lives, when it isn't on AWS: here, Cloudflare R2.",
    section: "The whole-snapshot rows",
    columns: "property",
  },
  "@SET DIR": {
    title: "`@SET DIR`",
    text: "A folder the set backs up, one row each. Every file row's path lies inside one of them.",
    section: "The whole-snapshot rows",
    columns: "property",
  },
  "@SNAPSHOT NAME": {
    title: "`@SNAPSHOT NAME`",
    text: "The snapshot's name: the local time the run started, to the minute. The file is this name plus `.tsv.gz`.",
    section: "The whole-snapshot rows",
    columns: "property",
  },
  "@SNAPSHOT BY": {
    title: "`@SNAPSHOT BY`",
    text: "Who took the snapshot, as `user@machine`.",
    section: "The whole-snapshot rows",
    columns: "property",
  },
  "@SNAPSHOT START": {
    title: "`@SNAPSHOT START`",
    text: "When the run started, in UTC, and the time zone its name was given in.",
    section: "The whole-snapshot rows",
    columns: "property",
  },
  "#excluded": {
    title: "An `#excluded` row",
    text: "Something the backup left out on purpose. These come before the files, so “why wasn't this backed up?” is answered near the top.",
    section: "Row types",
    columns: "excluded",
  },
  "#error": {
    title: "An `#error` row",
    text: "Something that couldn't be backed up: here, a link to a folder outside the backup, and a file that was busy when it was read.",
    section: "Row types",
    columns: "error",
  },
  "-": {
    title: "A file row",
    text: "One file, and the only kind of row with contents to fetch.",
    section: "The columns",
    columns: "file",
  },
  "@SNAPSHOT FILES": {
    title: "`@SNAPSHOT FILES`",
    text: "How many file rows there are.",
    section: "The whole-snapshot rows",
    columns: "property",
  },
  "@SNAPSHOT SIZE": {
    title: "`@SNAPSHOT SIZE`",
    text: "The size column added up, then the same in a readable form.",
    section: "The whole-snapshot rows",
    columns: "property",
  },
  "@SNAPSHOT FINISH": {
    title: "`@SNAPSHOT FINISH`",
    text: "When the last file's row was written, in UTC, and how long the run took to get there.",
    section: "The whole-snapshot rows",
    columns: "property",
  },
  ".": {
    title: "The last line",
    text: "Says the file is complete. A snapshot without it was cut short.",
    section: "The last line",
  },
};
