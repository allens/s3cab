import { realpathSync, statSync } from "node:fs";
import { hostname } from "node:os";
import { updateEnvFile } from "../lib/env-file.mjs";
import { isENOENT, MissingArgError, requireArg } from "../lib/error.mjs";
import { gatherProviderConfig } from "../lib/provider.mjs";
import { readSigningIdentity } from "../lib/roles-anywhere.mjs";
import { parseLines } from "../lib/read-lines.mjs";
import {
  claimRemoteSet,
  pushSetConfig,
  readRemoteInfo,
} from "../lib/set-marker.mjs";
import {
  listSets,
  readSet,
  readSetExclude,
  seedStarterExclude,
  starterExclude,
  validateBucketName,
  validateSetName,
  writeSet,
} from "../lib/sets.mjs";

/** @import { BackupSet } from "../lib/sets.mjs" */
/** @import { SetInfo } from "../lib/set-marker.mjs" */

/**
 * The set-creation verb (docs/design/backup.md, ADR-0036, ADR-0052, ADR-0053) —
 * create a **new** backup set on this machine. Adopting a set that *already*
 * exists in the cloud (a replacement/recovery machine) is `reattach`'s job now
 * ([ADR-0053](../../docs/adr/0053-reattach-command.md) split the old
 * `setup --inherit` out — `setup` creates, `reattach` adopts). Listing what you
 * have is `list`'s job (ADR-0036 split that on the read/write seam); `setup` only
 * *writes*.
 *
 * There is no "update mode" (ADR-0052 retired it): a set's member directories
 * live in its public `dirs.txt`, edited directly like `exclude.txt`, so
 * re-running `setup` on a set that already exists here is an error, not a silent
 * mutation. A set's name is its whole identity (ADR-0024) — local handle, local
 * directory, and remote namespace.
 *
 * `setup --set <name> --bucket <b> <directory>...` claims the name in the bucket
 * ("first person wins") by atomically writing the remote `info` marker, then
 * writes the local set and publishes its config (`dirs.txt`/`exclude.txt`) to
 * `sets/<name>/`. A name already claimed by another machine is refused with the
 * owner and a `reattach` suggestion. `--bucket` is required (ADR-0026). It
 * touches S3 (the claim/publish), which is why this is async; the read commands
 * (`list`/`snapshot`/`compare`/`tree`) stay offline once a set exists.
 *
 * The provider knobs (`--profile`/`--endpoint`/`--region`/`--keys`/`--roles-anywhere`,
 * shared with `provider`) may configure how the set signs in — needed for the very
 * first claim when there is no ambient AWS setup (e.g. a non-AWS provider, whose
 * creds can't be set per-set before the set exists — ADR-0055). They authenticate
 * the claim and are saved to the set's env on a win; `provider` changes them later.
 * `--roles-anywhere` points the set at the machine's keyless certificate identity
 * (which `s3cab aws --roles-anywhere` must already have stood up — ADR-0057).
 *
 * @param {string[]} [directories] - The member directories (required) — the bulk
 *   operand, so they are the positionals and the set is addressed by `--set`
 *   ([ADR-0062](../../docs/adr/0062-bulk-operands-positional-addressing-by-flag.md))
 * @param {{ set?: string, bucket?: string, profile?: string, endpoint?: string,
 *   region?: string, keys?: boolean, "roles-anywhere"?: boolean }} [options] -
 *   `set` (required) names the set and `bucket` (required) is its destination;
 *   `profile`/`endpoint`/`region`/`keys`/`roles-anywhere` are the provider knobs
 *   shared with `provider` — how the set signs in.
 * @returns {Promise<BackupSet>} The set as stored
 */
export async function setup(directories = [], options = {}) {
  const name = options.set;
  if (name === undefined) {
    // A distinct undefined-check (not requireArg) so an *empty* string still
    // routes to validateSetName below as invalid, not "missing".
    throw new MissingArgError("set");
  }

  validateSetName(name);
  // Validate when --bucket is *given at all* (even ""), so an explicit empty
  // value fails fast rather than being treated as "not given".
  if (options.bucket !== undefined) {
    validateBucketName(options.bucket);
  }

  // A set that already exists here can't be re-created (and isn't updated —
  // ADR-0052); adopting an existing *remote* set is `reattach`, not `setup`.
  if (listSets().includes(name)) {
    throw existsError(name);
  }
  return create(name, directories, options);
}

/**
 * The error a plain `setup <name> …` raises when the set already exists here.
 * There is no update mode (ADR-0052): a set's directories are edited in its public
 * `dirs.txt` (like `exclude.txt`), and a fresh scope belongs in a *new* set — so
 * point at both, rather than silently re-pointing an existing set's contents.
 * @param {string} name
 */
const existsError = (name) => {
  const set = readSet(name);
  return new Error(
    `Backup set '${name}' already exists on this machine.\n` +
      `To change what it backs up, edit its files directly:\n` +
      `  ${set.dirsPath}   (directories)\n` +
      `  ${set.excludePath}   (exclude patterns)\n` +
      `To back up a different set of directories, create a new set:\n` +
      `  s3cab setup --set <new-name> --bucket ${set.bucket} <directory>...`,
  );
};

/**
 * The error `setup --roles-anywhere` raises when this machine has no complete
 * Roles Anywhere identity yet: RA is a machine-level identity stood up by
 * `s3cab aws` (ADR-0057), so point at that recipe rather than let the claim fail
 * obscurely on a half-built identity (ADR-0030).
 * @param {string} bucket
 */
const rolesAnywhereNotReadyError = (bucket) =>
  new Error(
    `Set up the keyless Roles Anywhere identity before creating a set that uses it.\n` +
      `This machine has no complete Roles Anywhere identity yet. Run:\n` +
      `  s3cab aws ${bucket} --roles-anywhere\n` +
      `then deploy the printed template and capture its ARNs (use the stack name\n` +
      `you deployed it under):\n` +
      `  s3cab aws --roles-anywhere --save --from-stack <stack>`,
  );

/**
 * "Not a directory", the answer to two different questions — the path resolved and
 * turned out to be a file, or it wouldn't resolve *and* isn't a directory either.
 * One factory so both say it the same way (src/lib/error.mjs's taxonomy: a reused
 * message earns one).
 * @param {string} directory - The path as the user typed it
 */
const notADirectoryError = (directory) =>
  new Error(`Not a directory: ${directory}`);

/**
 * The error a directory the OS won't canonicalize raises: it is there, it is a
 * directory, but `realpathSync.native` can't say where it really is. Measured case
 * (2026-08-11, proposals/filesystem-edge-cases.md): an unlocked OneDrive Personal
 * Vault, a junction onto a volume GUID with no mount point, where
 * `GetFinalPathNameByHandle` fails — but nothing here is vault-specific, so the
 * message names the *shape* of the problem rather than one product. It used to read
 * `Directory not found`, which is the one thing that is definitely untrue of it.
 *
 * The wording claims only what the caller checked — that it is there, and that it
 * is a directory. Not that it *lists*: the vault does, but proving that means a
 * `readdir` of a directory that could hold a hundred thousand entries, to add a
 * clause the user doesn't need.
 * @param {string} directory - The path as the user typed it
 * @param {string} name - The set being created
 * @param {string | undefined} bucket - Its bucket, if `--bucket` was given
 * @param {unknown} cause - The `ENOENT` from `realpathSync.native`
 */
const unresolvableDirectoryError = (directory, name, bucket, cause) =>
  new Error(
    `Can't add '${directory}' to backup set '${name}': the folder is there, ` +
      `but this computer won't say where it really is (resolving the path reports ` +
      `"no such file or directory").\n` +
      `A set stores each folder by its resolved location, so one that won't resolve ` +
      `can't be a member. This is usually a link into storage with no ordinary path ` +
      `of its own — a protected vault, or a drive with no letter or mount point.\n` +
      `To create the set, name a folder that has an ordinary path:\n` +
      `  s3cab setup --set ${name} --bucket ${bucket || "<bucket>"} <directory>...`,
    { cause },
  );

/**
 * Resolve member directories to canonical absolute paths (what `dirs.txt` stores),
 * verifying each exists and is a directory. Pure-local and cheap, so `setup` runs
 * it *before* any S3 touch — a bad directory fails fast without claiming a name.
 * @param {string[]} directories
 * @param {string} name - The set being created (named in the errors below)
 * @param {string} [bucket] - Its bucket, if `--bucket` was given (checked after this)
 * @returns {string[]}
 */
function resolveDirectories(directories, name, bucket) {
  return directories.map((directory) => {
    let real;
    try {
      real = realpathSync.native(directory);
    } catch (error) {
      if (isENOENT(error)) {
        // `ENOENT` from realpath means one of three different things, so ask what
        // is actually there before saying anything about it: nothing (the typo,
        // the unplugged drive), a non-directory, or a real directory the OS just
        // won't canonicalize. `stat`, not `existsSync`, because the last of those
        // says "folder" and has to have earned it.
        let stats;
        try {
          stats = statSync(directory);
        } catch {
          throw new Error(`Directory not found: ${directory}`, {
            cause: error,
          });
        }
        if (!stats.isDirectory()) {
          throw notADirectoryError(directory);
        }
        throw unresolvableDirectoryError(directory, name, bucket, error);
      }
      throw error;
    }
    if (!statSync(real).isDirectory()) {
      throw notADirectoryError(directory);
    }
    return real;
  });
}

/**
 * The `info` marker's `CREATED` value: a full UTC instant
 * ([ADR-0072](../../docs/adr/0072-timestamps-utc-in-files-local-in-names.md)).
 * It is a record, never typed and never sorted, so a fully-qualified form costs
 * no UX. What a *user* sees is rendered down to a date by `collisionError`.
 */
const nowStamp = () =>
  Temporal.Now.instant().toString({ smallestUnit: "millisecond" });

/**
 * The collision error a losing claim raises: name the owner and point at
 * `reattach` as the way to take the set over on this machine.
 * @param {string} name
 * @param {string} bucket
 * @param {SetInfo} [info]
 */
const collisionError = (name, bucket, info) => {
  // Only the fields actually present — a corrupted/partial marker (empty OWNER
  // or CREATED) must not print "(owner: , created )".
  const parts = [];
  if (info?.owner) {
    parts.push(`owner: ${info.owner}`);
  }
  if (info?.created) {
    // Just the date. The file keeps the full instant, but a millisecond UTC
    // timestamp mid-sentence is the sort of jargon ADR-0030 keeps out of a
    // headline, and "roughly when" is all this line needs.
    parts.push(`created ${info.created.slice(0, 10)}`);
  }
  const detail = parts.length ? ` (${parts.join(", ")})` : "";
  return new Error(
    `Backup set '${name}' is already set up in bucket '${bucket}'${detail}.\n` +
      `To take it over on this machine:\n` +
      `  s3cab reattach ${name} --bucket ${bucket}`,
  );
};

/**
 * Create a new set: claim the name in the bucket, then write it locally and
 * publish its config. Directories and `--bucket` are both required here.
 * @param {string} name
 * @param {string[]} directories
 * @param {{ bucket?: string, profile?: string, endpoint?: string, region?: string, keys?: boolean, "roles-anywhere"?: boolean }} options
 * @returns {Promise<BackupSet>}
 */
async function create(name, directories, options) {
  requireArg(directories.length, "directory");
  // Resolve directories (local, cheap) before the --bucket check so a bad directory
  // reports itself regardless of whether a bucket was given — which is why the
  // errors below take the bucket as possibly-undefined.
  const dirs = resolveDirectories(directories, name, options.bucket);
  requireArg(options.bucket, "bucket");
  const bucket = options.bucket;

  // Roles Anywhere is a *machine* identity generated up front by
  // `s3cab aws <bucket> --roles-anywhere` (+ `--save`); `setup --roles-anywhere`
  // only points a new set at it. So it must already be complete — otherwise the
  // claim below would authenticate through a half-built identity and fail
  // obscurely. Fail fast with the exact setup commands instead (ADR-0030).
  const rolesAnywhere = options["roles-anywhere"];
  if (rolesAnywhere && !readSigningIdentity()) {
    throw rolesAnywhereNotReadyError(bucket);
  }

  // Gather the provider knobs (validate, prompt for keys, reject two credential
  // modes at once — shared with `provider`, lib/provider.mjs) and merge them into
  // the environment so the remote claim below can authenticate. A set's
  // credentials can't be configured before the set exists (ADR-0055), so `setup`
  // carries them here for that first S3 touch; with no knobs, the claim runs on the
  // ambient AWS chain (or, in RA mode, the machine's certificate identity).
  const { updates } = await gatherProviderConfig({
    ...options,
    rolesAnywhere,
  });
  Object.assign(process.env, updates);

  // Claim the name before writing anything locally ("first person wins"). If the
  // claim loses, nothing local was written — the gathered config lives only in
  // this process's environment, so there is nothing to roll back.
  const won = await claimRemoteSet(bucket, name, {
    owner: hostname(),
    created: nowStamp(),
  });
  if (!won) {
    const info = await readRemoteInfo(bucket, name);
    throw collisionError(name, bucket, info);
  }

  const set = writeSet(name, { dirs, bucket });
  // Persist the provider config to the new set's env now the claim has won, so
  // later commands sign in the same way without re-supplying it.
  if (Object.keys(updates).length > 0) {
    updateEnvFile(set.envPath, updates);
  }
  // The starter exclude file is a birth gift for *new* sets only (`reattach`
  // reproduces an existing set exactly, never silently narrowing what it backs
  // up), seeded before `pushSetConfig` so the published remote config matches.
  // The notice is what makes it findable — its header is the `help exclude`
  // discovery hook — and prints the real resolved path (honours an S3CAB_HOME
  // override), not a ~ template.
  if (seedStarterExclude(name)) {
    const skipped = parseLines(starterExclude)
      .map((pattern) => `  ${pattern}`)
      .join("\n");
    console.warn(
      `Wrote a starter exclude file — these patterns are skipped by default:\n` +
        `${skipped}\n` +
        `Edit ${set.excludePath} to change what's skipped — see 's3cab help exclude'.`,
    );
  }
  await pushSetConfig(bucket, name, { dirs, exclude: readSetExclude(name) });
  return set;
}
