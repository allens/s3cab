import { compare } from "./commands/compare.mjs";
import { credentialProcess } from "./commands/credential-process.mjs";
import { list } from "./commands/list.mjs";
import { login } from "./commands/login.mjs";
import { objects } from "./commands/objects.mjs";
import { prop } from "./commands/prop.mjs";
import { snapshot } from "./commands/snapshot.mjs";
import { tree } from "./commands/tree.mjs";
import { upload } from "./commands/upload.mjs";
import { notImplemented } from "./lib/error.mjs";

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

/** @type {Record<string, Command>} */
export const commands = {
  // ── Local snapshot commands ────────────────────────────────────────────
  snapshot: {
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
    exec: async (options, [dir] = []) => list(dir, options),
  },
  compare: {
    summary: "Show what changed between two snapshots",
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
  login: {
    summary: "Log in to AWS via SSO (experimental, AWS-only)",
    description:
      "Optional, experimental, and AWS-only. Most people authenticate with an\n" +
      "access key + secret (via an s3cab env file) or an existing AWS profile —\n" +
      "see 's3cab help auth'; this command is just a convenience.\n\n" +
      "It signs in to AWS IAM Identity Center (SSO) for users who don't already\n" +
      "have working AWS credentials and may not have the AWS CLI, and caches the\n" +
      "session for later non-interactive use. (If you do have the AWS CLI, its\n" +
      "'aws sso login' works too — s3cab reads that session via the standard\n" +
      "credential chain.) It does not modify ~/.aws/config or ~/.aws/credentials.",
    options: {
      "start-url": {
        type: "string",
        description: "IAM Identity Center start URL",
      },
      region: {
        type: "string",
        description: "SSO region",
      },
    },
    exec: (options) =>
      login({
        startUrl: /** @type {string | undefined} */ (options["start-url"]),
        region: /** @type {string | undefined} */ (options.region),
      }),
  },
  "credential-process": {
    summary:
      "Emit AWS credentials as credential_process JSON (experimental, AWS-only)",
    description:
      "Optional, experimental companion to 's3cab login' (AWS-only). Outputs the\n" +
      "credentials from your login session in AWS's standard credential_process\n" +
      "JSON format, for advanced users who want to wire s3cab into an AWS profile\n" +
      "as a credential helper:\n\n" +
      "  [profile s3cab]\n" +
      "  credential_process = s3cab credential-process\n\n" +
      "s3cab does not create or edit AWS shared config automatically; configure\n" +
      "this yourself if you want it.",
    exec: () => credentialProcess(),
  },
  objects: {
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
