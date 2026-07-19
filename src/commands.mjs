import { aws } from "./commands/aws.mjs";
import { backup } from "./commands/backup.mjs";
import { cleanup } from "./commands/cleanup.mjs";
import { compare } from "./commands/compare.mjs";
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
import { sep } from "node:path";
import { tree } from "./commands/tree.mjs";
import { upload } from "./commands/upload.mjs";
import { verify } from "./commands/verify.mjs";
import {
  renderBackup,
  renderCleanup,
  renderCompareResult,
  renderForget,
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
    examples: ["s3cab snapshot", "s3cab snapshot photos"],
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
Renamed and Moved entries read 'old.txt → new.txt'; an added file whose
content already existed elsewhere is noted '(duplicate of ...)'.
Full guide: https://s3cab.plantegral.com/guide/compare`,
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
    examples: [
      "s3cab aws my-backups",
      "s3cab aws my-backups --region eu-west-1 --profile admin",
    ],
    description: `It only PRINTS the steps — it never touches your account and needs no
credentials to run, so you can read the whole plan first. It emits a
CloudFormation template that stands up the bucket (versioning ON as your
safety net, and Retain-protected so a stack delete can't destroy it) plus a
least-privilege identity that can never permanently destroy backup history.
Deploy it, mint one access key, point s3cab at it.

Choosing an identity:
  (default)          a dedicated AWS IAM user with an access key
  --roles-anywhere   keyless, certificate-based access (recommended)

With --roles-anywhere it generates a machine-level CA + client certificate
under ~/.s3cab/roles-anywhere/ (the private key never leaves your machine),
emits a template embedding the public CA as a trust anchor, then captures the
deployed stack's ARNs back with:
  s3cab aws --roles-anywhere --save --from-stack s3cab-<bucket>

AWS only. For a non-AWS S3 provider (Cloudflare R2, Backblaze B2, Wasabi,
MinIO, …), run 's3cab help provider' for the setup steps instead. Signing in
with AWS IAM Identity Center (SSO)? It works through the standard credential
chain — no separate setup; see 's3cab help provider'.

Then create a backup set in it:
  s3cab setup --set <name> --bucket <bucket> <directory>...

Full guide: https://s3cab.plantegral.com/guide/aws`,
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
          "The deployed CloudFormation stack to read Roles Anywhere ARNs from (e.g. s3cab-<bucket>)",
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
    examples: [
      "s3cab provider --endpoint https://<account>.r2.cloudflarestorage.com --region auto",
      "s3cab provider --profile s3cab-backup",
      "s3cab provider",
    ],
    description: `Changes or shows how a set signs in to its storage provider — an AWS
profile, a custom S3 endpoint (any S3-compatible provider), a region, and
access keys. The initial setup is usually done when you create the set
('s3cab setup', same knobs); use this to change it later, or run it with no
flags to see the current setup.

Setting up a non-AWS S3 provider (Cloudflare R2, Backblaze B2, Wasabi,
MinIO, …):

1. Create your bucket in the provider's console (or its CLI).
2. Turn on object versioning if the provider supports it — your safety
   net, so a deleted or overwritten backup stays recoverable.
3. Create an access key / token scoped to that bucket, with read, write,
   delete, and list on its objects (R2: API Tokens; B2: Application Keys;
   Wasabi: sub-users).
4. Create the backup set, pointed at the provider in one command:
     s3cab setup --set <name> --bucket <bucket> --endpoint https://<your-endpoint> --region auto --keys <dir>...
   (--keys asks for the key + secret; some providers need a real region,
   e.g. us-east-1. Change these later with 's3cab provider'. s3cab drops
   AWS-only request features automatically when a custom endpoint is set.)

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

Full guide: https://s3cab.plantegral.com/guide/auth`,
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
      "s3cab restore --set photos",
      "s3cab restore --set photos C:\\Users\\me\\Photos\\beach.jpg",
      "s3cab restore --set photos --output D:\\recovered",
    ],
    args: {
      path: {
        variadic: true,
        description:
          "Specific files or directories to restore (default: everything)",
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
    exec: (options, paths = []) => restore(paths, options),
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
  forget: {
    summary: "Remove snapshots from a backup",
    examples: [
      "s3cab forget --set photos 2026-06-12T0915",
      "s3cab forget --set photos 2026-06-12T0915 2026-06-19T0902",
      "s3cab forget --set photos 2026-06-12T0915 --force",
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
          "Skip the unrestorable check and the confirmation (default: report what you could no longer restore, then ask)",
      },
    },
    exec: (options, snapshots = []) => forget(snapshots, options),
    render: renderForget,
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
    examples: ["s3cab tree", "s3cab tree photos"],
    args: {
      set: { description: "The backup set to list (default: the only set)" },
    },
    exec: (_options, [set] = []) => tree(set),
    render: renderLines,
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
