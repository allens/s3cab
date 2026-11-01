// The home page's terminal recording, made by every docs build from what
// s3cab prints, so a wording change can't leave it stale. The same split as
// test/doc-examples.test.mjs: a local command is a real run of the CLI against
// snapshots built to the scenario, and what it prints to stdout; a cloud
// command, which can't run without a bucket, is its own renderer for a result
// built to the scenario, after the notice every cloud command opens with.
//
// The docs' story (test/helpers/story.mjs): `photos`' first backup, a deleted
// beach.jpg got back from it, and after the next morning's tidy-up, what has
// changed.

import { mkdtempDisposable } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commands } from "../../src/commands.mjs";
import { authNotice } from "../../src/lib/s3.mjs";
import {
  firstBackup,
  restoreResult,
  storySet,
} from "../../test/helpers/photos-set.mjs";
import { sets, timeline } from "../../test/helpers/story.mjs";

/** @import { Command } from "../../src/commands.mjs" */
/** @import { BackupResult } from "../../src/commands/backup.mjs" */
/** @import { RestoreResult } from "../../src/lib/restore.mjs" */
/** @import { Step } from "./cast.mjs" */

/**
 * What the CLI prints for a cloud command whose result is `result`.
 * @param {string} command
 * @param {"backup" | "restore"} name
 * @param {BackupResult | RestoreResult} result
 * @returns {Step}
 */
const cloud = (command, name, result) => ({
  command,
  output: `${authNotice({})}\n${/** @type {Command} */ (commands[name]).render(result, { color: false })}\n`,
});

/** The recording's steps. */
export async function recording() {
  await using dir = await mkdtempDisposable(
    join(tmpdir(), "s3cab-recordings-"),
  );
  const { run } = await storySet(dir.path, timeline[1]?.name ?? "");
  /**
   * @param {string} command
   * @returns {Step}
   */
  const local = (command) => {
    const { status, stdout, stderr } = run(...command.split(" ").slice(1));
    if (status !== 0) {
      throw new Error(`'${command}' exited ${status}:\n${stderr}`);
    }
    return { command, output: stdout };
  };
  const beach = join("~", sets.photos.folder, "beach.jpg");
  return [
    cloud("s3cab backup", "backup", firstBackup),
    cloud(
      `s3cab restore --set photos ${beach}`,
      "restore",
      restoreResult({ snapshot: firstBackup.snapshot, restored: [beach] }),
    ),
    local("s3cab list"),
    local("s3cab compare photos"),
  ];
}
