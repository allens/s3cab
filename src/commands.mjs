import { backup } from "./commands/backup.mjs";
import { compare } from "./commands/compare.mjs";
import { hashes } from "./commands/hashes.mjs";
import { list } from "./commands/list.mjs";
import { prop } from "./commands/prop.mjs";
import { restore } from "./commands/restore.mjs";
import { sets } from "./commands/sets.mjs";
import { setup } from "./commands/setup.mjs";
import { snapshot } from "./commands/snapshot.mjs";
import { status } from "./commands/status.mjs";
import { sep } from "node:path";
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
    summary: "Take a snapshot of a backup set",
    args: {
      "[<set>]": "The backup set to snapshot (default: the only set)",
    },
    options: {
      rehash: {
        type: "boolean",
        description:
          "Re-hash every file instead of reusing unchanged files' hashes from the previous snapshot",
      },
    },
    exec: (options, [set] = []) => snapshot(set, options),
  },
  list: {
    summary: "List a backup set's snapshots",
    args: {
      "[<set>]":
        "The backup set whose snapshots to list (default: the only set)",
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
    exec: (options, [set] = []) => list(set, options),
  },
  compare: {
    summary: "Show what changed between two snapshots",
    description: `The report compares file content (SHA-256 hashes), never timestamps.
'old.txt → new.txt' is a rename, '→→' a move to another folder, and
'new.txt == old.txt' a copy of content that already existed.
Full guide: https://github.com/allens/s3cab/blob/main/guide/compare.md`,
    args: {
      "[<set>]":
        "The backup set whose snapshots to compare (default: the only set)",
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
    exec: (options, [set] = []) => compare(set, options),
  },
  status: {
    summary: "Show what is backed up and what a backup would upload",
    args: { "[<set>]": "The backup set to report on (default: the only set)" },
    exec: (_options, [set] = []) => status(set),
  },

  // ── Backup sets (docs/specs/backup.md) — restore/verify still to come ─
  setup: {
    group: "Backup sets",
    summary: "Create, update, or inherit a backup set",
    args: {
      "<set>": "The set's name (lowercase letters, digits, and hyphens)",
      "[<folder>...]":
        "The folders that make up the set (required when creating)",
    },
    options: {
      bucket: {
        type: "string",
        short: "b",
        description:
          "The S3 bucket to back this set up to (required when creating)",
      },
      inherit: {
        type: "boolean",
        description:
          "Inherit an existing backup set from the bucket onto this machine (for a replacement machine or recovery)",
      },
    },
    exec: (options, [name, ...folders] = []) => setup(name, folders, options),
  },
  sets: {
    summary: "List your backup sets",
    exec: () => sets(),
  },
  backup: {
    summary: "Back up a set to the cloud",
    args: { "[<set>]": "The backup set to back up (default: the only set)" },
    options: {
      snapshot: {
        type: "string",
        short: "s",
        description:
          "Back up this existing snapshot instead of taking a new one",
      },
      "skip-cache": {
        type: "boolean",
        description:
          "Skip the local objects cache and re-check the cloud directly",
      },
    },
    exec: (options, [set] = []) => backup(set, options),
  },
  restore: {
    summary: "Restore files from a backup",
    args: {
      "[<set>]": "The backup set to restore (default: the only set)",
      "[<path>...]":
        "Specific files or folders to restore (default: everything). " +
        "Name the set first when filtering.",
    },
    options: {
      snapshot: {
        type: "string",
        short: "s",
        description: "Which snapshot to restore from (default: the latest)",
      },
      overwrite: {
        type: "boolean",
        description: "Replace existing files (default: skip them, untouched)",
      },
      output: {
        type: "string",
        short: "o",
        description: `Restore under this folder (as <output>${sep}<folder-name>${sep}…) instead of the original locations`,
      },
    },
    exec: (options, [set, ...paths] = []) => restore(set, paths, options),
  },
  verify: {
    summary: "Check that a backup is complete and undamaged",
    planned: true,
    args: { "[<set>]": "The backup set to check (default: the only set)" },
    exec: () => notImplemented("verify"),
  },

  // ── Diagnostics ─────────────────────────────────────────────────────────
  hashes: {
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
    exec: (options, [bucket] = []) => hashes(bucket, options),
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
    summary: "List the files a snapshot of a backup set would include",
    args: { "[<set>]": "The backup set to list (default: the only set)" },
    exec: (_options, [set] = []) => tree(set),
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
