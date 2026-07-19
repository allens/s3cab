import { loadSet } from "../lib/env.mjs";
import { requireArg } from "../lib/error.mjs";
import { promptYesNo } from "../lib/prompt.mjs";
import { deleteRemoteSnapshot, listRemoteSnapshots } from "../lib/remote.mjs";
import { isInteractive } from "../lib/style.mjs";

/**
 * Remove remote snapshots — the retention **primitive** (docs/design/backup.md).
 * `s3cab delete --set <set> <snapshot>...` deletes just those snapshot objects
 * from `snapshots/<set>/`; the file content they referenced stays under `objects/`.
 * Reclaiming objects nothing references any more is `cleanup`'s job (the output
 * says so), so `delete` never touches `objects/`. (Local snapshots need no
 * command: the files are the API — delete the file.)
 *
 * Snapshots are the **bulk operand** and the set is addressed by `--set`
 * ([ADR-0062](../../docs/adr/0062-bulk-operands-positional-addressing-by-flag.md)):
 * several snapshots go in one run because the orphan check still to be built on
 * top of this is a whole-bucket scan, and one run pays it once
 * (docs/design/snapshot-deletion.md). That check, its report file and `--force`
 * are **not built yet** — today's run deletes what it is given, after one
 * confirmation.
 *
 * The set is **required** — no sole-set default, matching `restore`
 * ([ADR-0040](../../docs/adr/0040-restore-requires-set-name.md)): a destructive
 * command should never guess its target. On a **TTY** it confirms with a y/N
 * prompt naming the snapshots, set, and bucket (s3cab's first interactive prompt,
 * shared with `cleanup --delete`); a **non-interactive** run proceeds — naming
 * the snapshots is the explicit intent, and clig.dev forbids blocking a script on
 * a prompt. **Every** name is confirmed to exist before **any** is deleted, so a
 * typo gets a helpful error (and the prompt names real targets) rather than a
 * silent no-op (`DeleteObject` is idempotent) — and never a half-done run.
 *
 * @typedef {Object} DeleteResult
 * @property {string} set - The set the snapshots belonged to
 * @property {string[]} snapshots - The snapshots named for deletion, in the order given
 * @property {boolean} deleted - False only when the user declined the confirmation
 *
 * @param {string[]} [snapshots] - The snapshots to delete — the bulk operand (at least one)
 * @param {{ set?: string }} [options] - `set` = the backup set they belong to (required)
 * @returns {Promise<DeleteResult>}
 */
export async function deleteSnapshot(snapshots = [], options = {}) {
  requireArg(options.set, "set");
  requireArg(snapshots.length, "snapshot");

  // Resolve the set and apply its env layer (its bucket + auth) over the ambient
  // shell (ADR-0022/0055 — the one s3cab layer).
  const set = loadSet(options.set);

  // Confirm *every* named snapshot exists remotely before deleting *any*, so the
  // prompt names real targets and a typo is an actionable error rather than a
  // silent idempotent no-op (`DeleteObject` succeeds on a missing key). Checking
  // the whole selection up front is what stops a typo in the third name leaving
  // the first two already gone — the deletions below are not undoable.
  const remote = await listRemoteSnapshots(set.bucket, set.name);
  const missing = snapshots.filter((name) => !remote.includes(name));
  if (missing.length) {
    throw new Error(
      `${missing.length === 1 ? `Snapshot '${missing[0]}' is` : `Snapshots ${missing.map((n) => `'${n}'`).join(", ")} are`} ` +
        `not backed up for set '${set.name}'.\n` +
        (remote.length
          ? `Backed-up snapshots:\n${remote.map((n) => `  ${n}`).join("\n")}\n`
          : `That set has no remote snapshots yet.\n`) +
        `List them with: s3cab list ${set.name} --remote`,
    );
  }

  // TTY → confirm; non-interactive → proceed on the explicitly named snapshots.
  // **One prompt covers the whole run** (docs/design/snapshot-deletion.md): N
  // prompts in a feature built for bulk work is the pattern that trains people to
  // hold down `y`.
  if (isInteractive(process.stdin)) {
    const ok = await promptYesNo(
      `Delete ${describe(snapshots)} from set '${set.name}' (bucket ${set.bucket})? This cannot be undone.`,
    );
    if (!ok) {
      // Cancelling is a normal outcome, not an error — exit 0. Guidance to
      // stderr; the result on stdout records that nothing was deleted.
      console.warn("Cancelled — nothing was deleted.");
      return { set: set.name, snapshots, deleted: false };
    }
  }

  for (const name of snapshots) {
    await deleteRemoteSnapshot(set.bucket, set.name, name);
  }

  // The objects the snapshots referenced are still stored — point at `cleanup`,
  // which reclaims whatever nothing references any more. Guidance → stderr.
  // Saying *how much* is reclaimable is the orphan check's job, still to come
  // (docs/design/snapshot-deletion.md).
  console.warn(
    `Deleted ${describe(snapshots)} from set '${set.name}'.\n` +
      `Objects they referenced are still stored; reclaim unreferenced ones with: ` +
      `s3cab cleanup ${set.bucket}`,
  );

  return { set: set.name, snapshots, deleted: true };
}

/**
 * Name a selection of snapshots for a human: one is named outright, several are
 * counted and then listed, so the count leads in the confirmation prompt (the
 * number is the part you check before typing `y`).
 * @param {string[]} snapshots
 * @returns {string}
 */
const describe = (snapshots) =>
  snapshots.length === 1
    ? `snapshot '${snapshots[0]}'`
    : `${snapshots.length} snapshots (${snapshots.map((n) => `'${n}'`).join(", ")})`;
