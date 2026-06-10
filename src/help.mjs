// Help rendering for the CLI shell: the `s3cab help <topic>` topics and the
// `usage()` generator that turns the command registry into help text. Lives at
// the src/ root beside the entry point and registry (not in lib/) because it is
// bespoke CLI-shell glue tied to the registry shape, not a reusable primitive.

// Help topics shown by `s3cab help <topic>` — conceptual docs that aren't tied
// to one command. Kept as plain strings (this module deliberately imports no
// command/auth code) so the entry point that imports it doesn't transitively
// pull the AWS SDK in for every invocation. The auth text mirrors the
// resolution order implemented in `src/lib/auth.mjs` (specs/auth.md).
/** @type {Record<string, string>} */
export const helpTopics = {
  auth: `Authentication

s3cab resolves credentials in this order:

1. s3cab loads its own env files first, if present. These set AWS_*
   variables (a profile, region, endpoint, or keys) and a default
   S3CAB_BUCKET. Highest precedence first (a file always beats the shell):
     <dir>/.s3cab/env       per-backup-folder - NOT yet active (coming with
                            the setup/backup commands)
     ~/.s3cab/env.<bucket>  per-bucket - used by commands that take a bucket
                            (e.g. upload, objects)
     ~/.s3cab/env           per-user defaults - the base layer under the others
   s3cab does NOT read a .env from the current directory.

2. s3cab then uses the standard AWS SDK credential chain.
   This includes existing AWS_PROFILE, shared AWS profiles,
   shared credential_process profiles, and AWS_* environment variables.

3. If no standard AWS credentials are available, s3cab falls back
   to credentials from a prior 's3cab login'.

4. If nothing is configured, run:
     s3cab login

Supported options:
  - Existing AWS profile / AWS_PROFILE
  - Existing shared AWS credential_process setup
  - s3cab env files / AWS_* environment variables
  - s3cab login

Notes:
  - s3cab does not modify ~/.aws/config or ~/.aws/credentials.
  - env files are supported for compatibility, including some S3-compatible providers.
  - For AWS, temporary credentials from login/profile-based setups are preferred.`,
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

    let usageLine = `Usage: s3cab ${commandName} `;
    if (options) {
      usageLine += "[options] ";
    }
    if (args) {
      usageLine += Object.keys(args).join(" ");
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

    if (options) {
      lines.push("Options:");
      for (const [name, { short, description = "" }] of Object.entries(
        options,
      )) {
        const flags = short ? `-${short}, --${name}` : `--${name}`;
        lines.push(`  ${flags}`.padEnd(24) + description);
      }
      lines.push("");
    }

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
      "",
      "Commands:",
      ...Object.entries(commands).map(
        ([name, { summary, planned }]) =>
          `  ${name}`.padEnd(nameColumn) +
          summary +
          (planned ? " (not yet available)" : ""),
      ),
      "",
      "Run 's3cab <command> --help' for a command's options.",
      "Run 's3cab help auth' for how AWS credentials are resolved.",
      "Run 's3cab --version' to print the version.",
    );
  }

  return lines.join("\n");
}
