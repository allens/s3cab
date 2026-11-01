// The command reference: one page per command at /commands/<name>, its index
// at /commands/, and the sidebar that groups them. All of it is built from the
// registry with help.mjs's own helpers — the same source and the same spelling
// as `--help` — at build time, so nothing is committed that could go stale. The
// README's command tables come from here too, held in step by
// command-pages.test.mjs. Why the pages live outside guide/, and what moving
// one takes: ADR-0114.
//
// Every page sits inside `::: v-pre` (`vPre`), so Vue never reads help text as
// a template (`{{ … }}`); cell text is escaped by `cell` below, since VitePress
// reads `<bucket>` in plain markdown as an HTML tag that is never closed.

import { readFileSync } from "node:fs";
import { commands } from "../../src/commands.mjs";
import {
  argRows,
  commandGroups,
  globalOptionRows,
  optionRows,
  synopsis,
} from "../../src/help.mjs";

/** @import { Command } from "../../src/commands.mjs" */
/** @import { DefaultTheme } from "vitepress" */

/**
 * Plain text made safe in a markdown table cell: the punctuation markdown
 * would read as markup, `|` and `<` backslash-escaped.
 * @param {string} text
 */
const cell = (text) => text.replace(/[\\`*_[\]<>|]/g, "\\$&");

/** @param {string} text */
const code = (text) => "```text\n" + text + "\n```";

/** @param {string[]} blocks */
const vPre = (blocks) => ["::: v-pre", ...blocks, ":::"].join("\n\n") + "\n";

/**
 * A two-column table, the first column padded to its widest cell as the
 * README's hand-kept tables were.
 * @param {[string, string]} header
 * @param {[string, string][]} rows
 */
function table([first, second], rows) {
  const width = Math.max(first.length, ...rows.map(([left]) => left.length));
  return [
    [first, second],
    ["-".repeat(width), "-".repeat(second.length)],
  ]
    .concat(rows)
    .map(([left = "", right = ""]) => `| ${left.padEnd(width)} | ${right} |`)
    .join("\n");
}

/**
 * `--help`'s `[display, description]` rows as table rows.
 * @param {[string, string][]} rows
 * @returns {[string, string][]}
 */
const helpRows = (rows) =>
  rows.map(([display, description]) => [`\`${display}\``, cell(description)]);

/**
 * One group's commands as a table: each linked to its page, with its summary
 * and a link to its guide where it has one.
 * @param {[string, Command][]} entries
 * @param {{ readme?: boolean }} [where] - For the README, which is also read on
 *   GitHub and npm and in the tarball: a command links to the site by its full
 *   address, a guide to the `guide/` file beside it
 */
export const commandTable = (entries, { readme = false } = {}) =>
  table(
    ["Command", "What it does"],
    entries.map(([name, { summary, guide }]) => [
      `[\`s3cab ${name}\`](${readme ? "https://s3cab.plantegral.com" : ""}/commands/${name})`,
      cell(summary) +
        (guide
          ? ` ([guide](${readme ? `guide/${guide}.md` : `/guide/${guide}`}))`
          : ""),
    ]),
  );

/**
 * The title of the guide page a command links to: the `# ` heading every
 * guide opens with.
 * @param {string} topic
 */
function guideTitle(topic) {
  const page = readFileSync(
    new URL(`../../guide/${topic}.md`, import.meta.url),
    "utf8",
  );
  return /^# (.+)/.exec(page)?.[1] ?? topic;
}

/**
 * A command's page: what its `--help` shows, in the same order.
 * @param {string} name
 * @param {Command} command
 */
export function commandPage(name, command) {
  const { summary, examples, details, guide } = command;
  const blocks = [
    `# s3cab ${name}`,
    cell(summary),
    code(synopsis(name, command)),
  ];
  if (examples?.length) {
    blocks.push("## Examples", code(examples.join("\n")));
  }
  const args = argRows(command);
  if (args.length) {
    blocks.push(
      "## Arguments",
      table(["Argument", "Description"], helpRows(args)),
    );
  }
  blocks.push(
    "## Options",
    table(["Option", "Description"], helpRows(optionRows(command))),
  );
  if (details) {
    blocks.push("## Description", code(details));
  }
  if (guide) {
    blocks.push(`Full guide: [${guideTitle(guide)}](/guide/${guide})`);
  }
  return vPre(blocks);
}

/** The reference's index: every command by group, then the global options. */
export function commandIndex() {
  const blocks = [
    "# Command reference",
    "Every command takes the same shape, `s3cab <command> [options] [args]`. " +
      "These pages are built from the same source as `s3cab --help`, so the two always agree.",
  ];
  for (const { group, entries } of commandGroups(commands)) {
    blocks.push(`## ${group}`, commandTable(entries));
  }
  blocks.push(
    "## Global options",
    "These work on every command, and on `s3cab` itself:",
    table(["Option", "Description"], helpRows(globalOptionRows)),
  );
  return vPre(blocks);
}

/**
 * The sidebar for /commands/: the commands under the groups `s3cab --help`
 * shows them in.
 * @returns {DefaultTheme.SidebarItem[]}
 */
export const commandSidebar = () => [
  {
    text: "Command reference",
    items: [{ text: "All commands", link: "/commands/" }],
  },
  ...commandGroups(commands).map(({ group, entries }) => ({
    text: group,
    items: entries.map(([name]) => ({ text: name, link: `/commands/${name}` })),
  })),
];
