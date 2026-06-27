// Help rendering for the CLI shell: the `s3cab help <topic>` topics and the
// `usage()` generator that turns the command registry into help text. Lives at
// the src/ root beside the entry point and registry (not in lib/) because it is
// bespoke CLI-shell glue tied to the registry shape, not a reusable primitive.

// Help topics shown by `s3cab help <topic>` — conceptual docs that aren't tied
// to one command. Kept as plain strings (this module deliberately imports no
// command/auth code) so the entry point that imports it doesn't transitively
// pull the AWS SDK in for every invocation. The auth text mirrors the
// resolution order implemented in `src/lib/auth.mjs` (docs/specs/auth.md); the
// exclude text mirrors the matcher in `src/commands/tree.mjs` (guide/exclude.md).
//
// Placement doctrine (see CLAUDE.md → Documentation discipline): a topic earns
// its place here only if a user needs it mid-task in a terminal; each topic
// ends with a link to the fuller online guide. The links are frozen into every
// shipped binary — pre-release GitHub URLs are fine, but settle stable doc
// URLs before release.
/** @type {Record<string, string>} */
export const helpTopics = {
  bucket: `Setting up a cloud bucket

's3cab bucket <bucket>' prints the exact steps to stand up an S3 bucket as
a backup destination, plus a locked-down identity for s3cab to use. It only
PRINTS commands — it never touches your account and needs no credentials to
run, so you can read the whole plan first.

It walks you through three things:
  1. the bucket, with versioning ON (your safety net) and lifecycle rules that
     reclaim space from deleted backups after 90 days — never a live backup;
  2. a least-privilege policy: list + read/write/soft-delete on this bucket
     only. The everyday identity can add to and tweak your backup but can NEVER
     permanently destroy its history — versioning is the backstop;
  3. how to point s3cab at the new identity ('s3cab aws --profile <name>').

Choosing an identity:
  (default)  a dedicated AWS IAM user — simplest if you don't use SSO
  --sso      reuse your AWS IAM Identity Center (SSO) sign-in, or set up a
             dedicated permission set (an advanced option is shown too)
  (auto)     a non-AWS S3 provider (Cloudflare R2, Backblaze B2, Wasabi, …) is
             detected from a custom endpoint (AWS_ENDPOINT_URL_S3) and you get
             provider-neutral steps plus a ready-to-paste ~/.s3cab/env template

  s3cab bucket my-backups --region eu-west-1 --profile admin

Then create a backup set in it:
  s3cab setup <name> <folder>... --bucket my-backups

Full guide: https://github.com/allens/s3cab/blob/main/guide/bucket.md`,

  auth: `Authentication

s3cab resolves credentials in this order:

1. s3cab loads its own env files first, if present. These set AWS_*
   variables — a profile, region, endpoint, or keys (set a profile easily
   with 's3cab aws --profile <name>'). Highest precedence first (a file
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
  - Quickest: 's3cab aws --profile <name>' points s3cab at an AWS profile
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

Full guide: https://github.com/allens/s3cab#authentication`,

  exclude: `Excluding files

Files and folders to skip are listed in a backup set's exclude file,
~/.s3cab/sets/<set>/exclude.txt, one glob pattern per line. Lines
starting with # are comments and blank lines are ignored.

Patterns match each file or folder's path relative to each of the set's
member directories. Write / between folders; on Windows \\ works too.

  *    one or more characters, within a single name
  **/  zero or more whole folders
  ?    exactly one character

A pattern ending in / matches a folder and everything inside it.
Matching is case-insensitive on Windows, case-sensitive elsewhere.

Examples:
  **/node_modules/   every node_modules folder, wherever it appears
  build/             the top-level build folder only
  Tests/**/*.js      .js files anywhere under Tests
  **/log.txt         a file named log.txt in any folder

Full guide: https://github.com/allens/s3cab/blob/main/guide/exclude.md`,
};

/**
 * Build help text from the command registry. With no (or an unrecognized)
 * `commandName`, returns the top-level command list; otherwise returns that
 * command's args/options. The registry is passed in (rather than imported) so
 * this stays a pure function — decoupled from the dispatcher and unit-testable
 * without firing the CLI. The caller prints it — `console.log` (stdout) for an
 * explicit help request, `console.error` (stderr) when shown as part of an error.
 * @param {Record<string, import("./commands.mjs").Command>} commands - The command registry
 * @param {string} [commandName] - Command to describe; omit for top-level help
 * @returns {string}
 */
export function usage(commands, commandName) {
  const command = commandName ? commands[commandName] : undefined;
  const lines = [];

  if (command) {
    const { args, options, summary, description } = command;

    // Every command accepts [options]: the dispatcher handles -h/--help even
    // for commands that declare none of their own.
    let usageLine = `Usage: s3cab ${commandName} [options]`;
    if (args) {
      usageLine += " " + Object.keys(args).join(" ");
    }
    lines.push(usageLine, "");

    if (summary) {
      lines.push(summary, "");
    }

    if (args) {
      lines.push("Arguments:");
      for (const [name, description = ""] of Object.entries(args)) {
        lines.push(`  ${name}`.padEnd(24) + description);
      }
      lines.push("");
    }

    lines.push("Options:");
    for (const [name, { short, description = "" }] of Object.entries(
      options ?? {},
    )) {
      const flags = short ? `-${short}, --${name}` : `--${name}`;
      lines.push(`  ${flags}`.padEnd(24) + description);
    }
    lines.push(`  -h, --help`.padEnd(24) + "Show this help", "");

    if (description) {
      lines.push("Description:", description, "");
    }
  } else {
    // Align summaries past the widest command name (+ 2-space indent + gutter).
    const nameColumn =
      Math.max(...Object.keys(commands).map((name) => name.length)) + 4;
    lines.push(
      "s3cab — S3 Content Addressable Backup",
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
      const heading = command.group ?? group ?? "Commands";
      if (heading !== group) {
        lines.push("", `${heading}:`);
        group = heading;
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
