import { aws } from "./commands/aws.mjs";
import { backup } from "./commands/backup.mjs";
import { cleanup } from "./commands/cleanup.mjs";
import { compare } from "./commands/compare.mjs";
import { deleteHashes } from "./commands/delete.mjs";
import { extract } from "./commands/extract.mjs";
import { find } from "./commands/find.mjs";
import { forget } from "./commands/forget.mjs";
import { hashes } from "./commands/hashes.mjs";
import { list } from "./commands/list.mjs";
import { prop } from "./commands/prop.mjs";
import { provider } from "./commands/provider.mjs";
import { reattach } from "./commands/reattach.mjs";
import { restore } from "./commands/restore.mjs";
import { setup } from "./commands/setup.mjs";
import { snapshot } from "./commands/snapshot.mjs";
import { status } from "./commands/status.mjs";
import { takeover } from "./commands/takeover.mjs";
import { tree } from "./commands/tree.mjs";
import { unlock } from "./commands/unlock.mjs";
import { upload } from "./commands/upload.mjs";
import { verify } from "./commands/verify.mjs";
import {
  awsDetails,
  backupDetails,
  compareDetails,
  deleteDetails,
  findDetails,
  providerDetails,
  snapshotDetails,
  treeDetails,
  unlockDetails,
} from "./command-details.mjs";
import {
  offerBackupChanges,
  renderBackup,
  renderCleanup,
  renderCompareResult,
  renderDelete,
  renderFind,
  renderForget,
  renderLines,
  renderList,
  renderProp,
  renderReattach,
  renderRestore,
  renderSetup,
  renderStatus,
  renderText,
  renderTree,
  renderUnlock,
  renderUpload,
  renderVerify,
} from "./render.mjs";

/** @import { RenderContext } from "./render.mjs" */
/** @import { ParseArgsOptionDescriptor } from "node:util" */

/** @typedef {ParseArgsOptionDescriptor & { description?: string }} CommandOption */
/** @typedef {ReturnType<typeof import('node:util').parseArgs>["values"]} ParsedOptions */
/** @typedef {string | string[] | object | undefined} CommandResult */

/**
 * A positional argument. `parseArgs` handles positionals as a flat array, not by
 * per-name descriptor, so unlike {@link CommandOption} this is purely our own
 * metadata — the display form (`<set>`, `[<directory>...]`) is *derived* from it
 * by `displayArg` in help.mjs, never baked into the key. `required`/`variadic`
 * default false (an optional single arg).
 * @typedef {Object} CommandArg
 * @property {string} description - Shown in `--help` and inline in a missing-arg error
 * @property {boolean} [required] - A mandatory positional: renders `<name>`, not `[<name>]`
 * @property {boolean} [variadic] - Accepts multiple values: renders a trailing `...`
 */

/**
 * @typedef {Object} Command
 * @property {Record<string, CommandArg>} [args]
 * @property {Record<string, CommandOption>} [options]
 * @property {(options: ParsedOptions, positionals?: string[]) => CommandResult | Promise<CommandResult>} exec
 * @property {(result: any, context: RenderContext) => string} render - Renders this command's result as human-readable text for stdout (ADR-0043). Required for every command — `tsc` enforces the invariant, so there is no generic dispatcher fallback (a generic object-dumper is just the JSON `--json` already emits).
 * @property {(result: any, context: RenderContext) => Promise<string | undefined>} [offer] - Follow-up output the command has to **ask** about, run by the dispatcher once `render`'s text is already on stdout and never under `--json`. `backup` is the only one: its report ends with an offer to show the full diff ([ADR-0078](../docs/adr/0078-backup-run-report.md) §5), and a prompt asking "show what changed?" *above* the summary of what changed would be asking the user to answer blind. It is a hook rather than a step inside the command because ordering is the dispatcher's — it owns the stream and the `--json` toggle, and a command that printed its own report would print it under `--json` too.
 * @property {string} summary
 * @property {string} [details] - The long-form `--help` body, rendered under "Description:" (lives in command-details.mjs). Distinct from an arg/option's one-line `description`.
 * @property {string} [guide] - The `guide/<topic>.md` page that covers this command, rendered as a `Full guide:` link at the foot of its `--help` (help.mjs). The topic, not a URL: the page must exist (test-enforced), and the URL shape is frozen into every shipped binary (CLAUDE.md), so it is spelled once
 * @property {string[]} [examples] - Example invocations, one per line, shown right after the summary in `--help` (lead with examples — clig.dev)
 * @property {string} [group] - Top-level help section heading; sticks for the commands that follow, so only the first command of each section sets it
 */

/** @type {Record<string, Command>} */
export const commands = {
  // ── Local snapshot commands ────────────────────────────────────────────
  snapshot: {
    group: "Snapshots",
    summary: "Take a snapshot of a backup set",
    guide: "backup",
    examples: ["s3cab snapshot", "s3cab snapshot photos"],
    details: snapshotDetails,
    args: {
      set: {
        description: "The backup set to snapshot (default: the only set)",
      },
    },
    options: {
      rehash: {
        type: "boolean",
        description:
          "Re-hash every file instead of reusing unchanged files' hashes from the previous snapshot",
      },
      resume: {
        type: "boolean",
        description:
          "Carry on from the work file a killed run left behind, reusing the hashes it had already worked out",
      },
    },
    exec: (options, [set] = []) => snapshot(set, options),
    render: renderCompareResult,
  },
  list: {
    summary: "List backup sets and their snapshots",
    examples: ["s3cab list", "s3cab list photos --remote"],
    args: {
      set: {
        description:
          "A single set to show in detail (with its directories); omit to list all sets",
      },
    },
    options: {
      latest: {
        type: "boolean",
        short: "l",
        description: "Show only each set's most recent snapshot",
      },
      remote: {
        type: "boolean",
        short: "r",
        description: "List one set's cloud backups instead of local snapshots",
      },
    },
    exec: (options, [set] = []) => list(set, options),
    render: renderList,
  },
  compare: {
    summary: "Show what changed between two snapshots",
    guide: "compare",
    examples: ["s3cab compare", "s3cab compare photos --since 20251111T0830"],
    details: compareDetails,
    args: {
      set: {
        description:
          "The backup set whose snapshots to compare (default: the only set)",
      },
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
    },
    exec: (options, [set] = []) => compare(set, options),
    render: renderCompareResult,
  },
  find: {
    summary: "Search your backups for a file, and show what backs it",
    guide: "find",
    examples: [
      "s3cab find aws-keys.txt",
      "s3cab find '*.mov' --set photos",
      "s3cab find secretsdir/ > hashes.txt",
    ],
    details: findDetails,
    args: {
      pattern: {
        required: true,
        variadic: true,
        description:
          "File name, path fragment, or directory (with a trailing separator) to search for",
      },
    },
    options: {
      set: {
        type: "string",
        short: "S",
        description:
          "Search only this backup set (default: every attached set)",
      },
      all: {
        type: "boolean",
        short: "a",
        description:
          "List every snapshot holding each file, instead of collapsing unchanged runs into ranges",
      },
    },
    exec: (options, patterns = []) => find(patterns, options),
    render: renderFind,
  },
  status: {
    summary: "Show what is backed up and what a backup would upload",
    examples: ["s3cab status", "s3cab status photos"],
    args: {
      set: {
        description: "The backup set to report on (default: the only set)",
      },
    },
    exec: (_options, [set] = []) => status(set),
    render: renderStatus,
  },

  // ── Setup: provision the cloud, point at credentials, define a set ─────
  // The onboarding order (ADR-0036, names per ADR-0047): aws|provider → setup → backup.
  aws: {
    group: "Setup",
    summary: "Show the steps to set up an AWS S3 bucket for backups",
    guide: "aws",
    examples: [
      "s3cab aws my-backups",
      "s3cab aws my-backups --region eu-west-1 --profile admin",
    ],
    details: awsDetails,
    args: {
      bucket: {
        required: true,
        description: "The S3 bucket name to set up as a backup destination",
      },
    },
    options: {
      "roles-anywhere": {
        type: "boolean",
        description:
          "Use the keyless Roles Anywhere identity (generate certs + emit its template) instead of an IAM user",
      },
      save: {
        type: "boolean",
        description:
          "Capture a deployed stack's Roles Anywhere ARNs into the local identity (use with --from-stack)",
      },
      "from-stack": {
        type: "string",
        description:
          "The deployed identity stack to read Roles Anywhere ARNs from (s3cab-<bucket>-<fingerprint>)",
      },
      profile: {
        type: "string",
        short: "p",
        description:
          "An admin AWS profile, dropped into the printed aws commands and used by --save to read the stack",
      },
      region: {
        type: "string",
        description:
          "The bucket's AWS region (default: $AWS_REGION / $AWS_DEFAULT_REGION, else us-east-1)",
      },
    },
    exec: (options, [name] = []) => aws(name, options),
    render: renderText,
  },
  provider: {
    summary: "Set, clear, or show how s3cab connects to your storage provider",
    guide: "auth",
    examples: [
      "s3cab provider --endpoint https://<account>.r2.cloudflarestorage.com --region auto",
      "s3cab provider --profile s3cab-backup",
      "s3cab provider",
    ],
    details: providerDetails,
    args: {
      set: {
        description:
          "The set to configure (omit for your only set on a write, or to summarize all sets on a bare show)",
      },
    },
    options: {
      profile: {
        type: "string",
        short: "p",
        description: "The AWS profile to use (from your ~/.aws config)",
      },
      endpoint: {
        type: "string",
        description:
          "The provider's S3 endpoint URL, for non-AWS providers (writes AWS_ENDPOINT_URL_S3)",
      },
      region: {
        type: "string",
        description: "The region label the provider expects (e.g. auto)",
      },
      keys: {
        type: "boolean",
        description:
          "Save an access key + secret — prompts at a terminal, or reads two lines from stdin (never flags)",
      },
      "roles-anywhere": {
        type: "boolean",
        description:
          "Switch the set to the keyless Roles Anywhere identity (AWS-only; set it up with 's3cab aws --roles-anywhere')",
      },
      unset: {
        type: "string",
        description:
          "Remove a setting: profile, endpoint, region, keys, or roles-anywhere",
      },
    },
    exec: (options, [set] = []) => provider(set, options),
    render: renderText,
  },
  setup: {
    summary: "Create a backup set",
    examples: [
      "s3cab setup --set photos --bucket my-backups C:\\Users\\me\\Photos",
    ],
    args: {
      directory: {
        required: true,
        variadic: true,
        description: "The directories that make up the set",
      },
    },
    options: {
      set: {
        type: "string",
        short: "S",
        description: "The backup set to create (required)",
      },
      bucket: {
        type: "string",
        short: "b",
        description: "The S3 bucket to back this set up to",
      },
      profile: {
        type: "string",
        short: "p",
        description: "The AWS profile to use (from your ~/.aws config)",
      },
      endpoint: {
        type: "string",
        description:
          "The provider's S3 endpoint URL, for non-AWS providers (writes AWS_ENDPOINT_URL_S3)",
      },
      region: {
        type: "string",
        description: "The region label the provider expects (e.g. auto)",
      },
      keys: {
        type: "boolean",
        description:
          "Save an access key + secret — prompts at a terminal, or reads two lines from stdin (never flags)",
      },
      "roles-anywhere": {
        type: "boolean",
        description:
          "Point the set at the keyless Roles Anywhere identity (set it up first with 's3cab aws --roles-anywhere')",
      },
    },
    exec: (options, directories = []) => setup(directories, options),
    render: renderSetup,
  },
  reattach: {
    summary:
      "Attach an existing backup set to this machine read-only, or refresh it",
    guide: "restore",
    examples: [
      "s3cab reattach photos --bucket my-backups",
      "s3cab reattach photos",
    ],
    args: {
      set: {
        required: true,
        description: "The existing backup set to attach or refresh",
      },
    },
    options: {
      bucket: {
        type: "string",
        short: "b",
        description:
          "The S3 bucket holding the set (needed only when it isn't attached yet)",
      },
    },
    exec: (options, [name, ...directories] = []) =>
      reattach(name, directories, options),
    render: renderReattach,
  },
  takeover: {
    summary: "Make this machine the one that backs up an existing set",
    guide: "restore",
    examples: ["s3cab takeover photos --bucket my-backups"],
    args: {
      set: {
        required: true,
        description: "The existing backup set to take over",
      },
    },
    options: {
      bucket: {
        type: "string",
        short: "b",
        description:
          "The S3 bucket holding the set (needed only when it isn't attached yet)",
      },
    },
    exec: (options, [name, ...directories] = []) =>
      takeover(name, directories, options),
    render: renderSetup,
  },

  // ── Backup & restore (docs/design/backup.md) ───────────────────────────
  backup: {
    group: "Backup & restore",
    summary: "Back up a set to the cloud",
    guide: "backup",
    examples: ["s3cab backup", "s3cab backup photos"],
    details: backupDetails,
    args: {
      set: { description: "The backup set to back up (default: the only set)" },
    },
    options: {
      rehash: {
        type: "boolean",
        description:
          "Re-hash every file instead of reusing unchanged files' hashes from the previous snapshot",
      },
      resume: {
        type: "boolean",
        description:
          "Carry on from the work file a killed run left behind, reusing the hashes it had already worked out",
      },
    },
    exec: (options, [set] = []) => backup(set, options),
    render: renderBackup,
    offer: offerBackupChanges,
  },
  restore: {
    summary: "Restore files from a backup",
    guide: "restore",
    examples: [
      "s3cab restore --set photos C:\\Users\\me\\Photos\\beach.jpg",
      "s3cab restore --set photos --from-file paths.txt",
      "s3cab restore --set photos --all",
      "s3cab restore --set photos --all --output D:\\recovered",
    ],
    args: {
      path: {
        variadic: true,
        description:
          "Files or folders to restore, as backed up (required unless --from-file or --all)",
      },
    },
    options: {
      set: {
        type: "string",
        short: "S",
        description: "The backup set to restore (required)",
      },
      snapshot: {
        type: "string",
        short: "s",
        description: "Which snapshot to restore from (default: the latest)",
      },
      "from-file": {
        type: "string",
        description:
          "Also restore the paths listed in this file, one per line as in dirs.txt ('-' reads them from a pipe)",
      },
      all: {
        type: "boolean",
        short: "a",
        description: "Restore everything in the snapshot",
      },
      overwrite: {
        type: "boolean",
        description: "Replace existing files (default: skip them, untouched)",
      },
      output: {
        type: "string",
        short: "o",
        description:
          "Restore under this folder, each file at its full original path, instead of to the original locations",
      },
    },
    exec: (options, paths = []) => restore(paths, options),
    render: renderRestore,
  },
  extract: {
    summary: "Copy one file or folder out of a backup, by its own name",
    guide: "restore",
    examples: [
      "s3cab extract --set photos C:\\Users\\me\\Documents\\report.pdf",
      "s3cab extract --set photos C:\\Users\\me\\Photos --snapshot 20260501T0800 --name Photos-May",
    ],
    args: {
      path: {
        required: true,
        description: "The file or folder to extract, as backed up",
      },
    },
    options: {
      set: {
        type: "string",
        short: "S",
        description: "The backup set to extract from (required)",
      },
      snapshot: {
        type: "string",
        short: "s",
        description: "Which snapshot to extract from (default: the latest)",
      },
      output: {
        type: "string",
        short: "o",
        description: "The folder to put it in (default: the current folder)",
      },
      name: {
        type: "string",
        description: "Give the copy this name instead of its own",
      },
      overwrite: {
        type: "boolean",
        description:
          "Write over the files already there under that name, leaving any others (default: refuse, before anything is read)",
      },
    },
    exec: (options, paths = []) => extract(paths, options),
    render: renderRestore,
  },
  verify: {
    summary: "Check that a repository's backups are complete and undamaged",
    guide: "maintenance",
    examples: ["s3cab verify my-backups"],
    args: {
      bucket: {
        required: true,
        description: "The repository's S3 bucket to check",
      },
    },
    exec: (_options, [bucket] = []) => verify(bucket),
    render: renderVerify,
  },
  forget: {
    summary: "Remove snapshots from a backup",
    guide: "maintenance",
    examples: [
      "s3cab forget --set photos 20260612T0915",
      "s3cab forget --set photos 20260612T0915 20260619T0902",
      "s3cab forget --set photos 20260612T0915 --force",
    ],
    args: {
      snapshot: {
        required: true,
        variadic: true,
        description: "Which snapshots to forget",
      },
    },
    options: {
      set: {
        type: "string",
        short: "S",
        description: "The backup set the snapshot belongs to (required)",
      },
      force: {
        type: "boolean",
        short: "f",
        description:
          "Skip the unrestorable check and the confirmation (required for non-interactive runs; default: report what you could no longer restore, then ask)",
      },
    },
    exec: (options, snapshots = []) => forget(snapshots, options),
    render: renderForget,
  },
  delete: {
    summary: "Delete objects from every backup by content hash, permanently",
    guide: "maintenance",
    examples: [
      "s3cab find secretsdir/ > hashes.txt",
      "s3cab delete --bucket my-backups --from-file hashes.txt",
      "s3cab delete --bucket my-backups 5e21ab7fc0b1e83d276af59104cc7e2b8d3610fa94e7b25c0d81f36ae9b40c93",
    ],
    details: deleteDetails,
    args: {
      hash: {
        variadic: true,
        description:
          "Content hashes of the objects to delete ('s3cab find' prints them; required unless --from-file)",
      },
    },
    options: {
      bucket: {
        type: "string",
        short: "b",
        description: "The repository's S3 bucket (required)",
      },
      "from-file": {
        type: "string",
        description:
          "Read the hashes from a file — 's3cab find' output, or any file with hashes in column one",
      },
      "dry-run": {
        type: "boolean",
        short: "n",
        description: "Preview what would be deleted, delete nothing",
      },
      force: {
        type: "boolean",
        short: "f",
        description:
          "Skip the typed confirmation (required for non-interactive runs)",
      },
      wait: {
        type: "boolean",
        description:
          "Wait for any running backup or upload to finish instead of refusing",
      },
    },
    exec: (options, hashes = []) => deleteHashes(hashes, options),
    render: renderDelete,
  },
  cleanup: {
    summary: "Reclaim storage held by objects no snapshot references",
    guide: "maintenance",
    examples: [
      "s3cab cleanup my-backups",
      "s3cab cleanup my-backups --dry-run",
      "s3cab cleanup my-backups --force",
    ],
    args: {
      bucket: {
        required: true,
        description: "The repository's S3 bucket to clean up",
      },
    },
    options: {
      "dry-run": {
        type: "boolean",
        short: "n",
        description:
          "Report the orphaned objects and the space they hold, delete nothing",
      },
      force: {
        type: "boolean",
        short: "f",
        description:
          "Skip the confirmation (required for a non-interactive reclaim; not needed with --dry-run)",
      },
      wait: {
        type: "boolean",
        description:
          "Wait for any running backup or upload to finish instead of refusing",
      },
    },
    exec: (options, [bucket] = []) => cleanup(bucket, options),
    render: renderCleanup,
  },
  unlock: {
    summary:
      "Remove locks a stopped backup, upload, cleanup or delete left behind",
    guide: "maintenance",
    examples: [
      "s3cab unlock --bucket my-backups",
      "s3cab unlock --bucket my-backups upload-20261027T140205.123Z",
      "s3cab unlock --bucket my-backups --force delete-20261027T151000.004Z",
    ],
    details: unlockDetails,
    args: {
      id: {
        variadic: true,
        description:
          "The locks to remove, by id (as a refusal or the listing prints them; default: every lock, after showing them)",
      },
    },
    options: {
      bucket: {
        type: "string",
        short: "b",
        description: "The repository's S3 bucket (required)",
      },
      "dry-run": {
        type: "boolean",
        short: "n",
        description: "List the locks, remove nothing",
      },
      force: {
        type: "boolean",
        short: "f",
        description:
          "Skip the confirmation (needs ids; required for non-interactive runs)",
      },
    },
    exec: (options, ids = []) => unlock(ids, options),
    render: renderUnlock,
  },

  // ── Diagnostics ─────────────────────────────────────────────────────────
  hashes: {
    group: "Advanced",
    summary: "List a repository's stored object hashes (one per line)",
    examples: ["s3cab hashes my-backups", "s3cab hashes my-backups > have.txt"],
    args: {
      bucket: {
        required: true,
        description: "The repository's S3 bucket name",
      },
    },
    exec: (_options, [bucket] = []) => hashes(bucket),
    render: renderLines,
  },
  upload: {
    summary:
      "Upload a file, a folder's objects, or a snapshot's objects to a set's store",
    examples: [
      "s3cab upload photos --file C:\\Users\\me\\big.iso",
      "s3cab upload photos --dir C:\\Users\\me\\Photos\\2026",
      "s3cab upload photos --snapshot 20260612T0915",
      "s3cab upload --bucket my-backups --file big.iso",
    ],
    args: {
      set: {
        description:
          "The backup set to upload into (supplies the bucket; required unless --bucket)",
      },
    },
    options: {
      file: {
        type: "string",
        description: "Upload this single file as one object",
      },
      dir: {
        type: "string",
        description:
          "Seed the set's store from this folder — hash and upload its objects, no snapshot",
      },
      snapshot: {
        type: "string",
        short: "s",
        description:
          "Upload every object this snapshot references, then its snapshot file",
      },
      since: {
        type: "string",
        description:
          "Skip objects already in this baseline snapshot (snapshot mode; default: scan the store)",
      },
      bucket: {
        type: "string",
        short: "b",
        description:
          "Upload a --file straight into this bucket, with no set (ambient credentials)",
      },
      force: {
        type: "boolean",
        short: "f",
        description:
          "Re-upload even if the object already exists (--file only)",
      },
    },
    exec: (options, [set] = []) => upload(set, options),
    render: renderUpload,
  },
  tree: {
    summary: "List the files a snapshot of a backup set would include",
    guide: "exclude",
    examples: ["s3cab tree", "s3cab tree photos", "s3cab tree --excluded"],
    details: treeDetails,
    args: {
      set: { description: "The backup set to list (default: the only set)" },
    },
    options: {
      excluded: {
        type: "boolean",
        description:
          "List what the set's exclude patterns are dropping instead, each with the pattern that matched it",
      },
    },
    exec: (options, [set] = []) => tree(set, options),
    render: renderTree,
  },
  prop: {
    summary: "Show a file's hash, size, and modified time",
    examples: ["s3cab prop C:\\Users\\me\\Photos\\beach.jpg"],
    args: {
      file: { required: true, description: "The file to inspect" },
    },
    options: {
      lookup: {
        type: "string",
        description:
          "Reuse a file's stored hash from this snapshot if it is unchanged (path to a snapshot file)",
      },
    },
    exec: (options, [file] = []) => prop(file, options),
    render: renderProp,
  },
};
