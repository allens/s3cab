// Help rendering for the CLI shell: the `s3cab help <topic>` topics and the
// `usage()` generator that turns the command registry into help text. Lives at
// the src/ root beside the entry point and registry (not in lib/) because it is
// bespoke CLI-shell glue tied to the registry shape, not a reusable primitive.

/** @import { CommandArg, Command } from "./commands.mjs" */

// Help topics shown by `s3cab help <topic>` — cross-cutting guides with no
// command to host them (command-specific depth lives in that command's registry
// `description` instead, e.g. `aws`). A topic must never share a command's name
// — `help <name>` checks topics first, and the disjointness is test-enforced
// (help.test.mjs). Kept as plain strings — this module deliberately imports no
// command/auth code, so rendering help never *requires* the AWS SDK. (Today the
// entry point still loads the SDK on every invocation anyway, via the static
// command registry; making dispatch lazy is deliberately deferred — see
// proposals/performance.md.) The exclude text mirrors the matcher in
// `src/commands/tree.mjs` (guide/exclude.md). The former auth topic lives on as
// the `provider` command's registry description (ADR-0041, name per ADR-0047) —
// `help provider` reaches it via the `help <command>` routing.
//
// Placement doctrine (see CLAUDE.md → Documentation discipline): a topic earns
// its place here only if a user needs it mid-task in a terminal; each topic
// ends with a link to the fuller online guide. The links are frozen into every
// shipped binary — pre-release GitHub URLs are fine, but settle stable doc
// URLs before release.
/** @type {Record<string, string>} */
export const helpTopics = {
  exclude: `Excluding files

Files and directories to skip are listed in a backup set's exclude file,
~/.s3cab/sets/<set>/exclude.txt, one glob pattern per line. Lines
starting with # are comments and blank lines are ignored.

Patterns match each file or directory's path relative to each of the set's
member directories. Write / between directories; on Windows \\ works too.

  *    one or more characters, within a single name
  **/  zero or more whole directories
  ?    exactly one character

A pattern ending in / matches a directory and everything inside it.
Matching is case-insensitive on Windows, case-sensitive elsewhere.

Examples:
  **/node_modules/   every node_modules directory, wherever it appears
  build/             the top-level build directory only
  Tests/**/*.js      .js files anywhere under Tests
  **/log.txt         a file named log.txt in any directory

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
 * The one-line command shape — `Usage: s3cab setup [options] <directory>...`.
 * Every command accepts `[options]` (the dispatcher answers -h/--help even for
 * those that declare none). Split out of usage() so a usage *error* prints just
 * this line plus a --help pointer, while --help prints the full arg/option tables
 * (ADR-0038).
 * @param {Record<string, Command>} commands
 * @param {string} commandName
 * @returns {string}
 */
export function synopsis(commands, commandName) {
  const args = commands[commandName]?.args;
  const positionals = args
    ? Object.entries(args).map(([name, arg]) => displayArg(name, arg))
    : [];
  const tail = positionals.length ? " " + positionals.join(" ") : "";
  return `Usage: s3cab ${commandName} [options]${tail}`;
}

/**
 * The registry description for a missing argument, matched by its plain name
 * across the command's positional args and its options — an exact hit in
 * whichever map holds it, no string-stripping (both are keyed by plain name).
 * Undefined when there is no argName (Node's own parse errors carry none) or the
 * name isn't found. Glosses a missing-arg error inline (ADR-0038).
 * @param {Command} command
 * @param {string} [argName]
 * @returns {string | undefined}
 */
export function argDescription(command, argName) {
  if (!argName) {
    return undefined;
  }
  return (
    command.args?.[argName]?.description ??
    command.options?.[argName]?.description
  );
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
    const { args, options, summary, description, examples } = command;

    lines.push(synopsis(commands, commandName), "");

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
      for (const [name, arg] of Object.entries(args)) {
        lines.push(`  ${displayArg(name, arg)}`.padEnd(24) + arg.description);
      }
      lines.push("");
    }

    lines.push(heading("Options:"));
    for (const [name, { short, description = "" }] of Object.entries(
      options ?? {},
    )) {
      const flags = short ? `-${short}, --${name}` : `--${name}`;
      lines.push(`  ${flags}`.padEnd(24) + description);
    }
    lines.push(`  -h, --help`.padEnd(24) + "Show this help", "");

    if (description) {
      lines.push(heading("Description:"), description, "");
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

    // Commands render under their registry `group` heading (day-to-day groups
    // first, plumbing last — the registry's insertion order is the display
    // order). A group sticks until the next command that sets one, so the
    // registry only labels the first command of each section; a registry with
    // no groups at all renders one flat "Commands" list.
    /** @type {string | undefined} */
    let group;
    for (const [name, command] of Object.entries(commands)) {
      const section = command.group ?? group ?? "Commands";
      if (section !== group) {
        lines.push("", heading(`${section}:`));
        group = section;
      }
      lines.push(
        `  ${name}`.padEnd(nameColumn) +
          command.summary +
          (command.planned ? " (not yet available)" : ""),
      );
    }

    // Global options — the flags the dispatcher answers for every command (and
    // at the top level), so they get their own section rather than being buried
    // in prose. Padded to 24 like the per-command Options table. `--json`
    // (ADR-0043) turns any command's result into machine-readable JSON.
    lines.push(
      "",
      heading("Global options:"),
      "  --json".padEnd(24) +
        "Print machine-readable JSON instead of text (shape may change)",
      "  -v, --version".padEnd(24) + "Print the version and exit",
      "  -h, --help".padEnd(24) +
        "Show this help; 's3cab <command> --help' for a command",
      "",
      `Run 's3cab help <topic>' for a guide (topics: ${Object.keys(helpTopics).join(", ")}).`,
      "Set the S3CAB_DEBUG environment variable for verbose debug output.",
      "",
      "Full documentation: https://s3cab.plantegral.com",
    );
  }

  return lines.join("\n");
}
