import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { platform } from "node:process";
import { text } from "node:stream/consumers";
import { loadSet } from "../lib/env.mjs";
import { ParseArgsError, isENOENT, requireArg } from "../lib/error.mjs";
import { countOf } from "../lib/format.mjs";
import { foldsCase } from "../lib/path-match.mjs";
import { parseLines } from "../lib/read-lines.mjs";
import {
  chooseSnapshot,
  reroot,
  restoreTargets,
  selectTargets,
} from "../lib/restore.mjs";
import { isInteractive, shellCommand } from "../lib/style.mjs";

/** @import { BackupSet } from "../lib/sets.mjs" */
/** @import { RestoreResult } from "../lib/restore.mjs" */

// The `restore` command (docs/design/backup.md): pull a set's files back from the
// cloud. Remote-only by nature — local snapshots record only hashes; the file
// *content* lives solely in the bucket's `objects/<sha256>` store — so there is
// no `--remote` flag (like `status`).

/**
 * Restore a set's files from a remote backup (docs/design/backup.md). Reads the
 * chosen remote snapshot (latest, or `--snapshot <name>`) and writes each file
 * back to the **original absolute path** it was captured from, by
 * `restoreTargets`' rules: an existing file is skipped unless `--overwrite`, and
 * a file that can't be produced is reported while the rest carry on. What is
 * restored is named: paths, as arguments and/or a `--from-file` list (see
 * `selectEntries`), or `--all` for the whole snapshot, never by leaving the
 * paths out
 * ([ADR-0110](../../docs/adr/0110-restore-takes-paths-a-list-or-all.md)).
 *
 * `--output <dir>` re-roots instead of restoring to original locations: each
 * file lands at its full original path under it (see `reroot`). That recovers a
 * backup whose absolute paths don't fit this machine — a different drive
 * layout, or another OS entirely — and is the only mode that accepts
 * non-absolute-on-this-platform paths. Existing files there are skipped as
 * anywhere else, so an interrupted restore finishes by running it again.
 *
 * The set must have an existing remote backup. Unlike the everyday commands, the
 * set is required — no sole-set default (ADR-0040): restore is the rare,
 * carefully considered command, and requiring the name removes the set-or-path
 * ambiguity a leading optional positional would create. It is named by `--set`
 * rather than a positional because the paths are the bulk operand
 * ([ADR-0062](../../docs/adr/0062-bulk-operands-positional-addressing-by-flag.md)).
 *
 * @param {string[]} [paths] - Files or folders to restore, as backed up
 * @param {{ set?: string, snapshot?: string, all?: boolean, "from-file"?: string, overwrite?: boolean, output?: string, debug?: boolean }} [options] - `set` (required) is the backup set to restore
 * @returns {Promise<RestoreResult>}
 */
export async function restore(paths = [], options = {}) {
  requireArg(options.set, "set");
  const set = loadSet(options.set);
  const fromFile = options["from-file"];
  // A blank argument (an unset `"$path"`) names nothing. Passed on, it would
  // read as no filter at all, which is `--all`.
  const named = paths.filter((path) => path.trim() !== "");
  if (options.all && (named.length || fromFile !== undefined)) {
    throw new ParseArgsError(
      "--all restores the whole snapshot, so it takes no paths and no --from-file.",
    );
  }
  if (!options.all && named.length === 0 && fromFile === undefined) {
    throw nothingNamedError(set);
  }
  // Not `push(...list)`: a list of 200k lines overflows the call's arguments.
  const filters =
    fromFile === undefined
      ? named
      : named.concat(await readPathList(fromFile, set));
  if (!options.all && filters.length === 0) {
    throw new Error(
      `No paths to restore: ${fromFile === "-" ? "standard input" : `'${fromFile}'`} lists none.`,
    );
  }

  const { name, snapshot } = await chooseSnapshot(set, options.snapshot);
  const selected = selectTargets(snapshot, name, filters);

  // Where each snapshot path is written. `--output` re-roots under the chosen
  // dir (and so accepts any path, cross-OS included); otherwise files go back to
  // their original absolute location.
  if (options.output) {
    return restoreTargets({
      set,
      name,
      snapshot,
      selected,
      destFor: reroot(options.output),
      outDir: resolve(options.output),
      overwrite: options.overwrite,
    });
  }
  // Every target must be absolute on *this* platform before we touch the disk.
  // A snapshot captured on another OS (Windows paths on POSIX, say) or a
  // hand-edited one would otherwise write files relative to the cwd with
  // surprising names like `C:\Users\…` — refuse up front rather than scatter
  // them, and point at `--output` for the cross-OS case. On Windows that means
  // a Windows-shaped path: `isAbsolute` takes a POSIX `/home/…` too, on the
  // current drive, with any `\` in its names read as a separator.
  const notAbsolute = selected.targets.filter((path) =>
    platform === "win32" ? !foldsCase(path) : !isAbsolute(path),
  );
  if (notAbsolute.length) {
    throw new Error(
      `Snapshot '${name}' has ${countOf(notAbsolute.length, "path")} that ` +
        `${notAbsolute.length === 1 ? "isn't" : "aren't"} absolute ` +
        `on this system (e.g. ${notAbsolute.slice(0, 3).join(", ")}). The backup ` +
        `was likely made on a different OS; restore it here with --output <dir> ` +
        `to re-root under a directory you choose.`,
    );
  }
  return restoreTargets({
    set,
    name,
    snapshot,
    selected,
    destFor: (path) => path,
    overwrite: options.overwrite,
  });
}

/**
 * The usage error for a restore that names nothing: the whole set is the rarest
 * and largest restore, so it is `--all`, never what a forgotten path gives
 * (ADR-0110). The set's folders are listed because they are the likeliest
 * paths to copy.
 * @param {BackupSet} set
 */
function nothingNamedError(set) {
  const folders = set.dirs.length
    ? `Its folders:\n${set.dirs.map((dir) => `  ${dir}`).join("\n")}\n\n`
    : "";
  return new ParseArgsError(
    `Name what to restore from set '${set.name}': files or folders, a list of ` +
      `them, or --all for everything.\n${folders}` +
      [
        `${set.name} <path>...`,
        `${set.name} --from-file <file>`,
        `${set.name} --all`,
      ]
        .map((form) => `  ${shellCommand(`s3cab restore --set ${form}`)}`)
        .join("\n"),
  );
}

/**
 * The paths a `--from-file` list names, in `dirs.txt`'s format, so a set's own
 * list feeds it unchanged. `-` reads standard input, which must be a pipe: at a
 * terminal the read would wait for input nobody was asked to type.
 * @param {string} file - The `--from-file` value
 * @param {BackupSet} set
 * @returns {Promise<string[]>}
 */
async function readPathList(file, set) {
  if (file === "-") {
    if (isInteractive(process.stdin)) {
      throw new ParseArgsError(
        `--from-file - reads the paths to restore from a pipe, and nothing is ` +
          `piped in.\n\nPipe a list in, or name a file:\n` +
          `  ${shellCommand(`s3cab restore --set ${set.name} --from-file <file>`)}`,
      );
    }
    const piped = await text(process.stdin);
    return parseLines(piped);
  }
  try {
    const content = await readFile(file, "utf8");
    return parseLines(content);
  } catch (error) {
    if (!isENOENT(error)) {
      throw error;
    }
    throw new Error(
      `Can't read the paths to restore — there is no file '${file}' ` +
        `(--from-file).\n\nThe set's own list of folders is:\n  ${set.dirsPath}`,
      { cause: error },
    );
  }
}
