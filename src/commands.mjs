import { aws } from "./commands/aws.mjs";
import { backup } from "./commands/backup.mjs";
import { cleanup } from "./commands/cleanup.mjs";
import { compare } from "./commands/compare.mjs";
import { deleteSnapshot } from "./commands/delete.mjs";
import { hashes } from "./commands/hashes.mjs";
import { list } from "./commands/list.mjs";
import { prop } from "./commands/prop.mjs";
import { provider } from "./commands/provider.mjs";
import { reattach } from "./commands/reattach.mjs";
import { restore } from "./commands/restore.mjs";
import { setup } from "./commands/setup.mjs";
import { snapshot } from "./commands/snapshot.mjs";
import { status } from "./commands/status.mjs";
import { sep } from "node:path";
import { tree } from "./commands/tree.mjs";
import { upload } from "./commands/upload.mjs";
import { verify } from "./commands/verify.mjs";
import {
  renderBackup,
  renderCleanup,
  renderCompareResult,
  renderDelete,
  renderLines,
  renderList,
  renderProp,
  renderRestore,
  renderSetup,
  renderStatus,
  renderText,
  renderUpload,
  renderVerify,
} from "./render.mjs";

/** @import { RenderContext } from "./render.mjs" */

/** @typedef {import('node:util').ParseArgsOptionDescriptor & { description?: string }} CommandOption */
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
 * @property {string} summary
 * @property {string} [description]
 * @property {string[]} [examples] - Example invocations, one per line, shown right after the summary in `--help` (lead with examples — clig.dev)
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
    examples: ["s3cab compare", "s3cab compare photos --since 2025-11-11T0830"],
    description: `The report compares file content (SHA-256 hashes), never timestamps.
'old.txt → new.txt' is a rename, '→→' a move to another directory, and
'new.txt == old.txt' a copy of content that already existed.
Full guide: https://github.com/allens/s3cab/blob/main/guide/compare.md`,
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
  status: {
    summary: "Show what is backed up and what a backup would upload",
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
    examples: [
      "s3cab aws my-backups",
      "s3cab aws my-backups --region eu-west-1 --profile admin",
    ],
    description: `It only PRINTS the steps — it never touches your account and needs no
credentials to run, so you can read the whole plan first. The printed recipe
stands up the bucket (versioning ON as your safety net) and a least-privilege
identity that can never permanently destroy backup history.

Choosing an identity:
  (default)  a dedicated AWS IAM user — simplest if you don't use SSO
  --sso      reuse your AWS IAM Identity Center (SSO) sign-in

AWS only. For a non-AWS S3 provider (Cloudflare R2, Backblaze B2, Wasabi,
MinIO, …), run 's3cab help provider' for the setup steps instead.

Then create a backup set in it:
  s3cab setup <name> <directory>... --bucket <bucket>

Full guide: https://github.com/allens/s3cab/blob/main/guide/aws.md`,
    args: {
      bucket: {
        required: true,
        description: "The S3 bucket name to set up as a backup destination",
      },
    },
    options: {
      sso: {
        type: "boolean",
        description:
          "Show the AWS IAM Identity Center (SSO) recipe instead of the IAM-user one",
      },
      profile: {
        type: "string",
        short: "p",
        description:
          "An admin AWS profile to drop into the printed aws commands (--profile <name>)",
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
    examples: [
      "s3cab provider --endpoint https://<account>.r2.cloudflarestorage.com --region auto",
      "s3cab provider --profile s3cab-backup",
      "s3cab provider",
    ],
    description: `Configures which storage provider s3cab talks to and how it signs in — an
AWS profile, a custom S3 endpoint (any S3-compatible provider), a region,
and access keys. Run it with no flags to see the current setup.

Setting up a non-AWS S3 provider (Cloudflare R2, Backblaze B2, Wasabi,
MinIO, …):

1. Create your bucket in the provider's console (or its CLI).
2. Turn on object versioning if the provider supports it — your safety
   net, so a deleted or overwritten backup stays recoverable.
3. Create an access key / token scoped to that bucket, with read, write,
   delete, and list on its objects (R2: API Tokens; B2: Application Keys;
   Wasabi: sub-users).
4. Point s3cab at the provider:
     s3cab provider --endpoint https://<your-endpoint> --region auto
     s3cab provider --keys
   (--keys asks for the key + secret — some providers need a real region,
   e.g. us-east-1. s3cab drops AWS-only request features automatically
   when a custom endpoint is set.)
5. Create a backup set in the bucket:
     s3cab setup <name> <directory>... --bucket <bucket>

On AWS instead? 's3cab aws <bucket>' prints the full bucket + identity
recipe, ending back here at --profile.

How s3cab resolves credentials:

1. s3cab loads the active set's env file first, if present. It sets AWS_*
   variables — a profile, region, endpoint, or keys (all settable with
   this command). It is the one s3cab config layer, applied over your
   shell (a file always beats the shell):
     ~/.s3cab/sets/<set>/env  the set's bucket + how to reach it
                              (written by 's3cab setup' and this command)
   There is no per-user s3cab file; your machine-wide default is your
   ordinary AWS setup (step 2). s3cab does NOT read a .env from the
   current directory.

2. s3cab then uses the standard AWS SDK credential chain.
   This includes existing AWS_PROFILE, shared AWS profiles (including
   SSO sessions from 'aws sso login'), shared credential_process
   profiles, and AWS_* environment variables.

3. If nothing is configured, s3cab stops with an error explaining
   these options.

Notes:
  - s3cab does not modify ~/.aws/config or ~/.aws/credentials.
  - Keys are never taken via flags (they'd leak into shell history) —
    --keys prompts at a terminal, or reads two lines from stdin.
  - A set signs in one way: a profile OR keys, not both. Setting one
    with this command clears the other on that set.
  - For AWS, temporary credentials from profile-based setups are preferred
    over long-lived keys.
  - To keep a long-lived key/secret out of plaintext env files, store it
    in a secret manager and expose it through a credential_process profile
    — the full guide has the recipe.

When the server rejects your credentials:

s3cab names the cause and shows the raw error. By cause:

  Expired credentials
    - AWS IAM Identity Center (SSO): run 'aws sso login' again
    - temporary credentials (AWS_SESSION_TOKEN): request a fresh set
    - a named profile: renew it (and set AWS_PROFILE)

  Invalid / rejected credentials
    Replace the credentials s3cab is using, by their source:
    - the set's env file: re-enter the key + secret with
      's3cab provider --keys <set>', or re-check a temporary
      AWS_SESSION_TOKEN in your shell (no stray quotes or spaces)
    - a profile: renew it, and confirm AWS_PROFILE names the right one
    - SSO: run 'aws sso login' again

  Signature mismatch
    Almost always a wrong secret, region, or endpoint:
    - confirm AWS_SECRET_ACCESS_KEY is correct and complete
    - confirm AWS_REGION matches the bucket's region
    - non-AWS providers: confirm the endpoint (AWS_ENDPOINT_URL_S3) matches
      your provider — a wrong endpoint/region is the classic Cloudflare R2 /
      Backblaze B2 trap

  Permission denied (signed in, but not allowed)
    - on AWS, run 's3cab aws <bucket>' for the exact least-privilege policy
    - on another provider, grant the token list + read/write on the bucket

  Clock out of sync
    S3 rejects requests whose time drifts too far. Sync your clock:
    - Windows: Settings > Time & language > Date & time > Sync now
    - macOS:   sudo sntp -sS time.apple.com
    - Linux:   sudo timedatectl set-ntp true

Full guide: https://github.com/allens/s3cab#authentication`,
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
      unset: {
        type: "string",
        description: "Remove a setting: profile, endpoint, region, or keys",
      },
    },
    exec: (options, [set] = []) => provider(set, options),
    render: renderText,
  },
  setup: {
    summary: "Create a backup set",
    examples: ["s3cab setup photos C:\\Users\\me\\Photos --bucket my-backups"],
    args: {
      set: {
        required: true,
        description: "The backup set to create",
      },
      directory: {
        variadic: true,
        description: "The directories that make up the set",
      },
    },
    options: {
      bucket: {
        type: "string",
        short: "b",
        description: "The S3 bucket to back this set up to",
      },
    },
    exec: (options, [name, ...directories] = []) =>
      setup(name, directories, options),
    render: renderSetup,
  },
  reattach: {
    summary: "Reattach this machine to an existing backup set",
    examples: ["s3cab reattach photos --bucket my-backups"],
    args: {
      set: {
        required: true,
        description: "The existing backup set to reattach to",
      },
    },
    options: {
      bucket: {
        type: "string",
        short: "b",
        description: "The S3 bucket holding the set",
      },
    },
    exec: (options, [name, ...directories] = []) =>
      reattach(name, directories, options),
    render: renderSetup,
  },

  // ── Backup & restore (docs/design/backup.md) ───────────────────────────
  backup: {
    group: "Backup & restore",
    summary: "Back up a set to the cloud",
    examples: ["s3cab backup", "s3cab backup photos"],
    args: {
      set: { description: "The backup set to back up (default: the only set)" },
    },
    exec: (options, [set] = []) => backup(set, options),
    render: renderBackup,
  },
  restore: {
    summary: "Restore files from a backup",
    examples: [
      "s3cab restore photos",
      "s3cab restore photos C:\\Users\\me\\Photos\\beach.jpg",
      "s3cab restore photos --output D:\\recovered",
    ],
    args: {
      set: { required: true, description: "The backup set to restore" },
      path: {
        variadic: true,
        description:
          "Specific files or directories to restore (default: everything)",
      },
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
        description: `Restore under this directory (as <output>${sep}<directory-name>${sep}…) instead of the original locations`,
      },
    },
    exec: (options, [set, ...paths] = []) => restore(set, paths, options),
    render: renderRestore,
  },
  verify: {
    summary: "Check that a repository's backups are complete and undamaged",
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
  delete: {
    summary: "Delete one snapshot from a backup",
    examples: ["s3cab delete photos --snapshot 2026-06-12T0915"],
    args: {
      set: {
        required: true,
        description: "The backup set the snapshot belongs to",
      },
    },
    options: {
      snapshot: {
        type: "string",
        short: "s",
        description: "Which snapshot to delete (required)",
      },
    },
    exec: (options, [set] = []) => deleteSnapshot(set, options),
    render: renderDelete,
  },
  cleanup: {
    summary: "Reclaim storage held by objects no snapshot references",
    examples: ["s3cab cleanup my-backups", "s3cab cleanup my-backups --delete"],
    args: {
      bucket: {
        required: true,
        description: "The repository's S3 bucket to clean up",
      },
    },
    options: {
      delete: {
        type: "boolean",
        description:
          "Actually delete the orphaned objects (default: a dry run that only reports)",
      },
    },
    exec: (options, [bucket] = []) => cleanup(bucket, options),
    render: renderCleanup,
  },

  // ── Diagnostics ─────────────────────────────────────────────────────────
  hashes: {
    group: "Advanced",
    summary: "List a repository's stored object hashes (one per line)",
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
    summary: "Upload a file or a snapshot's objects to a set's store",
    examples: [
      "s3cab upload photos --file C:\\Users\\me\\big.iso",
      "s3cab upload photos --snapshot 2026-06-12T0915",
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
    args: {
      set: { description: "The backup set to list (default: the only set)" },
    },
    exec: (_options, [set] = []) => tree(set),
    render: renderLines,
  },
  prop: {
    summary: "Show a file's hash, size, and modified time",
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
