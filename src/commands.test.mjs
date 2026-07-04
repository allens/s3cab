import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { commands } from "./commands.mjs";

// Contract tests over the command registry: the shape the dispatcher and the
// help renderer rely on, and the conventions CLAUDE.md records (args are
// data-driven descriptors — plain-name keys, optionality in the metadata, not
// the key; ADR-0038; stubs throw the shared not-implemented error).

describe("commands registry", () => {
  it("every command has a summary and an exec function", () => {
    for (const [name, command] of Object.entries(commands)) {
      assert.equal(typeof command.summary, "string", name);
      assert.ok(command.summary.length > 0, name);
      assert.equal(typeof command.exec, "function", name);
    }
  });

  it("args are plain-name keys mapping to a described descriptor", () => {
    // Optionality/variadicity live in the descriptor (required/variadic), not a
    // decorated key — the display form <set>/[<directory>...] is derived from it.
    for (const [name, { args }] of Object.entries(commands)) {
      for (const [key, arg] of Object.entries(args ?? {})) {
        assert.match(key, /^[a-z][a-z-]*$/, `${name} arg key: ${key}`);
        assert.equal(
          typeof arg.description,
          "string",
          `${name}.${key} description`,
        );
        assert.ok(arg.description.length > 0, `${name}.${key} description`);
        if (arg.required !== undefined) {
          assert.equal(
            typeof arg.required,
            "boolean",
            `${name}.${key} required`,
          );
        }
        if (arg.variadic !== undefined) {
          assert.equal(
            typeof arg.variadic,
            "boolean",
            `${name}.${key} variadic`,
          );
        }
      }
    }
  });

  it("any planned stub throws the shared not-implemented error", () => {
    // The registry has no planned stubs today (verify was the last, now built),
    // but the convention stands: a `planned` command must throw `notImplemented`
    // so help can render it "(not yet available)" and running it fails cleanly.
    // (The rendering itself is covered by help.test.mjs's fixture; the
    // notImplemented factory by error.test.mjs.)
    for (const [name, command] of Object.entries(commands)) {
      if (!command.planned) continue;
      assert.throws(
        () => command.exec({}, []),
        /Not yet implemented/,
        `${name} should throw notImplemented`,
      );
    }
  });

  it("the removed Tier 2 auth commands stay removed", () => {
    // `login` / `credential-process` were deliberately deleted (see the History
    // note in docs/design/auth.md) — interactive sign-in is the AWS CLI's job.
    assert.ok(!("login" in commands));
    assert.ok(!("credential-process" in commands));
  });
});
