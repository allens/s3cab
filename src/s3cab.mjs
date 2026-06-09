#!/usr/bin/env node

import pkg from "../package.json" with { type: "json" };

import { formatByteValue, secondsSince } from "./lib/format.mjs";

import { parseArgs } from "node:util";
import { commands } from "./commands.mjs";
import { ParseArgsError } from "./lib/error.mjs";

// Help topics shown by `s3cab help <topic>` — conceptual docs that aren't tied to
// one command. Kept as plain strings here (not imported from `auth.mjs`) so the
// entry point doesn't eagerly pull the AWS SDK in for every invocation. The auth
// text mirrors the resolution order implemented in `src/lib/auth.mjs` (specs/auth.md).
/** @type {Record<string, string>} */
const helpTopics = {
  auth: `Authentication

s3cab resolves credentials in this order:

1. If a .env file is present, s3cab loads it first.
   This allows AWS_* environment variables to be used intentionally.

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
  - .env / AWS_* environment variables
  - s3cab login

Notes:
  - s3cab does not modify ~/.aws/config or ~/.aws/credentials.
  - .env is supported for compatibility, including some S3-compatible providers.
  - For AWS, temporary credentials from login/profile-based setups are preferred.`,
};

const start = Temporal.Now.instant();
const debug = Boolean(process.env.S3CAB_DEBUG);

const [execPath, jsPath, commandName, ...args] = process.argv;

// Global --version, handled before command dispatch. pkg.version is the single
// source of truth (package.json); esbuild inlines this JSON into the SEA bundle,
// so the native binary reports the same version as the npm/source CLI.
if (commandName === "--version" || commandName === "-v") {
  console.log(pkg.version);
  process.exit(0);
}

// Top-level help: no command given, or an explicit help request. `help <topic>`
// (e.g. `help auth`) prints that topic; otherwise the command list.
if (
  !commandName ||
  commandName === "help" ||
  commandName === "--help" ||
  commandName === "-h"
) {
  console.log(helpTopics[args[0] ?? ""] ?? usage());
  process.exit(0);
}

const command = commands[commandName];

if (!command) {
  console.error(`Unknown command: ${commandName}\n`);
  console.error(usage());
  process.exit(127);
}

// Per-command help: `s3cab <command> --help`.
if (args.includes("--help") || args.includes("-h")) {
  console.log(usage(commandName));
  process.exit(0);
}

try {
  const { values: options, positionals } = parseArgs({
    args,
    options: { ...command.options },
    allowPositionals: true,
    allowNegative: true,
  });

  if (debug) {
    console.warn({ execPath, jsPath, commandName, positionals, options });
  }

  const result = await command.exec({ ...options, debug }, positionals);

  // Serialize to stdout as JSON. JSON.stringify never truncates (unlike
  // console.log on a large array/object), and stdout keeps results separate
  // from the progress/warnings on stderr (see Stream discipline).
  if (result !== undefined) {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  }
} catch (error) {
  console.error("ERROR:", debug ? error : /** @type {Error} */ (error).message);
  console.error();
  if (error instanceof ParseArgsError) {
    console.error(usage(commandName));
  } else if (
    /** @type {NodeJS.ErrnoException} */ (error).code ===
    "ERR_PARSE_ARGS_UNKNOWN_OPTION"
  ) {
    console.error(usage(commandName));
  }
  process.exitCode = 1;
} finally {
  if (debug) {
    console.warn(
      "Memory usage:",
      formatByteValue(process.memoryUsage().heapUsed),
    );
    console.warn("Runtime:", secondsSince(start));
  }
}

/**
 * Build help text. With no (or an unrecognized) `commandName`, returns the
 * top-level command list; otherwise returns that command's args/options. The
 * caller prints it — `console.log` (stdout) for an explicit help request,
 * `console.error` (stderr) when shown as part of an error.
 * @param {string} [commandName] - Command to describe; omit for top-level help
 * @returns {string}
 */
function usage(commandName) {
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

// process.on("SIGINT", () => {
//   console.error("Caught interrupt signal (Ctrl+C)");
//   process.exit(130); // Exit with code 130 to indicate termination by Ctrl+C
// });
