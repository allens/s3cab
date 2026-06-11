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

  it("renders every real command in the top-level help", () => {
    const text = usage(commands);

    for (const name of Object.keys(commands)) {
      assert.match(text, new RegExp(`^  ${name}\\s`, "m"));
    }
  });
});

describe("helpTopics", () => {
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
