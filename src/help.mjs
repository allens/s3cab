// Help rendering for the CLI shell: the `s3cab help <topic>` topics, the
// `usage()` generator that turns the command registry into help text, and
// `errorMessage()`, which spells a usage error from that same registry. Lives at
// the src/ root beside the entry point and registry (not in lib/) because it is
// bespoke CLI-shell glue tied to the registry shape, not a reusable primitive.
//
// The lib/error.mjs import is safe against the no-SDK rule below: error.mjs
// imports nothing at all.

import {
  MissingArgError,
  ParseArgsError,
  errorText,
  isUsageError,
  missingArg,
} from "./lib/error.mjs";

/** @import { CommandArg, CommandOption, Command } from "./commands.mjs" */

// Help topics shown by `s3cab help <topic>` — cross-cutting guides with no
// command to host them (command-specific depth lives in that command's registry
// `details` instead, e.g. `aws`). A topic must never share a command's name
// — `help <name>` checks topics first, and the disjointness is test-enforced
// (help.test.mjs). Kept as plain strings — this module deliberately imports no
// command/auth code, so rendering help never *requires* the AWS SDK. (Today the
// entry point still loads the SDK on every invocation anyway, via the static
// command registry; making dispatch lazy is deliberately deferred — see
// proposals/performance.md.) The exclude text mirrors the matcher in
// `src/lib/exclude.mjs` (guide/exclude.md). The former auth topic lives on as
// the `provider` command's registry details (ADR-0041, name per ADR-0047) —
// `help provider` reaches it via the `help <command>` routing.
//
// Placement doctrine (see CLAUDE.md → Documentation discipline): a topic earns
// its place here only if a user needs it mid-task in a terminal; each topic
// ends with a link to the fuller online guide. The links are frozen into every
// shipped binary, so they are always https://s3cab.plantegral.com/guide/<topic>
// (CLAUDE.md → Coding conventions).
/** @type {Record<string, string>} */
export const helpTopics = {
  exclude: `Excluding files

Files and directories to skip are listed in a backup set's exclude file,
~/.s3cab/sets/<set>/exclude.txt, one glob pattern per line. Lines
starting with # are comments and blank lines are ignored.

Patterns match each file or directory's path relative to each of the set's
member directories. Write / between directories; on Windows \\ works too.

  *    one or more characters, within a single name
  **/  zero or more whole directories, at the start or after a /
  **   anything at all, across directories
  ?    exactly one character

A pattern ending in / matches a directory and everything inside it, or a link
to a directory.
Case doesn't matter on Windows or macOS, and does on Linux.

Examples:
  **/node_modules/   every node_modules directory, wherever it appears
  build/             the top-level build directory only
  Tests/**/*.js      .js files anywhere under Tests
  **/log.txt         a file named log.txt in any directory
  logs/**            everything under the top-level logs directory

To see what your patterns are actually leaving out, and which pattern
left each one out, run:

  s3cab tree --excluded

Full guide: https://s3cab.plantegral.com/guide/exclude`,
};

/**
 * The display form of a positional argument, built from its metadata rather than
 * parsed out of a decorated key: required → `<name>`, optional → `[<name>]`,
 * variadic → a trailing `...`. The registry stores the parts (ADR-0038); this
 * renders them, so args and options share one plain-keyed shape.
 * @param {string} name
 * @param {CommandArg} arg
 * @returns {string}
 */
const displayArg = (name, { required, variadic }) => {
  const core = `<${name}>${variadic ? "..." : ""}`;
  return required ? core : `[${core}]`;
};

/**
 * The display form of an option — both spellings when it has a short form
 * (`-b, --bucket`), the long one alone otherwise. Shared by the `--help` options
 * table and the missing-argument error line (ADR-0038), so a flag is spelled the
 * same wherever the user meets it.
 * @param {string} name
 * @param {CommandOption} option
 * @returns {string}
 */
const displayOption = (name, { short }) =>
  short ? `-${short}, --${name}` : `--${name}`;

/**
 * A command's Arguments table as `[display, description]` rows. Shared by
 * `--help` and the docs site's command pages, so both spell an argument alike.
 * @param {Command} command
 * @returns {[string, string][]}
 */
export const argRows = ({ args }) =>
  Object.entries(args ?? {}).map(([name, arg]) => [
    displayArg(name, arg),
    arg.description,
  ]);

/**
 * A command's Options table as `[display, description]` rows, ending with the
 * `-h, --help` every command answers. Shared like `argRows`.
 * @param {Command} command
 * @returns {[string, string][]}
 */
export const optionRows = ({ options }) => [
  ...Object.entries(options ?? {}).map(
    ([name, option]) =>
      /** @type {[string, string]} */ ([
        displayOption(name, option),
        option.description ?? "",
      ]),
  ),
  ["-h, --help", "Show this help"],
];

/**
 * The flags the dispatcher answers for every command (and at the top level), as
 * `[display, description]` rows: the top-level `--help`'s own section rather
 * than buried in prose, and the docs site's command index. `--json` (ADR-0043)
 * turns any command's result into machine-readable JSON.
 * @type {[string, string][]}
 */
export const globalOptionRows = [
  ["--json", "Print machine-readable JSON instead of text (shape may change)"],
  ["-v, --version", "Print the version and exit"],
  ["-h, --help", "Show this help; 's3cab <command> --help' for a command"],
];

/**
 * The registry's commands under their `group` headings, in registry order (the
 * display order: day-to-day groups first, plumbing last). A group sticks until
 * the next command that sets one, so the registry only labels the first command
 * of each section; a registry with no groups at all is one "Commands" group.
 * Shared by the top-level `--help`, the docs site's sidebar and the README's
 * command tables.
 * @param {Record<string, Command>} commands
 * @returns {{ group: string, entries: [string, Command][] }[]}
 */
export function commandGroups(commands) {
  /** @type {{ group: string, entries: [string, Command][] }[]} */
  const groups = [];
  for (const entry of Object.entries(commands)) {
    const last = groups.at(-1);
    const group = entry[1].group ?? last?.group ?? "Commands";
    if (last && group === last.group) {
      last.entries.push(entry);
    } else {
      groups.push({ group, entries: [entry] });
    }
  }
  return groups;
}

/**
 * The one-line command shape — `Usage: s3cab setup [options] <directory>...`.
 * Every command accepts `[options]` (the dispatcher answers -h/--help even for
 * those that declare none). Split out of usage() so a usage *error* prints just
 * this line plus a --help pointer, while --help prints the full arg/option tables
 * (ADR-0038).
 * @param {string} commandName
 * @param {Command} command
 * @returns {string}
 */
export function synopsis(commandName, { args }) {
  const positionals = args
    ? Object.entries(args).map(([name, arg]) => displayArg(name, arg))
    : [];
  const tail = positionals.length ? " " + positionals.join(" ") : "";
  return `Usage: s3cab ${commandName} [options]${tail}`;
}

/**
 * How a missing argument is spelled back to the user, looked up by its plain name
 * across the command's positional args and its options — the same exact-match walk
 * `argDescription` does. A positional renders bare (`<snapshot>`): the error is
 * *about* its absence, so `displayArg`'s optional/variadic decoration
 * (`[<snapshot>...]`) would contradict the sentence. An option renders both its
 * spellings (`-b, --bucket`), which is the whole point of sourcing this from the
 * registry — the short form is otherwise discoverable only via `--help`.
 * Undefined when the name isn't in the registry, leaving the error's own message
 * to stand (ADR-0038). Internal to `errorMessage`, its only caller.
 * @param {Command} command
 * @param {string} argName
 * @returns {string | undefined}
 */
function argDisplay(command, argName) {
  if (command.args?.[argName]) {
    return `<${argName}>`;
  }
  const option = command.options?.[argName];
  return option ? displayOption(argName, option) : undefined;
}

/**
 * The registry description for a missing argument, matched by its plain name
 * across the command's positional args and its options — an exact hit in
 * whichever map holds it, no string-stripping (both are keyed by plain name).
 * Undefined when the name isn't found. Glosses a missing-arg error inline
 * (ADR-0038). Internal to `errorMessage`, its only caller.
 * @param {Command} command
 * @param {string} argName
 * @returns {string | undefined}
 */
function argDescription(command, argName) {
  return (
    command.args?.[argName]?.description ??
    command.options?.[argName]?.description
  );
}

/**
 * The text the dispatcher prints after `ERROR:`. A missing-argument error is
 * re-spelled from the registry — the arg's display form plus its description
 * (`-b, --bucket — The S3 bucket to back this set up to`) — which is how a flag's
 * short form reaches the error line at all; the throw site knows only the plain
 * name. Every other error, including the usage errors that name no single arg
 * (our flag conflicts, Node's own parse failures), prints its own message
 * unchanged — via `errorText`, so an error carrying no message at all still
 * prints something. ADR-0038.
 *
 * **Naming an arg buys a gloss, not a rewrite.** Only a `MissingArgError` is
 * re-spelled; any other `ParseArgsError` that sets `argName` keeps its own
 * wording and merely gains the description — `aws`'s `--save needs --from-stack`
 * names the arg for context, and rewriting it to "Missing required argument:
 * --from-stack" would lose the very thing that makes it useful. A name the
 * registry doesn't hold also falls through to the error's message rather than
 * inventing a spelling; that only happens if a throw site and the registry
 * disagree, which is a bug, not a user error.
 * @param {Command} command
 * @param {unknown} error
 * @returns {string}
 */
export function errorMessage(command, error) {
  const message = errorText(error);
  const argName = error instanceof ParseArgsError ? error.argName : undefined;
  if (!argName) {
    return message;
  }
  const display =
    error instanceof MissingArgError ? argDisplay(command, argName) : undefined;
  const line = display ? missingArg(display) : message;
  const description = argDescription(command, argName);
  return description ? `${line} — ${description}` : line;
}

/**
 * Everything the CLI prints for an error a command threw: `ERROR:` and its
 * message, then, for a structural usage error, the one-line synopsis and a
 * `--help` pointer rather than the full arg/option tables (ADR-0038). The
 * guides' error transcripts are checked against this, so the dispatcher must
 * print it, never a copy (test/doc-examples.test.mjs).
 * @param {string} commandName
 * @param {Command} command
 * @param {unknown} error
 * @param {string} [detail] - The message to print in place of `errorMessage`'s
 *   (the dispatcher's debug mode passes the whole error, stack and all)
 * @returns {string}
 */
export function errorReport(
  commandName,
  command,
  error,
  detail = errorMessage(command, error),
) {
  const lines = [`ERROR: ${detail}`];
  if (isUsageError(error)) {
    lines.push(
      "",
      synopsis(commandName, command),
      `Run 's3cab ${commandName} --help' for details.`,
    );
  }
  return lines.join("\n");
}

/**
 * Build help text from the command registry. With no (or an unrecognized)
 * `commandName`, returns the top-level command list; otherwise returns that
 * command's args/options. The registry is passed in (rather than imported) so
 * this stays a pure function — decoupled from the dispatcher and unit-testable
 * without firing the CLI. The caller prints it — `console.log` (stdout) for an
 * explicit help request, `console.error` (stderr) when shown as part of an error.
 * @param {Record<string, Command>} commands - The command registry
 * @param {string} [commandName] - Command to describe; omit for top-level help
 * @param {{ heading?: (text: string) => string }} [style] - Section-heading
 *   decorator (e.g. lib/style.mjs `bold`); omitted → plain text. The caller
 *   decides per the target stream (`styleEnabled`), since usage() returns a
 *   string without knowing where it will be printed.
 * @returns {string}
 */
export function usage(commands, commandName, style) {
  const heading = style?.heading ?? ((/** @type {string} */ text) => text);
  const command = commandName ? commands[commandName] : undefined;
  const lines = [];

  if (command && commandName) {
    const { args, summary, details, guide, examples } = command;

    lines.push(synopsis(commandName, command), "");

    if (summary) {
      lines.push(summary, "");
    }

    // Examples lead (right after the one-line summary, before the arg/option
    // tables) — users reach for examples over reference tables (clig.dev).
    if (examples?.length) {
      lines.push(heading("Examples:"));
      for (const example of examples) {
        lines.push(`  ${example}`);
      }
      lines.push("");
    }

    if (args) {
      lines.push(heading("Arguments:"));
      for (const [display, description] of argRows(command)) {
        lines.push(`  ${display}`.padEnd(24) + description);
      }
      lines.push("");
    }

    lines.push(heading("Options:"));
    for (const [display, description] of optionRows(command)) {
      lines.push(`  ${display}`.padEnd(24) + description);
    }
    lines.push("");

    if (details) {
      lines.push(heading("Description:"), details, "");
    }

    // Last, where the eye lands after the reference tables: the way out to the
    // sit-down read, for a command whose detail outgrows a terminal.
    if (guide) {
      lines.push(`Full guide: https://s3cab.plantegral.com/guide/${guide}`, "");
    }
  } else {
    // Align summaries past the widest command name (+ 2-space indent + gutter).
    const nameColumn =
      Math.max(...Object.keys(commands).map((name) => name.length)) + 4;
    lines.push(
      "s3cab — S3 Content Addressable Backup",
      "",
      "A backup set is a named group of directories you keep safe in the cloud.",
      "",
      "Usage: s3cab <command> [options] [args]",
    );

    for (const { group, entries } of commandGroups(commands)) {
      lines.push("", heading(`${group}:`));
      for (const [name, command] of entries) {
        lines.push(`  ${name}`.padEnd(nameColumn) + command.summary);
      }
    }

    lines.push("", heading("Global options:"));
    for (const [display, description] of globalOptionRows) {
      lines.push(`  ${display}`.padEnd(24) + description);
    }
    lines.push(
      "",
      `Run 's3cab help <topic>' for a guide (topics: ${Object.keys(helpTopics).join(", ")}).`,
      "Set the S3CAB_DEBUG environment variable for verbose debug output.",
      "",
      "Full documentation: https://s3cab.plantegral.com",
    );
  }

  return lines.join("\n");
}
