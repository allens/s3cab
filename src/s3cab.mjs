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
  list: {
    summary: "List snapshots in a directory",
    args: { "<dir>": "Directory to list snapshots from" },
    options: {
      latest: {
        type: "boolean",
        short: "l",
        description: "Return only the latest snapshot file",
      },
      remote: {
        type: "boolean",
        short: "r",
        description:
          "List snapshots backed up to the remote instead of locally",
      },
    },
    exec: async (options, [dir] = []) => list(dir, options),
  },
  compare: {
    summary: "Show differences between two snapshots",
    args: {
      "<dir>": "Directory containing the snapshots to compare",
      "<current>": "Current snapshot name (default: latest)",
      "<previous>": "Previous snapshot name (default: the one before current)",
    },
    options: {
      remote: {
        type: "boolean",
        short: "r",
        description: "Compare against snapshots backed up to the remote",
      },
    },
    exec: (options, [dir, current, previous] = []) =>
      compare(dir, current, previous, options),
  },
  status: {
    summary:
      "Show which snapshots are backed up and what a backup would upload",
    args: { "<dir>": "Directory to report status for" },
    options: {
      remote: {
        type: "boolean",
        short: "r",
        description: "Query the remote for backed-up state",
      },
    },
    exec: () => notImplemented("status"),
  },

  // ── Remote backup commands (S3 milestone — not yet implemented) ─────────
  init: {
    summary:
      "Initialize an s3cab repository: prepare the remote and link this directory to it",
    args: {
      "<dir>": "Local directory to initialize",
      "<remote>": "Remote bucket/URL to back up to",
    },
    exec: () => notImplemented("init"),
  },
  backup: {
    summary: "Back up a snapshot (manifest + objects) to the remote",
    args: { "<dir>": "Directory whose snapshot to back up" },
    options: {
      snapshot: {
        type: "string",
        short: "s",
        description: "Snapshot to back up (default: latest)",
      },
    },
    exec: () => notImplemented("backup"),
  },
  restore: {
    summary: "Restore files from a backed-up snapshot",
    args: {
      "<dir>": "Directory the snapshot was taken from",
      "[<path>...]": "Paths/globs to restore (default: everything)",
    },
    options: {
      snapshot: {
        type: "string",
        short: "s",
        description: "Snapshot to restore from (default: latest)",
      },
      output: {
        type: "string",
        short: "o",
        description: "Directory to restore into (default: alongside originals)",
      },
    },
    exec: () => notImplemented("restore"),
  },
  verify: {
    summary:
      "Verify remote integrity: every referenced object exists and hashes match",
    args: { "<dir>": "Directory whose backups to verify" },
    exec: () => notImplemented("verify"),
  },

  // ── Diagnostics ─────────────────────────────────────────────────────────
  tree: {
    summary: "List files in a directory",
    args: { "<dir>": "Directory to list files from" },
    exec: async (options, [dir] = []) => tree(dir),
  },
  prop: {
    summary: "Show properties of a file",
    args: { "<file>": "File to show properties of" },
    options: {
      lookup: {
        type: "string",
        description: "Path to snapshot file to lookup properties from",
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

const command = commandName ? commands[commandName] : undefined;

if (!commandName || !command) {
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
      const flags = short ? `-${short}, --${name}` : `--${name}`;
      console.error(`  ${flags}`.padEnd(24) + description);
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
