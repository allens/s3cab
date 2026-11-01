import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { commands } from "../../src/commands.mjs";
import { commandGroups, usage } from "../../src/help.mjs";
import { commandPage, commandTable } from "./command-pages.mjs";

describe("command pages", () => {
  it("each shows its command's --help usage line and examples", () => {
    for (const [name, command] of Object.entries(commands)) {
      const help = usage(commands, name).split("\n");
      const at = help.indexOf("Examples:");
      const examples =
        at < 0
          ? []
          : help.slice(at + 1, help.indexOf("", at)).map((line) => line.trim());
      const page = commandPage(name, command).split("\n");

      assert.ok(
        page.includes(/** @type {string} */ (help[0])),
        `${name}: ${help[0]}`,
      );
      for (const example of examples) {
        assert.ok(page.includes(example), `${name}: ${example}`);
      }
    }
  });
});

describe("README.md's command tables", () => {
  it("are the registry's groups, commands and summaries", () => {
    const readme = readFileSync("README.md", "utf8");
    for (const { group, entries } of commandGroups(commands)) {
      const expected = commandTable(entries, "https://s3cab.plantegral.com");
      const section =
        readme.split(`\n### ${group}\n`)[1]?.split("\n#")[0] ?? "";

      assert.ok(
        section.includes(expected),
        `README.md's "### ${group}" table is out of step with the registry; it should read:\n\n${expected}\n`,
      );
    }
  });
});
