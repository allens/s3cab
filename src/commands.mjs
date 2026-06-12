import { compare } from "./commands/compare.mjs";
import { list } from "./commands/list.mjs";
import { objects } from "./commands/objects.mjs";
import { prop } from "./commands/prop.mjs";
import { setup } from "./commands/setup.mjs";
import { snapshot } from "./commands/snapshot.mjs";
import { tree } from "./commands/tree.mjs";
import { upload } from "./commands/upload.mjs";
import { notImplemented } from "./lib/error.mjs";

/** @typedef {import('node:util').ParseArgsOptionDescriptor & { description?: string }} CommandOption */
/** @typedef {ReturnType<typeof import('node:util').parseArgs>["values"]} ParsedOptions */
/** @typedef {string | string[] | object | undefined} CommandResult */

/**
 * @typedef {Object} Command
 * @property {Record<string, string>} [args]
 * @property {Record<string, CommandOption>} [options]
 * @property {(options: ParsedOptions, positionals?: string[]) => CommandResult | Promise<CommandResult>} exec
 * @property {string} summary
 * @property {string} [description]
 * @property {boolean} [planned] - Scaffolded but not yet implemented (awaiting the S3 milestone)
 * @property {string} [group] - Top-level help section heading; sticks for the commands that follow, so only the first command of each section sets it
 */

/** @type {Record<string, Command>} */
export const commands = {
  // ── Local snapshot commands ────────────────────────────────────────────
  snapshot: {
    group: "Snapshots",
    summary: "Take a snapshot of a directory",
    args: {
      "[<dir>]": "The directory to snapshot (default: current directory)",
    },
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
    args: {
      "[<dir>]":
        "The directory whose snapshots to list (default: current directory)",
    },
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
    exec: (options, [dir] = []) => list(dir, options),
  },
  compare: {
    summary: "Show what changed between two snapshots",
    description: `The report compares file content (SHA-256 hashes), never timestamps.
'old.txt → new.txt' is a rename, '→→' a move to another folder, and
'new.txt == old.txt' a copy of content that already existed.
Full guide: https://github.com/allens/s3cab/blob/main/doc/compare.md`,
    args: {
      "[<dir>]":
        "The directory whose snapshots to compare (default: current directory)",
    },
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

  // ── Backup sets (specs/backup.md) — the cloud half is not yet implemented ─
  setup: {
    group: "Backup sets",
    summary: "Create or update a backup set",
    args: {
      "<set>": "The set's name (lowercase letters, digits, and hyphens)",
      "[<folder>...]":
        "The folders that make up the set (required when creating)",
    },
    options: {
      bucket: {
        type: "string",
        short: "b",
        description: "The S3 bucket to back this set up to",
      },
    },
    exec: (options, [name, ...folders] = []) => setup(name, folders, options),
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
  objects: {
    group: "Advanced",
    summary: "List a repository's stored object hashes (one per line)",
    args: {
      "<bucket>": "The repository's S3 bucket name",
    },
    options: {
      file: {
        type: "string",
        short: "f",
        description:
          "Write the hashes to this file (one per line) instead of stdout",
      },
    },
    exec: (options, [bucket] = []) => objects(bucket, options),
  },
  upload: {
    summary: "Upload a single file to a repository's object store",
    args: {
      "<bucket>": "The repository's S3 bucket name",
      "<file>": "The file to upload",
    },
    options: {
      force: {
        type: "boolean",
        short: "f",
        description: "Re-upload even if the object already exists",
      },
    },
    exec: (options, [bucket, file] = []) => upload(bucket, file, options),
  },
  tree: {
    summary: "List the files in a directory",
    args: { "[<dir>]": "The directory to list (default: current directory)" },
    exec: (options, [dir] = []) => tree(dir),
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
