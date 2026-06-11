import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { commands } from "./commands.mjs";

// Contract tests over the command registry: the shape the dispatcher and the
// help renderer rely on, and the conventions CLAUDE.md records (args keys are
// honest about optionality; stubs throw the shared not-implemented error).

describe("commands registry", () => {
  it("every command has a summary and an exec function", () => {
    for (const [name, command] of Object.entries(commands)) {
      assert.equal(typeof command.summary, "string", name);
      assert.ok(command.summary.length > 0, name);
      assert.equal(typeof command.exec, "function", name);
    }
  });

  it("args keys are honest: <required>, [<optional>] or [<variadic>...]", () => {
    for (const [name, { args }] of Object.entries(commands)) {
      for (const key of Object.keys(args ?? {})) {
        assert.match(
          key,
          /^(<[a-z-]+>|\[<[a-z-]+>(\.\.\.)?\])$/,
          `${name} arg key: ${key}`,
        );
      }
    }
  });

  it("planned stubs throw the shared not-implemented error", () => {
    const planned = Object.entries(commands).filter(([, c]) => c.planned);

    assert.ok(planned.length > 0, "expected some planned stubs pre-milestone");
    for (const [name, command] of planned) {
      assert.throws(
        () => command.exec({}, []),
        /Not yet implemented/,
        `${name} should throw notImplemented`,
      );
    }
  });

  it("the removed Tier 2 auth commands stay removed", () => {
    // `login` / `credential-process` were deliberately deleted (see the History
    // note in specs/auth.md) — interactive sign-in is the AWS CLI's job.
    assert.ok(!("login" in commands));
    assert.ok(!("credential-process" in commands));
  });
});
