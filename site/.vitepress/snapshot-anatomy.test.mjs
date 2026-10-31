import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Readable } from "node:stream";
import { describe, it } from "node:test";
import {
  FILE,
  HEADING,
  TERMINATOR,
  parseSnapshotStream,
} from "../../src/lib/snapshot-file.mjs";
import { COLUMNS, ROWS, cellsOf, kindOf } from "./snapshot-anatomy.mjs";
import { sampleSnapshot } from "./snapshot-sample.data.mjs";

/**
 * Every kind of row the writer can emit, read from its source rather than
 * listed here: each `property(TYPE, NAME` and `formatLine(TYPE, …` call in it,
 * the module's own constants resolved, and the closing line.
 */
function writerKinds() {
  const source = readFileSync(
    new URL("../../src/lib/snapshot-file.mjs", import.meta.url),
    "utf8",
  );
  const constants = new Map(
    [...source.matchAll(/^(?:export )?const (\w+) = "([^"]*)";$/gm)].map(
      ([, name = "", value = ""]) => [name, value],
    ),
  );
  const kinds = new Set([TERMINATOR]);
  for (const [, type = "", second = ""] of source.matchAll(
    /\b(?:property|formatLine)\(\s*(\w+),\s*("[^"]*"|\w+)/g,
  )) {
    // Not a constant: a parameter, as in `property`'s own body.
    const name = constants.get(type);
    if (name === undefined) {
      continue;
    }
    const property = second.startsWith('"')
      ? second.slice(1, -1)
      : constants.get(second);
    kinds.add(name.startsWith("@") ? `${name} ${property}` : name);
  }
  return kinds;
}

describe("the snapshot-anatomy sample", async () => {
  const text = await sampleSnapshot();
  const lines = text.replace(/\n$/, "").split("\n");

  it("reads back cleanly with s3cab's own reader", async () => {
    const snapshot = await parseSnapshotStream(
      Readable.from([Buffer.from(text)]),
    );

    assert.deepEqual([...snapshot.refused], []);
    assert.equal(
      snapshot.entries.size,
      lines.filter((line) => kindOf(line) === FILE).length,
    );
    assert.equal(snapshot.dirs.length, 2);
  });

  it("is the same on every build", async () => {
    assert.equal(await sampleSnapshot(), text);
  });

  it("holds every kind of row the writer can emit", () => {
    const kinds = writerKinds();
    // A scan that found nothing would pass the check below.
    assert.ok(kinds.has(FILE) && kinds.has(kindOf(HEADING)));

    const missing = [...kinds].filter(
      (kind) => !lines.some((line) => kindOf(line) === kind),
    );
    assert.deepEqual(missing, []);
  });

  it("has a note for every kind of row in it, and every column", () => {
    for (const line of lines) {
      const row = ROWS[kindOf(line)];
      assert.ok(row, `no note for ${kindOf(line)}`);
      const notes = row.columns ? COLUMNS[row.columns].length : 1;
      assert.equal(notes, cellsOf(line).length, `columns of ${kindOf(line)}`);
    }
  });
});
