import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { commands } from "./commands.mjs";
import { argDescription, helpTopics, synopsis, usage } from "./help.mjs";

// usage() is a pure function over a registry (passed in, not imported), so it
// can be exercised with a small synthetic registry — plus a couple of checks
// against the real one to catch drift between the registry and its rendering.

/** @type {Record<string, import("./commands.mjs").Command>} */
const fakeRegistry = {
  go: {
    summary: "Do the thing",
    examples: ["s3cab go now", "s3cab go now --fast"],
    args: {
      target: { required: true, description: "What to do it to" },
      extra: { description: "Optional extra" },
    },
    options: {
      fast: { type: "boolean", short: "f", description: "Do it quickly" },
      mode: { type: "string", description: "How to do it" },
    },
    description: "Longer prose about doing the thing.",
    exec: () => undefined,
    render: String,
  },
  later: {
    summary: "Not built",
    planned: true,
    exec: () => undefined,
    render: String,
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
      a: {
        group: "First",
        summary: "A",
        exec: () => undefined,
        render: String,
      },
      b: { summary: "B", exec: () => undefined, render: String }, // inherits "First"
      c: {
        group: "Second",
        summary: "C",
        exec: () => undefined,
        render: String,
      },
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

  it("top-level help has a Global options section listing --json/--version/--help", () => {
    // The dispatcher-owned flags (ADR-0043 for --json) get their own section
    // rather than being buried in footer prose.
    const text = usage(fakeRegistry);

    assert.match(text, /Global options:/);
    assert.match(text, /--json\s+Print machine-readable JSON/);
    assert.match(text, /-v, --version\s+Print the version/);
    assert.match(text, /-h, --help\s+Show this help/);
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

  it("renders examples after the summary, before the argument table", () => {
    // Examples lead (clig.dev): summary, then Examples, then the reference tables.
    const text = usage(fakeRegistry, "go");

    assert.match(
      text,
      /Do the thing\n\nExamples:\n {2}s3cab go now\n {2}s3cab go now --fast\n\nArguments:/,
    );
  });

  it("omits the Examples section when a command declares none", () => {
    assert.doesNotMatch(usage(fakeRegistry, "later"), /Examples:/);
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

  it("compare help drops the retired →→/== notation", () => {
    // Guards the specific drift this test file exists to catch: compare's
    // renderer prints moves as `old → new` and copies as `(duplicate of …)`,
    // so its --help must never reintroduce the old `→→`/`==` microsyntax (now
    // confined to compare.test.mjs's internal assertion notation). A negative
    // pin only — the positive wording is free to be reworded.
    assert.doesNotMatch(usage(commands, "compare"), /→→|==/);
  });

  it("style.heading decorates section headings only, not their content", () => {
    // The dispatcher passes { heading: bold } when stdout is an interactive
    // terminal (lib/style.mjs); usage() itself never decides — plain default.
    const marked = usage(fakeRegistry, "go", {
      heading: (text) => `<${text}>`,
    });

    assert.match(marked, /^<Examples:>$/m);
    assert.match(marked, /^<Arguments:>$/m);
    assert.match(marked, /^<Options:>$/m);
    assert.match(marked, /^<Description:>$/m);
    assert.doesNotMatch(marked, /<Usage/); // the synopsis line stays plain
    assert.doesNotMatch(marked, /<\s*s3cab go now/); // example lines stay plain

    // Top-level group headings decorate too; command rows don't.
    const top = usage(fakeRegistry, undefined, {
      heading: (text) => `<${text}>`,
    });
    assert.match(top, /^<Commands:>$/m);
    assert.doesNotMatch(top, /< {2}go/);

    // No style → byte-identical plain output.
    assert.equal(usage(fakeRegistry, "go"), usage(fakeRegistry, "go", {}));
  });
});

describe("synopsis", () => {
  it("renders required and optional positionals from their metadata", () => {
    assert.equal(
      synopsis(fakeRegistry, "go"),
      "Usage: s3cab go [options] <target> [<extra>]",
    );
  });

  it("is just the command + [options] when it declares no args", () => {
    assert.equal(
      synopsis(fakeRegistry, "later"),
      "Usage: s3cab later [options]",
    );
  });

  it("renders a variadic optional positional with brackets and an ellipsis", () => {
    // Guards the real setup shape: <set> required, [<directory>...] optional variadic.
    assert.equal(
      synopsis(commands, "setup"),
      "Usage: s3cab setup [options] <set> [<directory>...]",
    );
  });
});

describe("argDescription", () => {
  const go = /** @type {import("./commands.mjs").Command} */ (fakeRegistry.go);

  it("finds a positional arg's description by plain name", () => {
    assert.equal(argDescription(go, "target"), "What to do it to");
  });

  it("finds an option's description by plain name", () => {
    assert.equal(argDescription(go, "mode"), "How to do it");
  });

  it("is undefined for an unknown name or a missing argName", () => {
    assert.equal(argDescription(go, "nope"), undefined);
    assert.equal(argDescription(go, undefined), undefined);
  });
});

describe("helpTopics", () => {
  it("no topic shares a command's name", () => {
    // `help <name>` checks topics before commands, so a topic named after a
    // command would shadow that command's help. Command-specific depth belongs
    // in the command's registry `description` (the aws topic was folded there);
    // topics are only for cross-cutting guides with no command to host them.
    for (const topic of Object.keys(helpTopics)) {
      assert.ok(
        !(topic in commands),
        `help topic '${topic}' collides with the '${topic}' command`,
      );
    }
  });

  it("exclude topic carries the matching contract from guide/exclude.md", () => {
    // Mirrors the matcher in src/commands/tree.mjs — if the glob rules change
    // there, this topic and guide/exclude.md must change with them.
    const exclude = helpTopics.exclude ?? "";

    assert.match(exclude, /sets\/<set>\/exclude\.txt/);
    assert.match(exclude, /\*\*\/\s+zero or more/);
    assert.match(exclude, /one or more characters/);
    assert.match(exclude, /case-insensitive on Windows/);
    // Links the full online guide on our own domain, never a github.com URL:
    // a shipped binary freezes what it prints (CLAUDE.md, "Stable doc URLs").
    assert.match(exclude, /https:\/\/s3cab\.plantegral\.com\/guide\/exclude/);
    assert.doesNotMatch(exclude, /github\.com/);
  });

  it("auth/provider is a command description, not a topic (ADR-0041/0047)", () => {
    // The former auth topic folded into the command's registry description
    // (now `provider`); `help provider` reaches it via the `help <command>`
    // routing.
    assert.equal(helpTopics.auth, undefined);
    assert.equal(helpTopics.provider, undefined);
    const provider = commands.provider?.description ?? "";

    assert.match(provider, /env files/);
    assert.match(provider, /standard AWS SDK credential chain/);
    // The non-AWS onboarding steps live here too (ADR-0047, option a).
    assert.match(provider, /Cloudflare R2/);
    assert.match(provider, /--endpoint/);
    // SSO users are pointed at the AWS CLI; s3cab's own login command was
    // removed and must not be advertised.
    assert.match(provider, /aws sso login/);
    assert.doesNotMatch(provider, /s3cab login/);
  });
});
