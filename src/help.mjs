// Help rendering for the CLI shell: the `s3cab help <topic>` topics and the
// `usage()` generator that turns the command registry into help text. Lives at
// the src/ root beside the entry point and registry (not in lib/) because it is
// bespoke CLI-shell glue tied to the registry shape, not a reusable primitive.

// Help topics shown by `s3cab help <topic>` — cross-cutting guides with no
// command to host them (command-specific depth lives in that command's registry
// `description` instead, e.g. `aws`). A topic must never share a command's name
// — `help <name>` checks topics first, and the disjointness is test-enforced
// (help.test.mjs). Kept as plain strings — this module deliberately imports no
// command/auth code, so rendering help never *requires* the AWS SDK. (Today the
// entry point still loads the SDK on every invocation anyway, via the static
// command registry; making dispatch lazy is deliberately deferred — see
// proposals/performance.md.) The auth text mirrors the
// resolution order implemented in `src/lib/auth.mjs` (docs/design/auth.md); the
// exclude text mirrors the matcher in `src/commands/tree.mjs` (guide/exclude.md).
//
// Placement doctrine (see CLAUDE.md → Documentation discipline): a topic earns
// its place here only if a user needs it mid-task in a terminal; each topic
// ends with a link to the fuller online guide. The links are frozen into every
// shipped binary — pre-release GitHub URLs are fine, but settle stable doc
// URLs before release.
/** @type {Record<string, string>} */
export const helpTopics = {
  auth: `Authentication

s3cab resolves credentials in this order:

1. s3cab loads its own env files first, if present. These set AWS_*
   variables — a profile, region, endpoint, or keys (set a profile easily
   with 's3cab profile --profile <name>'). Highest precedence first (a file
   always beats the shell):
     ~/.s3cab/sets/<set>/env  per-backup-set - the set's bucket + per-set
                              overrides (written by 's3cab setup'; applies as
                              the set-based commands arrive with backup)
     ~/.s3cab/env             per-user defaults - the base layer under the set,
                              where auth lives for the common single-bucket case
   s3cab does NOT read a .env from the current directory.

2. s3cab then uses the standard AWS SDK credential chain.
   This includes existing AWS_PROFILE, shared AWS profiles (including
   SSO sessions from 'aws sso login'), shared credential_process
   profiles, and AWS_* environment variables.

3. If nothing is configured, s3cab stops with an error explaining
   these options.

Supported options:
  - Quickest: 's3cab profile --profile <name>' points s3cab at an AWS profile
    (writes AWS_PROFILE to ~/.s3cab/env; add a set name to scope it to one set)
  - Existing AWS profile / AWS_PROFILE (for AWS IAM Identity Center,
    run 'aws sso login' first — s3cab picks the session up)
  - Existing shared AWS credential_process setup
  - s3cab env files / AWS_* environment variables

Notes:
  - s3cab does not modify ~/.aws/config or ~/.aws/credentials.
  - env files are supported for compatibility, including some S3-compatible providers.
  - For AWS, temporary credentials from profile-based setups are preferred
    over long-lived keys.

When the server rejects your credentials:

s3cab names the cause and shows the raw error. By cause:

  Expired credentials
    - AWS IAM Identity Center (SSO): run 'aws sso login' again
    - temporary credentials (AWS_SESSION_TOKEN): request a fresh set
    - a named profile: renew it (and set AWS_PROFILE)

  Invalid / rejected credentials
    Replace the credentials s3cab is using, by their source:
    - env vars / env file: re-check AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY,
      and AWS_SESSION_TOKEN in ~/.s3cab/env (or ~/.s3cab/sets/<set>/env if
      you scoped them to a set; no stray quotes or spaces)
    - a profile: renew it, and confirm AWS_PROFILE names the right one
    - SSO: run 'aws sso login' again

  Signature mismatch
    Almost always a wrong secret, region, or endpoint:
    - confirm AWS_SECRET_ACCESS_KEY is correct and complete
    - confirm AWS_REGION matches the bucket's region
    - non-AWS providers: confirm the endpoint (AWS_ENDPOINT_URL_S3) matches
      your provider — a wrong endpoint/region is the classic Cloudflare R2 /
      Backblaze B2 trap

  Permission denied (signed in, but not allowed)
    - on AWS, run 's3cab aws <bucket>' for the exact least-privilege policy
    - on another provider, grant the token list + read/write on the bucket

  Clock out of sync
    S3 rejects requests whose time drifts too far. Sync your clock:
    - Windows: Settings > Time & language > Date & time > Sync now
    - macOS:   sudo sntp -sS time.apple.com
    - Linux:   sudo timedatectl set-ntp true

Full guide: https://github.com/allens/s3cab#authentication`,

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

Full guide: https://github.com/allens/s3cab/blob/main/guide/exclude.md`,
};

/**
 * The display form of a positional argument, built from its metadata rather than
 * parsed out of a decorated key: required → `<name>`, optional → `[<name>]`,
 * variadic → a trailing `...`. The registry stores the parts (ADR-0038); this
 * renders them, so args and options share one plain-keyed shape.
 * @param {string} name
 * @param {import("./commands.mjs").CommandArg} arg
 * @returns {string}
 */
const displayArg = (name, { required, variadic }) => {
  const core = `<${name}>${variadic ? "..." : ""}`;
  return required ? core : `[${core}]`;
};

/**
 * The one-line command shape — `Usage: s3cab setup [options] <set> [<directory>...]`.
 * Every command accepts `[options]` (the dispatcher answers -h/--help even for
 * those that declare none). Split out of usage() so a usage *error* prints just
 * this line plus a --help pointer, while --help prints the full arg/option tables
 * (ADR-0038).
 * @param {Record<string, import("./commands.mjs").Command>} commands
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
 * @param {import("./commands.mjs").Command} command
 * @param {string} [argName]
 * @returns {string | undefined}
 */
export function argDescription(command, argName) {
  if (!argName) return undefined;
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
 * @param {Record<string, import("./commands.mjs").Command>} commands - The command registry
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

    lines.push(
      "",
      "Run 's3cab <command> --help' for a command's options.",
      `Run 's3cab help <topic>' for a guide (topics: ${Object.keys(helpTopics).join(", ")}).`,
      "Run 's3cab --version' to print the version.",
      "Set the S3CAB_DEBUG environment variable for verbose debug output.",
      "",
      "Full documentation: https://github.com/allens/s3cab",
    );
  }

  return lines.join("\n");
}
