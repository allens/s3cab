import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { commands } from "../../src/commands.mjs";
import { argRows, commandGroups, optionRows, usage } from "../../src/help.mjs";
import { commandIndex, commandPage, commandTable } from "./command-pages.mjs";

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

  it("each has a row for every argument and option, and links its guide", () => {
    for (const [name, command] of Object.entries(commands)) {
      const page = commandPage(name, command);

      for (const [display] of [...argRows(command), ...optionRows(command)]) {
        assert.ok(page.includes(`| \`${display}\``), `${name}: ${display}`);
      }
      if (command.guide) {
        assert.ok(page.includes(`](/guide/${command.guide})`), name);
      }
    }
  });

  it("escapes the markdown in help text, so `<set>` stays text", () => {
    const page = commandPage("demo", {
      summary: "Copy a <set> | or *not*",
      options: { to: { type: "string", description: "Into a_b|c <dir>" } },
      exec: () => undefined,
      render: () => "",
    });

    assert.ok(page.includes("Copy a \\<set\\> \\| or \\*not\\*"));
    assert.ok(page.includes("| Into a\\_b\\|c \\<dir\\> |"));
  });

  it("the index links every command's page", () => {
    const index = commandIndex();
    for (const name of Object.keys(commands)) {
      assert.ok(index.includes(`(/commands/${name})`), name);
    }
  });
});

describe("README.md's command tables", () => {
  it("are the registry's groups, commands and summaries", () => {
    const readme = readFileSync("README.md", "utf8");
    const reference =
      readme.split("\n## Command reference\n")[1]?.split("\n## ")[0] ?? "";
    for (const { group, entries } of commandGroups(commands)) {
      const expected = commandTable(entries, { readme: true });
      const section = reference.split(`\n### ${group}\n`)[1] ?? "";
      const lines = section.split("\n");
      const first = lines.findIndex((line) => line.startsWith("|"));
      const end = lines.findIndex(
        (line, i) => i > first && !line.startsWith("|"),
      );
      const shown =
        first < 0
          ? ""
          : lines.slice(first, end < 0 ? undefined : end).join("\n");

      assert.equal(
        shown,
        expected,
        `README.md's "### ${group}" table under "## Command reference" is out of step with the registry; it should read:\n\n${expected}\n`,
      );
    }
  });
});
