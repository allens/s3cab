import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { commands } from "./commands.mjs";
import { helpTopics, usage } from "./help.mjs";

// usage() is a pure function over a registry (passed in, not imported), so it
// can be exercised with a small synthetic registry — plus a couple of checks
// against the real one to catch drift between the registry and its rendering.

/** @type {Record<string, import("./commands.mjs").Command>} */
const fakeRegistry = {
  go: {
    summary: "Do the thing",
    args: { "<target>": "What to do it to", "[<extra>]": "Optional extra" },
    options: {
      fast: { type: "boolean", short: "f", description: "Do it quickly" },
      mode: { type: "string", description: "How to do it" },
    },
    description: "Longer prose about doing the thing.",
    exec: () => undefined,
  },
  later: {
    summary: "Not built",
    planned: true,
    exec: () => undefined,
  },
};

describe("usage", () => {
  it("top-level lists every command with its summary", () => {
    const text = usage(fakeRegistry);

    assert.match(text, /Usage: s3cab <command>/);
    assert.match(text, /go\s+Do the thing/);
    assert.match(text, /later\s+Not built/);
  });

  it("marks planned commands as not yet available", () => {
    const text = usage(fakeRegistry);

    assert.match(text, /later\s+Not built \(not yet available\)/);
    assert.doesNotMatch(text, /Do the thing \(not yet available\)/);
  });

  it("groups commands under headings, sticky until the next group", () => {
    /** @type {Record<string, import("./commands.mjs").Command>} */
    const grouped = {
      a: { group: "First", summary: "A", exec: () => undefined },
      b: { summary: "B", exec: () => undefined }, // inherits "First"
      c: { group: "Second", summary: "C", exec: () => undefined },
    };
    const text = usage(grouped);

    assert.match(text, /First:\n {2}a\s+A\n {2}b\s+B\n\nSecond:\n {2}c\s+C/);
  });

  it("renders one flat Commands list for a registry with no groups", () => {
    assert.match(usage(fakeRegistry), /Commands:\n {2}go\s/);
  });

  it("top-level footer lists the help topics", () => {
    const text = usage(fakeRegistry);

    assert.match(
      text,
      new RegExp(`topics: ${Object.keys(helpTopics).join(", ")}`),
    );
  });

  it("falls back to the top-level list for an unknown command", () => {
    assert.equal(usage(fakeRegistry, "nope"), usage(fakeRegistry));
  });

  it("per-command help renders usage line, args, options, and description", () => {
    const text = usage(fakeRegistry, "go");

    assert.match(text, /Usage: s3cab go \[options\] <target> \[<extra>\]/);
    assert.match(text, /<target>\s+What to do it to/);
    assert.match(text, /-f, --fast\s+Do it quickly/);
    assert.match(text, /--mode\s+How to do it/); // short-less option renders too
    assert.match(text, /Longer prose about doing the thing\./);
  });

  it("every command's help offers -h/--help, even with no declared options", () => {
    // The dispatcher answers -h/--help for every command, so usage() must
    // advertise it whether or not the command declares options of its own.
    assert.match(usage(fakeRegistry, "go"), /-h, --help\s+Show this help/);

    const text = usage(fakeRegistry, "later"); // declares no options
    assert.match(text, /Usage: s3cab later \[options\]/);
    assert.match(text, /-h, --help\s+Show this help/);
  });

  it("renders every real command in the top-level help", () => {
    const text = usage(commands);

    for (const name of Object.keys(commands)) {
      assert.match(text, new RegExp(`^  ${name}\\s`, "m"));
    }
  });
});

describe("helpTopics", () => {
  it("exclude topic carries the matching contract from doc/exclude.md", () => {
    // Mirrors the matcher in src/commands/tree.mjs — if the glob rules change
    // there, this topic and doc/exclude.md must change with them.
    const exclude = helpTopics.exclude ?? "";

    assert.match(exclude, /\.s3cab\/exclude\.txt/);
    assert.match(exclude, /\*\*\/\s+zero or more/);
    assert.match(exclude, /one or more characters/);
    assert.match(exclude, /case-insensitive on Windows/);
    assert.match(exclude, /doc\/exclude\.md/); // links the full online guide
  });

  it("auth topic documents the two-step resolution and no s3cab sign-in flow", () => {
    const auth = helpTopics.auth ?? "";

    assert.match(auth, /env files/);
    assert.match(auth, /standard AWS SDK credential chain/);
    // SSO users are pointed at the AWS CLI; s3cab's own login command was
    // removed and must not be advertised.
    assert.match(auth, /aws sso login/);
    assert.doesNotMatch(auth, /s3cab login/);
  });
});
