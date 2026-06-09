#!/usr/bin/env node

import pkg from "../package.json" with { type: "json" };

import { parseArgs } from "node:util";

import { commands } from "./commands.mjs";
import { helpTopics, usage } from "./help.mjs";
import { ParseArgsError } from "./lib/error.mjs";
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
    console.error(usage(commands, commandName));
  } else if (
    /** @type {NodeJS.ErrnoException} */ (error).code ===
    "ERR_PARSE_ARGS_UNKNOWN_OPTION"
  ) {
    console.error(usage(commands, commandName));
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

// process.on("SIGINT", () => {
//   console.error("Caught interrupt signal (Ctrl+C)");
//   process.exit(130); // Exit with code 130 to indicate termination by Ctrl+C
// });
