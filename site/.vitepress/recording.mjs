// The home page's terminal recording, made by every docs build from what
// s3cab prints, so a wording change can't leave it stale. The same split as
// test/doc-examples.test.mjs: a local command is a real run of the CLI against
// snapshots built to the scenario, and what it prints to stdout; a cloud
// command, which can't run without a bucket, is its own renderer for a result
// built to the scenario, after the notice every cloud command opens with.
//
// One story, the README's: `photos` backed up to `my-backups` on 12 November,
// a deleted beach.jpg got back from it, and a week later, what has changed.

import { mkdtempDisposable } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commands } from "../../src/commands.mjs";
import { authNotice } from "../../src/lib/s3.mjs";
import {
  file,
  photosSet,
  restoreResult,
} from "../../test/helpers/photos-set.mjs";

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

/** @type {BackupResult} */
const firstBackup = {
  set: "photos",
  bucket: "my-backups",
  snapshot: "20251112T0915",
  files: 1_312,
  bytes: 4_200_000_000,
  hashedFiles: 1_312,
  hashedBytes: 4_200_000_000,
  scanMs: 161_000,
  candidates: 1_240,
  uploaded: 1_240,
  uploadedBytes: 4_200_000_000,
  uploadMs: 368_000,
  errors: [],
  excludeSuggestions: [],
  excludePath: "",
  comparison: null,
};

/** The recording's steps. */
export async function recording() {
  await using dir = await mkdtempDisposable(
    join(tmpdir(), "s3cab-recordings-"),
  );
  const { run } = await photosSet(dir.path, {
    "20251112T0915": [
      file("2024/IMG_001.jpg", "i", 3_400_000),
      file("beach.jpg", "b", 4_900_000),
      file("notes.txt", "n", 2_100),
    ],
    "20251119T0915": [
      file("2024/sorted/IMG_001.jpg", "i", 3_400_000),
      file("2025/new.jpg", "j", 812_000),
      file("beach.jpg", "b", 4_900_000),
      file("notes.txt", "N", 2_300),
    ],
  });
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
  const beach = join("~", "Pictures", "beach.jpg");
  return [
    cloud("s3cab backup", "backup", firstBackup),
    cloud(
      `s3cab restore --set photos ${beach}`,
      "restore",
      restoreResult({ snapshot: "20251112T0915", restored: [beach] }),
    ),
    local("s3cab list"),
    local("s3cab compare photos"),
  ];
}
