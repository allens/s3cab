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

/**
 * Each kind's rows between the heading and the `.`, every one well-formed —
 * as many for each, so a fault names the same line number in both.
 */
const KINDS = {
  snapshot: [
    "@SET\tDIR\t\t\t/home/me/",
    `-\t${"a".repeat(64)}\t12\t${T}\t/home/me/a.txt`,
  ],
  record: [
    `#deleted\t${"a".repeat(64)}\t12\t${T}\tme@PC`,
    `#deleted\t${"b".repeat(64)}\t34\t${T}\tme@PC`,
  ],
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
    "has a heading row that isn't UTF-8",
    ([heading = "", ...rest]) =>
      Buffer.concat([
        Buffer.from(heading),
        Buffer.from([0xe9]),
        Buffer.from(`\n${rest.join("\n")}\n`),
      ]),
    /^line 1 isn't UTF-8 text$/,
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
    /^line 4 isn't UTF-8 text$/,
  ],
  [
    "has a line that isn't UTF-8 after the closing .",
    (lines) =>
      Buffer.concat([
        Buffer.from(`${lines.join("\n")}\nx`),
        Buffer.from([0xe9]),
        Buffer.from("\n"),
      ]),
    /^line 5 isn't UTF-8 text$/,
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
    /^line 5 follows the closing "\." line$/,
  ],
  [
    "has a second . after the closing one, with no LF",
    (lines) => [...lines, "."].join("\n"),
    /^line 5 follows the closing "\." line$/,
  ],
  [
    "has a blank line after the closing .",
    (lines) => [...lines, "", ""].join("\n"),
    /^line 5 follows the closing "\." line$/,
  ],
  [
    "has whitespace after the closing ., with no LF",
    (lines) => [...lines, "  "].join("\n"),
    /^line 5 follows the closing "\." line$/,
  ],
  [
    "holds a blank line between its rows",
    ([heading = "", ...rest]) => [heading, "", ...rest, ""].join("\n"),
    /^line 2 is blank$/,
  ],
  [
    "holds a line of only what the trim removes",
    ([heading = "", ...rest]) => [heading, " \t ", ...rest, ""].join("\n"),
    /^line 2 is blank$/,
  ],
  [
    "ends in a line that is more than .",
    (lines) => [...lines.slice(0, -1), ". ", ""].join("\n"),
    /^line 4 is more than the closing "\."$/,
  ],
  [
    "holds a type starting with neither @ nor #",
    ([heading = "", ...rest]) =>
      [heading, "xattr\tuser.tag\t\t\t/home/me/a.txt", ...rest, ""].join("\n"),
    /^line 2 has an unknown row type 'xattr', so a newer s3cab wrote it, or it isn't an s3cab file$/,
  ],
];

/** @param {keyof typeof KINDS} kind */
const linesOf = (kind) => [HEADING.slice(0, -1), ...KINDS[kind], "."];

/**
 * A body as the bytes a read streams: whole, or (`size` set) in chunks that
 * split lines, and characters, wherever they fall.
 * @param {string | Buffer} body
 * @param {number} [size]
 */
const bytesOf = (body, size) => {
  const bytes = Buffer.from(body);
  if (size === undefined) {
    return Readable.from([bytes]);
  }
  const chunks = [];
  for (let start = 0; start < bytes.length; start += size) {
    chunks.push(bytes.subarray(start, start + size));
  }
  return Readable.from(chunks);
};

for (const size of [undefined, 1]) {
  const chunking = size === undefined ? "whole" : "a byte at a time";
  describe(`both readers judge a file by the same rules, read ${chunking}`, () => {
    it("and read each kind's valid file as valid", async () => {
      const snapshot = await parseSnapshotStream(
        bytesOf(`${linesOf("snapshot").join("\n")}\n`, size),
      );
      assert.deepEqual([...snapshot.entries.keys()], ["/home/me/a.txt"]);
      const record = await parseDeletionRecord(
        bytesOf(`${linesOf("record").join("\n")}\n`, size),
      );
      assert.equal(record.invalid, undefined);
      assert.equal(record.rows.length, KINDS.record.length);
    });

    it("and call text with no LF that isn't s3cab's not an s3cab file", async () => {
      const heading = /^the first line isn't the @S3CAB FORMAT heading row$/;
      await assert.rejects(
        parseSnapshotStream(bytesOf("hello", size)),
        (error) => {
          const message = /** @type {Error} */ (error).message;
          assert.match(message.slice("Damaged snapshot: ".length), heading);
          return true;
        },
      );
      const record = await parseDeletionRecord(bytesOf("hello", size));
      assert.match(record.invalid ?? "", heading);
    });

    for (const [what, damage, fault] of CASES) {
      it(`when the file ${what}`, async () => {
        // A snapshot is refused whole, as damage `isCorruptSnapshotError` knows.
        await assert.rejects(
          parseSnapshotStream(bytesOf(damage(linesOf("snapshot")), size)),
          (error) => {
            assert.equal(/** @type {Error} */ (error).name, "AssertionError");
            const message = /** @type {Error} */ (error).message;
            assert.match(message, /^Damaged snapshot: /);
            assert.match(message.slice("Damaged snapshot: ".length), fault);
            return true;
          },
        );
        // A record is distrusted, and its well-formed rows still count.
        const record = await parseDeletionRecord(
          bytesOf(damage(linesOf("record")), size),
        );
        assert.match(record.invalid ?? "", fault);
        assert.equal(record.rows.length, KINDS.record.length);
      });
    }
  });
}
