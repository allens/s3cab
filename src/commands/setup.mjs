import { realpathSync, statSync } from "node:fs";
import { hostname } from "node:os";
import { ParseArgsError, isENOENT, requireArg } from "../lib/error.mjs";
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
 * `setup <name> <directory>... --bucket <b>` claims the name in the bucket
 * ("first person wins") by atomically writing the remote `info` marker, then
 * writes the local set and publishes its config (`dirs.txt`/`exclude.txt`) to
 * `sets/<name>/`. A name already claimed by another machine is refused with the
 * owner and a `reattach` suggestion. `--bucket` is required (ADR-0026). It
 * touches S3 (the claim/publish), which is why this is async; the read commands
 * (`list`/`snapshot`/`compare`/`tree`) stay offline once a set exists.
 *
 * @param {string} [name] - The set's name (required)
 * @param {string[]} [directories] - The member directories (required)
 * @param {object} [options]
 * @param {string} [options.bucket] - The S3 bucket to back the set up to (required)
 * @returns {Promise<BackupSet>} The set as stored
 */
export async function setup(name, directories = [], options = {}) {
  if (name === undefined) {
    // A distinct undefined-check (not requireArg) so an *empty* string still
    // routes to validateSetName below as invalid, not "missing".
    throw new ParseArgsError("Missing required argument: <set>", {
      argName: "set",
    });
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
      `  s3cab setup <new-name> <directory>... --bucket ${set.bucket}`,
  );
};

/**
 * Resolve member directories to canonical absolute paths (what `dirs.txt` stores),
 * verifying each exists and is a directory. Pure-local and cheap, so `setup` runs
 * it *before* any S3 touch — a bad directory fails fast without claiming a name.
 * @param {string[]} directories
 * @returns {string[]}
 */
function resolveDirectories(directories) {
  return directories.map((directory) => {
    let real;
    try {
      real = realpathSync.native(directory);
    } catch (error) {
      if (isENOENT(error)) {
        throw new Error(`Directory not found: ${directory}`, { cause: error });
      }
      throw error;
    }
    if (!statSync(real).isDirectory()) {
      throw new Error(`Not a directory: ${directory}`);
    }
    return real;
  });
}

/** A minute-precision ISO 8601 stamp for the `info` marker's `CREATED` field. */
const nowStamp = () =>
  Temporal.Now.plainDateTimeISO().toString({ smallestUnit: "minutes" });

/**
 * The collision error a losing claim raises: name the owner and point at
 * `reattach` as the way to take the set over on this machine.
 * @param {string} name
 * @param {string} bucket
 * @param {import("../lib/set-marker.mjs").SetInfo} [info]
 */
const collisionError = (name, bucket, info) => {
  // Only the fields actually present — a corrupted/partial marker (empty OWNER
  // or CREATED) must not print "(owner: , created )".
  const parts = [];
  if (info?.owner) {
    parts.push(`owner: ${info.owner}`);
  }
  if (info?.created) {
    parts.push(`created ${info.created}`);
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
 * @param {{ bucket?: string }} options
 * @returns {Promise<BackupSet>}
 */
async function create(name, directories, options) {
  requireArg(directories.length, "directory");
  // Resolve directories (local, cheap) before the --bucket check so a bad directory
  // reports "Directory not found" regardless of whether a bucket was given.
  const dirs = resolveDirectories(directories);
  if (!options.bucket) {
    // A missing required argument (like the missing-directory check), so
    // ParseArgsError — the CLI prints usage. `--bucket` is an option, not a
    // positional, so it's spelled out here rather than via requireArg; argName
    // lets the dispatcher gloss it with the registry description (ADR-0038).
    throw new ParseArgsError("Missing required argument: --bucket", {
      argName: "bucket",
    });
  }
  const bucket = options.bucket;

  // Claim the name before writing anything locally ("first person wins"). The
  // set env doesn't exist yet; the user env loaded at the entry point supplies
  // the S3 client's credentials/region.
  const won = await claimRemoteSet(bucket, name, {
    owner: hostname(),
    created: nowStamp(),
  });
  if (!won) {
    const info = await readRemoteInfo(bucket, name);
    throw collisionError(name, bucket, info);
  }

  const set = writeSet(name, { dirs, bucket });
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
