import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { bold, isInteractive, shellCommand, styleEnabled } from "./style.mjs";

/** @type {NodeJS.ProcessEnv} */
let savedEnv;
beforeEach(() => {
  savedEnv = { ...process.env };
});
afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in savedEnv)) {
      delete process.env[key];
    }
  }
  Object.assign(process.env, savedEnv);
});

const tty = { isTTY: true };
const pipe = { isTTY: undefined };

describe("isInteractive", () => {
  it("is true only for a TTY stream", () => {
    assert.equal(isInteractive(tty), true);
    assert.equal(isInteractive(pipe), false);
  });
});

describe("styleEnabled", () => {
  it("is on for a TTY with no NO_COLOR and a normal TERM", () => {
    delete process.env.NO_COLOR;
    delete process.env.TERM;
    assert.equal(styleEnabled(tty), true);
  });

  it("is off for a non-TTY stream regardless of env", () => {
    delete process.env.NO_COLOR;
    assert.equal(styleEnabled(pipe), false);
  });

  it("is off when NO_COLOR is set and non-empty (no-color.org)", () => {
    process.env.NO_COLOR = "1";
    assert.equal(styleEnabled(tty), false);
  });

  it("stays on for an empty NO_COLOR (set-and-non-empty is the convention)", () => {
    process.env.NO_COLOR = "";
    delete process.env.TERM;
    assert.equal(styleEnabled(tty), true);
  });

  it("is off for TERM=dumb", () => {
    delete process.env.NO_COLOR;
    process.env.TERM = "dumb";
    assert.equal(styleEnabled(tty), false);
  });
});

describe("bold", () => {
  it("wraps in bold-on/bold-off (22, not a full reset)", () => {
    assert.equal(bold("Options:"), "\x1b[1mOptions:\x1b[22m");
  });
});

describe("shellCommand", () => {
  it("bolds the command when styling is on and leaves it plain when off", () => {
    assert.equal(shellCommand("s3cab verify b", true), bold("s3cab verify b"));
    assert.equal(shellCommand("s3cab verify b", false), "s3cab verify b");
  });

  it("decides by stderr when no color is passed", () => {
    const expected = styleEnabled(process.stderr)
      ? bold("s3cab verify b")
      : "s3cab verify b";
    assert.equal(shellCommand("s3cab verify b"), expected);
  });
});
