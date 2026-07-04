import assert from "node:assert/strict";
import { Readable, Writable } from "node:stream";
import { describe, it } from "node:test";
import { promptYesNo } from "./prompt.mjs";

// promptYesNo takes injectable streams (its test seam), so the y/N parsing is
// exercised without a real terminal. A sink swallows the prompt text.
const sink = () => new Writable({ write: (_c, _e, cb) => cb() });

/**
 * Drive one answer through the prompt.
 * @param {string} answer
 */
const ask = (answer) =>
  promptYesNo("Delete it?", {
    input: Readable.from([`${answer}\n`]),
    output: sink(),
  });

describe("promptYesNo", () => {
  it("treats y / yes (any case) as yes", async () => {
    for (const answer of ["y", "yes", "Y", "YES", " y ", "Yes"]) {
      assert.equal(await ask(answer), true, answer);
    }
  });

  it("treats anything else — including empty — as no (default No)", async () => {
    for (const answer of ["", "n", "no", "nope", "ye", "sure", "1"]) {
      assert.equal(await ask(answer), false, JSON.stringify(answer));
    }
  });

  it("treats a closed stdin (EOF, no answer) as no", async () => {
    assert.equal(
      await promptYesNo("Delete it?", {
        input: Readable.from([]),
        output: sink(),
      }),
      false,
    );
  });
});
