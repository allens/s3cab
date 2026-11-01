import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PROMPT, cast, transcript } from "./cast.mjs";
import { recording } from "./recording.mjs";

/** @import { Step } from "./cast.mjs" */

/**
 * A cast's header and events, failing on anything cast v2 doesn't allow.
 * @param {string} text
 */
function parseCast(text) {
  assert.ok(text.endsWith("\n"), "a cast ends with a newline");
  const [first = "", ...rest] = text.slice(0, -1).split("\n");
  const header = JSON.parse(first);
  assert.equal(header.version, 2);
  assert.ok(Number.isInteger(header.width) && header.width > 0);
  assert.ok(Number.isInteger(header.height) && header.height > 0);
  /** @type {[number, string][]} */
  const events = rest.map((line) => {
    const event = JSON.parse(line);
    assert.equal(event.length, 3, line);
    const [time, kind, data] = event;
    assert.equal(typeof time, "number", line);
    assert.equal(kind, "o", line);
    assert.equal(typeof data, "string", line);
    return [time, data];
  });
  for (const [i, [time]] of events.entries()) {
    assert.ok(
      time >= (events[i - 1]?.[0] ?? 0),
      `event ${i} goes back in time`,
    );
  }
  return { header, events };
}

/**
 * The text a cast writes, newlines as printed rather than as a terminal takes
 * them.
 * @param {[number, string][]} events
 */
const printedText = (events) =>
  events
    .map(([, data]) => data)
    .join("")
    .replaceAll("\r\n", "\n");

/** @type {Step[]} */
const steps = [
  { command: "s3cab list", output: "photos:\n  20251112T0915\n" },
  { command: "s3cab x", output: "a → b…\n\n" },
];

describe("cast", () => {
  it("writes exactly the steps' text, as a valid cast", () => {
    const { header, events } = parseCast(cast("Listing", steps));

    assert.equal(printedText(events), transcript(steps));
    assert.equal(
      transcript(steps),
      `${PROMPT}s3cab list\nphotos:\n  20251112T0915\n${PROMPT}s3cab x\na → b…\n\n${PROMPT}`,
    );
    assert.deepEqual(header, {
      version: 2,
      width: 80,
      height: 7,
      title: "Listing",
    });
  });

  it("is wide enough for the longest line, counted in characters", () => {
    const wide = `${"→".repeat(90)}\n`;
    const { header } = parseCast(
      cast("Wide", [{ command: "c", output: wide }]),
    );
    assert.equal(header.width, 90);
  });

  it("is never taller than a terminal, which scrolls the rest away", () => {
    const long = "line\n".repeat(30);
    const { header } = parseCast(
      cast("Long", [{ command: "c", output: long }]),
    );
    assert.equal(header.height, 16);
  });

  it("times each key, each line and the pauses the same way every time", () => {
    const { events } = parseCast(
      cast("Timing", [{ command: "ab", output: "1\n2\n" }]),
    );

    assert.deepEqual(events, [
      [0.5, PROMPT],
      [0.55, "a"],
      [0.6, "b"],
      [1, "\r\n"],
      [1.06, "1\r\n"],
      [1.12, "2\r\n"],
      [2.62, PROMPT],
    ]);
  });
});

describe("the home page's recording", async () => {
  const steps = await recording();

  it("is a valid cast of exactly what s3cab printed", () => {
    const { events } = parseCast(cast("Home", steps));

    assert.equal(
      printedText(events),
      steps
        .map(({ command, output }) => `${PROMPT}${command}\n${output}`)
        .join("") + PROMPT,
    );
  });

  it("is the same every time it is made", async () => {
    // A fresh temp home: nothing of the run that made it may show.
    const again = await recording();
    assert.equal(cast("Home", again), cast("Home", steps));
  });
});
