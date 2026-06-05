#!/usr/bin/env node

import pkg from "../package.json" with { type: "json" };

import { formatByteValue, secondsSince } from "./format.mjs";

import { ParseArgsError } from "./error.mjs";
import { compare } from "./commands/compare.mjs";
import { list } from "./commands/list.mjs";
import { parseArgs } from "node:util";
import { prop } from "./commands/prop.mjs";
import { snapshot } from "./commands/snapshot.mjs";
import { tree } from "./commands/tree.mjs";

/** @typedef {import('node:util').ParseArgsOptionDescriptor & { description?: string }} CommandOption */
/** @typedef {ReturnType<typeof import('node:util').parseArgs>["values"]} ParsedOptions */

/**
 * @typedef {Object} Command
 * @property {Record<string, string>} [args]
 * @property {Record<string, CommandOption>} [options]
 * @property {(options: ParsedOptions, positionals?: string[]) => Promise<string[] | object>} exec
 * @property {string} summary
 * @property {string} [description]
 */

/** @type {Record<string, Command>} */
export const commands = {
  tree: {
    summary: "List files in a directory",
    args: { "<dir>": "Directory to list files from" },
    options: {},
    exec: async (options, [dir] = []) => tree(dir),
  },
  snapshot: {
    summary: "Take a snapshot of a directory",
    args: { "<dir>": "Directory to take a snapshot of" },
    options: {
      noLookup: {
        type: "boolean",
        short: "n",
        description: "Do not lookup previous snapshot for unchanged files",
      },
    },
    exec: (options, [dir] = []) => snapshot(dir, options),
  },
  prop: {
    summary: "Show properties of a file",
    args: { "<file>": "File to show properties of" },
    options: {
      lookup: {
        type: "string",
        short: "l",
        description: "Path to snapshot file to lookup properties from",
      },
    },
    exec: (options, [file] = []) => prop(file, options),
  },
  compare: {
    summary: "Show differences between two snapshots",
    args: {
      directory: "Directory containing the snapshots to compare",
      current: "Current snapshot name",
      previous: "Previous snapshot name",
    },
    exec: (options, [dir, current, previous] = []) =>
      compare(dir, current, previous),
  },
  list: {
    summary: "List snapshots in a directory",
    args: { "<dir>": "Directory to list snapshots from" },
    options: {
      latest: {
        type: "boolean",
        short: "l",
        description: "Return only the latest snapshot file",
      },
    },
    exec: async (options, [dir] = []) => list(dir, options),
  },
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

const command = commands[commandName];

if (!command) {
  if (commandName) {
    console.error(`Unknown command: ${commandName}`);
  }
  console.error(`Usage 's3cab <command> [options] [args...]'`);
  console.error(`Available commands: ${Object.keys(commands).join(", ")}`);
  process.exit(127);
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

  console.log(result);
} catch (error) {
  console.error("ERROR:", error);
  console.error();
  if (error instanceof ParseArgsError) {
    usage(commandName, command);
  } else if (
    /** @type {NodeJS.ErrnoException} */ (error).code ===
    "ERR_PARSE_ARGS_UNKNOWN_OPTION"
  ) {
    usage(commandName, command);
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
 * Display usage information for a command.
 * @param {string} commandName - Command name
 * @param {Command} command - Command definition
 */
function usage(commandName, command) {
  const { args, options, summary, description } = command;

  let usage = `Usage: s3cab ${commandName} `;
  if (options) usage += "[options] ";
  if (args) usage += Object.keys(args).join(" ");
  console.error(usage);
  console.error();

  if (summary) {
    console.error(summary);
    console.error();
  }

  if (args) {
    console.error("Arguments:");
    for (const [name, description = ""] of Object.entries(args)) {
      console.error(`  ${name}`.padEnd(24) + description);
    }
    console.error();
  }

  if (options) {
    console.error("Options:");
    for (const [name, { short, description = "" }] of Object.entries(options)) {
      console.error(`  -${short}, --${name}`.padEnd(24) + description);
    }
    console.error();
  }

  if (description) {
    console.error("Description:");
    console.error(description);
    console.error();
  }
}

// process.on("SIGINT", () => {
//   console.error("Caught interrupt signal (Ctrl+C)");
//   process.exit(130); // Exit with code 130 to indicate termination by Ctrl+C
// });
