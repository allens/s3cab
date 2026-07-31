import assert from "node:assert";
import { describe, it } from "node:test";
import {
  alignTotalTable,
  formatByteValue,
  formatCount,
  formatDuration,
  plural,
} from "./format.mjs";

describe("formatByteValue", () => {
  it("scales by decimal SI units with one decimal place", () => {
    assert.equal(formatByteValue(0), "0B");
    assert.equal(formatByteValue(999), "999B");
    assert.equal(formatByteValue(1500), "1.5kB");
    assert.equal(formatByteValue(12345), "12.3kB");
    assert.equal(formatByteValue(12345678), "12.3MB");
    assert.equal(formatByteValue(5_000_000_000_000), "5.0TB");
  });

  // A whole scaled value keeps its decimal ("3.0MB", not "3MB") so a column of
  // sizes lines up; raw byte counts under 1000 stay exact integers.
  it("pads a whole scaled value to one decimal but leaves bytes integer", () => {
    assert.equal(formatByteValue(3_000_000), "3.0MB");
    assert.equal(formatByteValue(512), "512B");
  });

  // Regression for the `notation: "compact"` bug: short-scale "B"(illion)
  // collided with the byte unit, rendering 10⁹ as "1.5BB" instead of a GB.
  it("renders the billions scale as GB, not the '1.5BB' collision", () => {
    assert.equal(formatByteValue(1_500_000_000), "1.5GB");
  });

  // The same bug emitted a capitalised "KB"; SI is a lowercase "kB".
  it("uses SI casing 'kB', not 'KB'", () => {
    assert.equal(formatByteValue(1000), "1.0kB");
  });
});

describe("formatCount", () => {
  // The progress lines exist to be read at a glance, which is the whole reason
  // the separators are there — so pin the grouping rather than trusting the
  // ambient locale, which would otherwise render "265.716" or "265 716".
  it("groups thousands with commas", () => {
    assert.equal(formatCount(1000), "1,000");
    assert.equal(formatCount(265_716), "265,716");
    assert.equal(formatCount(1_234_567), "1,234,567");
  });

  // Below the first group there is nothing to separate; a stray "0" or a
  // decimal creeping in would show up on every small walk.
  it("leaves a value under a thousand bare", () => {
    assert.equal(formatCount(0), "0");
    assert.equal(formatCount(1), "1");
    assert.equal(formatCount(999), "999");
  });
});

describe("plural", () => {
  it("keeps the singular for exactly one and pluralises everything else", () => {
    assert.equal(plural(1, "file"), "file");
    assert.equal(plural(0, "file"), "files");
    assert.equal(plural(2, "file"), "files");
  });

  // Callers pass whole noun phrases ("7 stored objects"), so the "s" has to land
  // on the end of the phrase rather than on the first word.
  it("suffixes a noun phrase at its end", () => {
    assert.equal(plural(1, "stored object"), "stored object");
    assert.equal(plural(7, "stored object"), "stored objects");
  });
});

describe("alignTotalTable", () => {
  const headers = /** @type {[string, string, string]} */ ([
    "path",
    "files",
    "size",
  ]);
  const rows = /** @type {[string, string, string][]} */ ([
    ["a", "1", "1B"],
    ["bb", "10", "20B"],
    ["total", "11", "21B"],
  ]);

  // The whole point of the table is comparing magnitudes down a column, so pin
  // the padding exactly: labels left, both number columns right, and the rule
  // spanning just the numbers rather than the full line width.
  it("left-aligns labels, right-aligns numbers, rules off the total", () => {
    assert.deepEqual(alignTotalTable(headers, rows), [
      "  path   files  size",
      "  a          1    1B",
      "  bb        10   20B",
      "         ───────────",
      "  total     11   21B",
    ]);
  });

  // A header wider than every value under it still has to widen the column, or
  // the row it heads slides out from under it.
  it("counts the header in the column widths", () => {
    const lines = alignTotalTable(
      headers,
      /** @type {[string, string, string][]} */ ([
        ["a", "1", "1B"],
        ["total", "1", "1B"],
      ]),
    );
    assert.equal(lines[0], "  path   files  size");
    assert.equal(lines.at(-1), "  total      1    1B");
  });

  // `delete` names its stored-object count here. It has to fall outside the
  // alignment — inside it, it would stretch the size column for every row.
  it("trails the suffix after the total, outside the alignment", () => {
    const lines = alignTotalTable(headers, rows, "   (3 stored objects)");
    assert.equal(lines.at(-1), "  total     11   21B   (3 stored objects)");
    assert.deepEqual(
      lines.slice(0, -1),
      alignTotalTable(headers, rows).slice(0, -1),
    );
  });

  it("refuses a table with no total row", () => {
    assert.throws(() => alignTotalTable(headers, []), /total row/);
  });
});

describe("formatDuration", () => {
  // Intl picks the units and the plurals; these pin the cases a hand-rolled rule
  // gets wrong. The version this replaced rounded anything from 90 s upward to
  // whole minutes, so a 90 s window announced itself as "2 minutes".
  for (const [milliseconds, expected] of [
    [120_000, "2 minutes"],
    [60_000, "1 minute"],
    [90_000, "1 minute, 30 seconds"],
    [30_000, "30 seconds"],
    [1_000, "1 second"],
  ]) {
    it(`renders ${milliseconds}ms as "${expected}"`, () => {
      assert.equal(formatDuration(Number(milliseconds)), expected);
    });
  }
});
