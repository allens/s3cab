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
 * @property {(options: ParsedOptions, positionals?: string[]) => Promise<string | string[] | object | undefined>} exec
 * @property {string} summary
 * @property {string} [description]
 * @property {boolean} [planned] - Scaffolded but not yet implemented (awaiting the S3 milestone)
 */

/**
 * Stub for a command whose implementation awaits the S3 upload milestone.
 * @param {string} name - Command name
 * @returns {never}
 */
const notImplemented = (name) => {
  throw new Error(
    `Not yet implemented: ${name} (S3 upload milestone in progress)`,
  );
};

/** @type {Record<string, Command>} */
export const commands = {
  // ── Local snapshot commands ────────────────────────────────────────────
  snapshot: {
    summary: "Take a snapshot of a directory",
    args: { "<dir>": "The directory to snapshot" },
    options: {
      rehash: {
        type: "boolean",
        description:
          "Re-hash every file instead of reusing unchanged files' hashes from the previous snapshot",
      },
    },
    exec: (options, [dir] = []) => snapshot(dir, options),
  },
  list: {
    summary: "List a directory's snapshots",
    args: { "<dir>": "The directory whose snapshots to list" },
    options: {
      latest: {
        type: "boolean",
        short: "l",
        description: "Show only the most recent snapshot",
      },
      remote: {
        type: "boolean",
        short: "r",
        description: "List backups in the cloud instead of local snapshots",
      },
    },
    exec: async (options, [dir] = []) => list(dir, options),
  },
  compare: {
    summary: "Show what changed between two snapshots",
    args: { "<dir>": "The directory whose snapshots to compare" },
    options: {
      since: {
        type: "string",
        description:
          "The older snapshot to compare from (default: the one before --until)",
      },
      until: {
        type: "string",
        description: "The newer snapshot to compare to (default: the latest)",
      },
      remote: {
        type: "boolean",
        short: "r",
        description: "Compare backups in the cloud instead of local snapshots",
      },
    },
    exec: (options, [dir] = []) => compare(dir, options),
  },
  status: {
    summary: "Show what is backed up and what a backup would upload",
    planned: true,
    args: { "<dir>": "The directory to report on" },
    options: {
      remote: {
        type: "boolean",
        short: "r",
        description: "Check the cloud for what is already backed up",
      },
    },
    exec: () => notImplemented("status"),
  },

  // ── Remote backup commands (S3 milestone — not yet implemented) ─────────
  setup: {
    summary: "Set up a cloud backup destination for a directory",
    planned: true,
    args: {
      "<dir>": "The directory to back up",
      "<remote>": "Where to store the backup (an S3 bucket or URL)",
    },
    exec: () => notImplemented("setup"),
  },
  backup: {
    summary: "Back up a snapshot to the cloud",
    planned: true,
    args: { "<dir>": "The directory to back up" },
    options: {
      snapshot: {
        type: "string",
        short: "s",
        description: "Which snapshot to back up (default: the latest)",
      },
    },
    exec: () => notImplemented("backup"),
  },
  restore: {
    summary: "Restore files from a backup",
    planned: true,
    args: {
      "<dir>": "The directory the backup was taken from",
      "[<path>...]":
        "Specific files or folders to restore (default: everything)",
    },
    options: {
      snapshot: {
        type: "string",
        short: "s",
        description: "Which snapshot to restore from (default: the latest)",
      },
      output: {
        type: "string",
        short: "o",
        description:
          "Where to restore files to (default: their original locations)",
      },
    },
    exec: () => notImplemented("restore"),
  },
  verify: {
    summary: "Check that a backup is complete and undamaged",
    planned: true,
    args: { "<dir>": "The directory whose backup to check" },
    exec: () => notImplemented("verify"),
  },

  // ── Diagnostics ─────────────────────────────────────────────────────────
  tree: {
    summary: "List the files in a directory",
    args: { "<dir>": "The directory to list" },
    exec: async (options, [dir] = []) => tree(dir),
  },
  prop: {
    summary: "Show a file's hash, size, and modified time",
    args: { "<file>": "The file to inspect" },
    options: {
      lookup: {
        type: "string",
        description:
          "Reuse a file's stored hash from this snapshot if it is unchanged (path to a snapshot file)",
      },
    },
    exec: (options, [file] = []) => prop(file, options),
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

// Top-level help: no command given, or an explicit help request.
if (
  !commandName ||
  commandName === "help" ||
  commandName === "--help" ||
  commandName === "-h"
) {
  topUsage(console.log);
  process.exit(0);
}

const command = commands[commandName];

if (!command) {
  console.error(`Unknown command: ${commandName}\n`);
  topUsage();
  process.exit(127);
}

// Per-command help: `s3cab <command> --help`.
if (args.includes("--help") || args.includes("-h")) {
  usage(commandName, command, console.log);
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
 * Display top-level help: the available commands with their summaries.
 * @param {(...args: unknown[]) => void} [log] - Output sink: `console.log`
 *   (stdout) when help is explicitly requested, `console.error` (stderr,
 *   default) when shown as part of an error.
 */
function topUsage(log = console.error) {
  log("s3cab — S3 Content Addressable Backup\n");
  log("Usage: s3cab <command> [options] [args]\n");
  log("Commands:");
  for (const [name, { summary, planned }] of Object.entries(commands)) {
    const note = planned ? " (not yet available)" : "";
    log(`  ${name}`.padEnd(12) + summary + note);
  }
  log("\nRun 's3cab <command> --help' for a command's options.");
  log("Run 's3cab --version' to print the version.");
}

/**
 * Display usage information for a command.
 * @param {string} commandName - Command name
 * @param {Command} command - Command definition
 * @param {(...args: unknown[]) => void} [log] - Output sink: `console.log`
 *   (stdout) when help is explicitly requested, `console.error` (stderr,
 *   default) when shown as part of an error.
 */
function usage(commandName, command, log = console.error) {
  const { args, options, summary, description } = command;

  let usage = `Usage: s3cab ${commandName} `;
  if (options) usage += "[options] ";
  if (args) usage += Object.keys(args).join(" ");
  log(usage);
  log();

  if (summary) {
    log(summary);
    log();
  }

  if (args) {
    log("Arguments:");
    for (const [name, description = ""] of Object.entries(args)) {
      log(`  ${name}`.padEnd(24) + description);
    }
    log();
  }

  if (options) {
    log("Options:");
    for (const [name, { short, description = "" }] of Object.entries(options)) {
      const flags = short ? `-${short}, --${name}` : `--${name}`;
      log(`  ${flags}`.padEnd(24) + description);
    }
    log();
  }

  if (description) {
    log("Description:");
    log(description);
    log();
  }
}

// process.on("SIGINT", () => {
//   console.error("Caught interrupt signal (Ctrl+C)");
//   process.exit(130); // Exit with code 130 to indicate termination by Ctrl+C
// });
