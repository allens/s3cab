import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { commands } from "../../src/commands.mjs";
import { argRows, commandGroups, optionRows, usage } from "../../src/help.mjs";
import { commandIndex, commandPage, commandTable } from "./command-pages.mjs";

/**
 * The text under a markdown heading, up to the next heading of its level.
 * @param {string} text
 * @param {string} heading - With its `#`s: `## Options`
 */
const under = (text, heading) =>
  text.split(`\n${heading}\n`)[1]?.split(`\n${heading.split(" ")[0]} `)[0] ??
  "";

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

  it("each lists its arguments and options, in their own tables, as --help does", () => {
    for (const [name, command] of Object.entries(commands)) {
      const page = commandPage(name, command);

      for (const [heading, rows] of /** @type {const} */ ([
        ["Arguments", argRows(command)],
        ["Options", optionRows(command)],
      ])) {
        const shown = [
          ...under(page, `## ${heading}`).matchAll(
            /^\| `(.+?)` *\| (.*) \|$/gm,
          ),
        ].map(([, display, text = ""]) => [
          display,
          text.replace(/\\(.)/g, "$1"),
        ]);
        assert.deepEqual(shown, rows, `${name}: ${heading}`);
      }
    }
  });

  it("each links its guide by the guide's own title", () => {
    for (const [name, command] of Object.entries(commands)) {
      if (command.guide) {
        const title = readFileSync(`guide/${command.guide}.md`, "utf8")
          .split("\n")
          .find((line) => line.startsWith("# "))
          ?.slice(2);
        const link = `Full guide: [${title}](/guide/${command.guide})`;
        assert.ok(commandPage(name, command).includes(link), name);
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
    const reference = under(
      readFileSync("README.md", "utf8"),
      "## Command reference",
    );
    const groups = commandGroups(commands);

    assert.deepEqual(
      [...reference.matchAll(/^### (.+)$/gm)].map(([, heading]) => heading),
      [...groups.map(({ group }) => group), "Global options"],
      "the groups under README.md's \"## Command reference\" are the registry's, then Global options",
    );
    for (const { group, entries } of groups) {
      const expected = commandTable(entries, { readme: true });
      const shown =
        /^\|.*(?:\n\|.*)*/m.exec(under(reference, `### ${group}`))?.[0] ?? "";

      assert.equal(
        shown,
        expected,
        `README.md's "### ${group}" table under "## Command reference" is out of step with the registry; it should read:\n\n${expected}\n`,
      );
    }
  });
});
