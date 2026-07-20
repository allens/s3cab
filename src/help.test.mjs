import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { commands } from "./commands.mjs";
import { errorMessage, helpTopics, synopsis, usage } from "./help.mjs";
import { MissingArgError, ParseArgsError } from "./lib/error.mjs";

/** @import { Command } from "./commands.mjs" */

// usage() is a pure function over a registry (passed in, not imported), so it
// can be exercised with a small synthetic registry — plus a couple of checks
// against the real one to catch drift between the registry and its rendering.

/** @type {Record<string, Command>} */
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
    details: "Longer prose about doing the thing.",
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
    /** @type {Record<string, Command>} */
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

  it("renders a required variadic positional with an ellipsis and no brackets", () => {
    // Guards the real setup shape (ADR-0062): the directories are the bulk
    // operand and are required, so `<directory>...` — the set moved to --set.
    assert.equal(
      synopsis(commands, "setup"),
      "Usage: s3cab setup [options] <directory>...",
    );
  });

  it("renders a variadic optional positional with brackets and an ellipsis", () => {
    // The real restore shape: paths are the bulk operand but optional (none =
    // restore everything), so they bracket.
    assert.equal(
      synopsis(commands, "restore"),
      "Usage: s3cab restore [options] [<path>...]",
    );
  });
});

// The error line the dispatcher prints, asserted whole — the arg's spelling and
// its description are looked up by module-private helpers, so this is the seam
// where their output is actually observable (ADR-0038).
describe("errorMessage", () => {
  const go = /** @type {Command} */ (fakeRegistry.go);

  it("spells a missing option with both its forms when it has a short one", () => {
    assert.equal(
      errorMessage(go, new MissingArgError("fast")),
      "Missing required argument: -f, --fast — Do it quickly",
    );
  });

  it("spells a short-less option with its long form alone", () => {
    assert.equal(
      errorMessage(go, new MissingArgError("mode")),
      "Missing required argument: --mode — How to do it",
    );
  });

  it("spells a positional bare, without its optional/variadic decoration", () => {
    // `[<extra>]` would contradict "Missing required argument:" — the error is
    // about the absence, so the brackets are noise here.
    assert.equal(
      errorMessage(go, new MissingArgError("target")),
      "Missing required argument: <target> — What to do it to",
    );
    assert.equal(
      errorMessage(go, new MissingArgError("extra")),
      "Missing required argument: <extra> — Optional extra",
    );
  });

  it("leaves the error's own message alone for a name the registry lacks", () => {
    // A throw site and the registry disagreeing is a bug; don't invent a
    // spelling for it, and don't dangle an em dash with nothing after it.
    assert.equal(
      errorMessage(go, new MissingArgError("nope")),
      "Missing required argument: nope",
    );
  });

  it("leaves a usage error that names no single arg unchanged", () => {
    // Our flag conflicts and Node's own parse failures carry no argName.
    assert.equal(
      errorMessage(go, new ParseArgsError("Pass either a set or --bucket")),
      "Pass either a set or --bucket",
    );
  });

  it("never rewrites a non-missing error that names an arg for context", () => {
    // Naming an arg buys the description gloss, nothing more — only a
    // MissingArgError may be re-spelled. Rewriting this to "Missing required
    // argument: --mode" would assert something false (the user's mistake is the
    // combination, not an absent flag) and lose the wording that explains it.
    // The live case is aws's `--save needs --from-stack`, pinned in e2e.
    assert.equal(
      errorMessage(
        go,
        new ParseArgsError("--fast needs --mode <mode>", { argName: "mode" }),
      ),
      "--fast needs --mode <mode> — How to do it",
    );
  });

  it("leaves an ordinary runtime error unchanged", () => {
    assert.equal(
      errorMessage(go, new Error("Bucket not found")),
      "Bucket not found",
    );
  });

  it("stringifies a thrown non-error", () => {
    assert.equal(errorMessage(go, "just a string"), "just a string");
  });

  it("matches the real registry's --bucket, short form included", () => {
    const setup = /** @type {Command} */ (commands.setup);
    assert.match(
      errorMessage(setup, new MissingArgError("bucket")),
      /^Missing required argument: -b, --bucket — /,
    );
  });
});

describe("helpTopics", () => {
  it("no topic shares a command's name", () => {
    // `help <name>` checks topics before commands, so a topic named after a
    // command would shadow that command's help. Command-specific depth belongs
    // in the command's registry `details` (the aws topic was folded there);
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

  it("auth/provider is a command's details, not a topic (ADR-0041/0047)", () => {
    // The former auth topic folded into the command's registry details
    // (now `provider`); `help provider` reaches it via the `help <command>`
    // routing.
    assert.equal(helpTopics.auth, undefined);
    assert.equal(helpTopics.provider, undefined);
    const provider = commands.provider?.details ?? "";

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
