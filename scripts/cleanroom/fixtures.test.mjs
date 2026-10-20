import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { basename, dirname, join, resolve, sep } from "node:path";
import { describe, it } from "node:test";
import { gunzipSync, gzipSync } from "node:zlib";
import {
  HEADING,
  SPEC_DATE,
  formatLine,
  parseSnapshotStream,
} from "../../src/lib/snapshot-file.mjs";
import {
  damagedCopy,
  endingInHeaderRow,
  withHandEdits,
  withoutTrailer,
} from "./fixtures.mjs";

// The seed's damaged copies of `faults`' snapshot, read by s3cab's own reader: each copy
// claims a refusal, whole or path by path, and this is what keeps the claim true. The
// snapshot is built here, shaped as s3cab writes `faults`' on this machine.

const dir = resolve("fixtures", "faults") + sep;
const time = "2026-10-20T08:59:12.345Z";
const property = (
  /** @type {string} */ type,
  /** @type {string} */ name,
  /** @type {string} */ value,
  at = "",
) => formatLine(type, name, "", at, value);
const file = (/** @type {string} */ name, /** @type {string} */ hash) =>
  formatLine("-", hash.repeat(64), 21, time, `${dir}${name}`);
const whole = gzipSync(
  HEADING +
    property("@S3CAB", "SPEC", SPEC_DATE) +
    property("@CLIENT", "NAME", "s3cab") +
    property("@CLIENT", "VERSION", "0.0.0") +
    property("@SET", "NAME", "faults-linux") +
    property("@SET", "DIR", dir) +
    property("@SNAPSHOT", "NAME", "2026-10-20T1000") +
    property(
      "@SNAPSHOT",
      "START",
      "Europe/London",
      "2026-10-20T09:00:01.000Z",
    ) +
    file("deleted.txt", "a") +
    file("recoverable.txt", "b") +
    file("torn.txt", "c") +
    property("@SNAPSHOT", "FILES", "3") +
    property("@SNAPSHOT", "SIZE", "63 (63B)") +
    property("@SNAPSHOT", "FINISH", "1s", "2026-10-20T09:00:02.000Z") +
    ".\n",
);

/** @param {Buffer} body */
const read = (body) => parseSnapshotStream(Readable.from([gunzipSync(body)]));

describe("the seed's damaged copies of faults' snapshot", () => {
  it("are backdated whole: key, NAME and START move back together", () => {
    const { name, body } = damagedCopy(whole, 2, (text) => text);
    assert.equal(name, "2026-10-20T0958");
    const text = gunzipSync(body).toString("utf8");
    assert.match(text, /\n@SNAPSHOT\tNAME +\t +\t +\t2026-10-20T0958\n/);
    assert.match(text, /\n@SNAPSHOT\tSTART +\t +\t2026-10-20T08:58:01\.000Z\t/);
  });

  it("read whole when undamaged, the control for the rest", async () => {
    const { refused, entries } = await read(
      damagedCopy(whole, 1, (t) => t).body,
    );
    assert.equal(entries.size, 3);
    assert.equal(refused.size, 0);
  });

  it("refuse the cut-off copies whole", async () => {
    for (const damage of [withoutTrailer, endingInHeaderRow]) {
      await assert.rejects(read(damagedCopy(whole, 1, damage).body), {
        message: /closing "\." line is missing/,
      });
    }
  });

  it("refuse each hand-edited row and restore the rest", async () => {
    const snapshot = await read(damagedCopy(whole, 2, withHandEdits).body);
    const member = dir.slice(0, -1);
    const refused = [
      `${member}X${sep}beside.txt`,
      `${dir}twice.txt`,
      `${dir}..${sep}..${sep}escaped.txt`,
      ...(process.platform === "win32"
        ? []
        : [join(dirname(member), basename(member).toUpperCase(), "case.txt")]),
    ];
    assert.deepEqual([...snapshot.refused.keys()].sort(), refused.sort());
    assert.deepEqual(
      [...snapshot.entries.keys()].sort(),
      ["deleted.txt", "recoverable.txt", "torn.txt"].map((name) => dir + name),
    );
  });

  it("count FILES and SIZE again after the hand edits", () => {
    const text = gunzipSync(
      damagedCopy(whole, 2, withHandEdits).body,
    ).toString();
    const added = process.platform === "win32" ? 4 : 5;
    assert.match(text, new RegExp(`\\tFILES +\\t +\\t +\\t${3 + added}\\n`));
    const size = 63 + 21 * (added - 1);
    assert.match(
      text,
      new RegExp(`\\tSIZE +\\t +\\t +\\t${size} \\(${size}B\\)\\n`),
    );
  });
});
