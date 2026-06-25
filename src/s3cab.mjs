#!/usr/bin/env node

import pkg from "../package.json" with { type: "json" };

import { parseArgs } from "node:util";

import { commands } from "./commands.mjs";
import { helpTopics, usage } from "./help.mjs";
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
// (e.g. `help auth`) prints that topic; otherwise the command list.
if (
  !commandName ||
  commandName === "help" ||
  commandName === "--help" ||
  commandName === "-h"
) {
  console.log(helpTopics[args[0] ?? ""] ?? usage(commands));
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
  console.error(
    "ERROR:",
    debug ? error : Error.isError(error) ? error.message : String(error),
  );
  console.error();
  // Two independent axes (see lib/error.mjs): print the usage block only for a
  // structural usage error, and pick the exit code by input-vs-runtime. Exit-code
  // convention: 2 for bad input (args/options/values — the argparse/getopt
  // convention), 1 for any other runtime failure. (Success is 0; an unknown
  // command exits 127 above, the shell's "command not found".)
  if (isUsageError(error)) {
    console.error(usage(commands, commandName));
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

// TODO: revisit SIGINT handling. This handler was commented out for a reason
// since forgotten — work out whether the CLI needs one (exit 130 on Ctrl+C?)
// or whether default termination is fine, then wire it up or remove it.
// process.on("SIGINT", () => {
//   console.error("Caught interrupt signal (Ctrl+C)");
//   process.exit(130); // Exit with code 130 to indicate termination by Ctrl+C
// });
