import { lstatSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadSet } from "../lib/env.mjs";
import { ParseArgsError, requireArg } from "../lib/error.mjs";
import { foldsCase } from "../lib/path-match.mjs";
import {
  chooseSnapshot,
  extractTo,
  itemName,
  restoreTargets,
  selectTargets,
} from "../lib/restore.mjs";

/** @import { RestoreResult } from "../lib/restore.mjs" */

/**
 * Copy one file or folder out of a set's remote backup into a folder, under its
 * own last name or `--name`
 * ([ADR-0111](../../docs/adr/0111-extract-copies-one-item-out.md)): the
 * everyday "let me look at last month's copy", where `restore --output` would
 * land it at its full path. The folder is `--output`, or the current one.
 *
 * An existing `<output>/<name>` is refused before the snapshot is read, unless
 * `--overwrite`: skipping it, as `restore` skips, would hand the user the old
 * file as if it were the extracted one. Past that check every rule is
 * `restore`'s (`restoreTargets`), the report and exit codes included, and any
 * snapshot extracts on any machine, as `restore --output` does.
 *
 * @param {string[]} [paths] - The one file or folder to extract, as backed up
 * @param {{ set?: string, snapshot?: string, output?: string, name?: string, overwrite?: boolean }} [options] - `set` (required) is the backup set to extract from
 * @returns {Promise<RestoreResult>}
 */
export async function extract(paths = [], options = {}) {
  requireArg(options.set, "set");
  const [item, ...more] = paths.filter((path) => path.trim() !== "");
  requireArg(item, "path");
  if (more.length) {
    throw new ParseArgsError(
      "extract copies one file or folder per run: run it once for each.",
    );
  }
  const outDir = resolve(options.output ?? ".");
  const name = options.name ?? itemName(item);
  if (name === undefined) {
    throw new ParseArgsError(
      `'${item}' is a root, with no name of its own: give the copy one with --name.`,
    );
  }
  // One folder level, so the copy lands in `outDir` and nowhere else. A `\` is
  // a separator only where the folder is a Windows one.
  if (
    name === "" ||
    name === "." ||
    name === ".." ||
    name.includes("/") ||
    (foldsCase(outDir) && name.includes("\\"))
  ) {
    throw new ParseArgsError(
      `'${name}' can't name the copy: a name is one file or folder name, not a path. ` +
        `Give it one with --name.`,
    );
  }
  const to = join(outDir, name);
  if (!options.overwrite && lstatSync(to, { throwIfNoEntry: false })) {
    throw new Error(
      `Extracting '${item}' would replace '${to}', which is already there.\n\n` +
        `Run it again with one of:\n` +
        `  --name <name>       to give the copy another name\n` +
        `  --output <folder>   to put it in another folder\n` +
        `  --overwrite         to replace what's there`,
    );
  }

  const set = loadSet(options.set);
  const { name: snapshotName, snapshot } = await chooseSnapshot(
    set,
    options.snapshot,
  );
  const result = await restoreTargets({
    set,
    name: snapshotName,
    snapshot,
    selected: selectTargets(snapshot, snapshotName, [item]),
    destFor: extractTo(item, to),
    outDir,
    overwrite: options.overwrite,
  });
  return { ...result, to };
}
