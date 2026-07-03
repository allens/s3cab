#!/usr/bin/env node

import pkg from "../package.json" with { type: "json" };

import { parseArgs } from "node:util";

import { commands } from "./commands.mjs";
import { argDescription, helpTopics, synopsis, usage } from "./help.mjs";
import { loadEnv } from "./lib/env.mjs";
import { isInputError, isUsageError } from "./lib/error.mjs";
import { formatByteValue, secondsSince } from "./lib/format.mjs";

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
// (e.g. `help auth`) prints that topic; `help <command>` prints that command's
// help (usage() falls back to the command list for anything unrecognized).
// Topic and command names are disjoint by convention (test-enforced in
// help.test.mjs), so the topics-first lookup order can never shadow a command.
if (
  !commandName ||
  commandName === "help" ||
  commandName === "--help" ||
  commandName === "-h"
) {
  console.log(helpTopics[args[0] ?? ""] ?? usage(commands, args[0]));
  process.exit(0);
}

const command = commands[commandName];

if (!command) {
  console.error(`Unknown command: ${commandName}\n`);
  console.error(usage(commands));
  process.exit(127);
}

// Per-command help: `s3cab <command> --help`.
if (args.includes("--help") || args.includes("-h")) {
  console.log(usage(commands, commandName));
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

  // Apply the user env layer once, up front, so it is always already in
  // process.env before any command runs (ADR-0022). Set-accepting commands add
  // their set layer on top via `loadSet`. Inside the try so a malformed env file
  // surfaces through the error handler below.
  loadEnv();

  const result = await command.exec({ ...options, debug }, positionals);

  // Serialize to stdout as JSON. JSON.stringify never truncates (unlike
  // console.log on a large array/object), and stdout keeps results separate
  // from the progress/warnings on stderr (see Stream discipline).
  if (result !== undefined) {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  }
} catch (error) {
  // Two independent axes (see lib/error.mjs): print the usage help only for a
  // structural usage error, and pick the exit code by input-vs-runtime. Exit-code
  // convention: 2 for bad input (args/options/values — the argparse/getopt
  // convention), 1 for any other runtime failure. (Success is 0; an unknown
  // command exits 127 above, the shell's "command not found".)
  const usageErr = isUsageError(error);
  const message = Error.isError(error) ? error.message : String(error);
  // Gloss a missing-arg usage error with the arg's registry description. Usage
  // errors that name no single arg — our flag-conflict / bad-value ParseArgsErrors
  // and Node's own parse failures — carry no argName, so no gloss (ADR-0038).
  const argName = usageErr
    ? /** @type {{ argName?: string }} */ (error).argName
    : undefined;
  const description = argName ? argDescription(command, argName) : undefined;
  console.error(
    "ERROR:",
    debug ? error : description ? `${message} — ${description}` : message,
  );
  // A usage error prints the one-line synopsis + a --help pointer, not the full
  // arg/option tables (those live behind --help) — ADR-0038.
  if (usageErr) {
    console.error();
    console.error(synopsis(commands, commandName));
    console.error(`Run 's3cab ${commandName} --help' for details.`);
  }
  process.exitCode = isInputError(error) ? 2 : 1;
} finally {
  if (debug) {
    console.warn(
      "Memory usage:",
      formatByteValue(process.memoryUsage().heapUsed),
    );
    console.warn("Runtime:", secondsSince(start));
  }
}
