import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { describe, it } from "node:test";
import { parseDeletionRecord } from "./deletion-record.mjs";
import { HEADING, parseSnapshotStream } from "./snapshot-file.mjs";

// The rules every s3cab file follows, pinned once for both kinds
// (guide/format.md, "Valid and invalid files"): each case damages a valid
// snapshot and a valid deletion record the same way, and both readers must
// name the same fault. What it costs differs by kind — a snapshot is refused,
// a record distrusted with its well-formed rows still counting — so that is
// asserted per kind too. Each kind's own row rules stay in its own test file.

const T = "2026-08-14T09:31:07.412Z";

/** Each kind's rows between the heading and the `.`, every one well-formed. */
const KINDS = {
  snapshot: [
    "@SET\tDIR\t\t\t/home/me/",
    `-\t${"a".repeat(64)}\t12\t${T}\t/home/me/a.txt`,
  ],
  record: [`#deleted\t${"a".repeat(64)}\t12\t${T}\tme@PC`],
};

/**
 * Damage to a valid file, given as its lines: the heading, the kind's rows,
 * and the `.`, each without its LF.
 * @typedef {(lines: string[]) => string | Buffer} Damage
 */

/** @type {[string, Damage, RegExp][]} */
const CASES = [
  [
    "doesn't open with the heading row",
    ([, ...rest]) => [...rest, ""].join("\n"),
    /^the first line isn't the @S3CAB FORMAT heading row$/,
  ],
  [
    "has a blank line before the heading row",
    (lines) => ["", ...lines, ""].join("\n"),
    /heading row/,
  ],
  [
    "has a heading row whose column 2 isn't FORMAT",
    ([heading = "", ...rest]) =>
      [heading.replace("FORMAT", ""), ...rest, ""].join("\n"),
    /heading row/,
  ],
  [
    "has a heading row with a field after its URL",
    ([heading = "", ...rest]) => [`${heading}\textra`, ...rest, ""].join("\n"),
    /heading row/,
  ],
  [
    "has CRLF line endings",
    (lines) => [...lines, ""].join("\r\n"),
    /heading row/,
  ],
  [
    "holds a line that isn't UTF-8",
    // In a row no reader reads, which costs a snapshot the whole file all the
    // same: an é saved in Windows-1252.
    (lines) =>
      Buffer.concat([
        Buffer.from(`${lines.slice(0, -1).join("\n")}\n#note\tjos`),
        Buffer.from([0xe9]),
        Buffer.from("\n.\n"),
      ]),
    /^a line isn't UTF-8 text$/,
  ],
  [
    "has no closing .",
    (lines) => [...lines.slice(0, -1), ""].join("\n"),
    /^the closing "\." line is missing, so the file was cut short$/,
  ],
  [
    "ends in a . with no LF, as a write cut just after it",
    (lines) => lines.join("\n"),
    /^the closing "\." line is missing/,
  ],
  [
    "has a row after the closing .",
    (lines) => [...lines, lines[1], ""].join("\n"),
    /^the closing "\." line isn't the last$/,
  ],
  [
    "has a second . after the closing one, with no LF",
    (lines) => [...lines, "."].join("\n"),
    /^the closing "\." line isn't the last$/,
  ],
  [
    "has a blank line after the closing .",
    (lines) => [...lines, "", ""].join("\n"),
    /^the closing "\." line isn't the last$/,
  ],
  [
    "has whitespace after the closing ., with no LF",
    (lines) => [...lines, "  "].join("\n"),
    /^the closing "\." line isn't the last$/,
  ],
  [
    "holds a blank line between its rows",
    ([heading = "", ...rest]) => [heading, "", ...rest, ""].join("\n"),
    /^it holds a blank line$/,
  ],
  [
    "holds a line of only what the trim removes",
    ([heading = "", ...rest]) => [heading, " \t ", ...rest, ""].join("\n"),
    /^it holds a blank line$/,
  ],
  [
    "ends in a line that is more than .",
    (lines) => [...lines.slice(0, -1), ". ", ""].join("\n"),
    /^its closing line isn't exactly "\."$/,
  ],
  [
    "holds a type starting with neither @ nor #",
    ([heading = "", ...rest]) =>
      [heading, "xattr\tuser.tag\t\t\t/home/me/a.txt", ...rest, ""].join("\n"),
    /^it holds an unknown row type 'xattr', so a newer s3cab wrote it, or it isn't an s3cab file$/,
  ],
];

/** @param {keyof typeof KINDS} kind */
const linesOf = (kind) => [HEADING.slice(0, -1), ...KINDS[kind], "."];

/** @param {string | Buffer} body */
const bytesOf = (body) => Readable.from([Buffer.from(body)]);

describe("both readers judge a file by the same rules", () => {
  it("and read each kind's valid file as valid", async () => {
    const snapshot = await parseSnapshotStream(
      bytesOf(`${linesOf("snapshot").join("\n")}\n`),
    );
    assert.deepEqual([...snapshot.entries.keys()], ["/home/me/a.txt"]);
    const record = await parseDeletionRecord(
      bytesOf(`${linesOf("record").join("\n")}\n`),
    );
    assert.equal(record.invalid, undefined);
    assert.equal(record.rows.length, 1);
  });

  for (const [what, damage, fault] of CASES) {
    it(`when the file ${what}`, async () => {
      // A snapshot is refused whole, as damage `isCorruptSnapshotError` knows.
      await assert.rejects(
        parseSnapshotStream(bytesOf(damage(linesOf("snapshot")))),
        (error) => {
          assert.equal(/** @type {Error} */ (error).name, "AssertionError");
          const message = /** @type {Error} */ (error).message;
          assert.match(message, /^Damaged snapshot: /);
          assert.match(message.slice("Damaged snapshot: ".length), fault);
          return true;
        },
      );
      // A record is distrusted, and its well-formed row still counts.
      const record = await parseDeletionRecord(
        bytesOf(damage(linesOf("record"))),
      );
      assert.match(record.invalid ?? "", fault);
      assert.equal(record.rows.length, 1);
    });
  }
});
