import { loadSet } from "../lib/env.mjs";
import { ParseArgsError, requireArg } from "../lib/error.mjs";
import { promptYesNo } from "../lib/prompt.mjs";
import { deleteRemoteSnapshot, listRemoteSnapshots } from "../lib/remote.mjs";
import { isInteractive } from "../lib/style.mjs";

/**
 * Remove one remote snapshot — the retention **primitive** (docs/design/backup.md).
 * `s3cab delete <set> --snapshot <name>` deletes just that snapshot object from
 * `snapshots/<set>/`; the file content it referenced stays under `objects/`.
 * Reclaiming objects nothing references any more is `cleanup`'s job (the output
 * says so), so `delete` never touches `objects/`. (Local snapshots need no
 * command: the files are the API — delete the file.)
 *
 * The set name is **required** — no sole-set default, matching `restore`
 * ([ADR-0040](../../docs/adr/0040-restore-requires-set-name.md)): a destructive
 * command should never guess its target. On a **TTY** it confirms with a y/N
 * prompt naming the snapshot, set, and bucket (s3cab's first interactive prompt,
 * shared with `cleanup --delete`); a **non-interactive** run proceeds — naming
 * `--snapshot` is the explicit intent, and clig.dev forbids blocking a script on
 * a prompt. The snapshot is confirmed to exist first, so a typo gets a helpful
 * error (and the prompt names a real target) rather than a silent no-op
 * (`DeleteObject` is idempotent).
 *
 * @typedef {Object} DeleteResult
 * @property {string} set - The set the snapshot belonged to
 * @property {string} snapshot - The snapshot named for deletion
 * @property {boolean} deleted - False only when the user declined the confirmation
 *
 * @param {string} [setName] - The backup set the snapshot belongs to (required)
 * @param {{ snapshot?: string }} [options] - `snapshot` = the name to delete (required)
 * @returns {Promise<DeleteResult>}
 */
export async function deleteSnapshot(setName, options = {}) {
  requireArg(setName, "set");
  const name = options.snapshot;
  if (!name) {
    // `--snapshot` is an option, not a positional, so it's spelled out here
    // rather than via requireArg; argName lets the dispatcher gloss it with the
    // registry description (ADR-0038). A usage error → exit 2.
    throw new ParseArgsError("Missing required argument: --snapshot", {
      argName: "snapshot",
    });
  }

  // Resolve the set and apply its env layer (its bucket + auth) over the ambient
  // shell (ADR-0022/0055 — the one s3cab layer).
  const set = loadSet(setName);

  // Confirm the snapshot exists remotely, so the prompt names a real target and
  // a typo is an actionable error rather than a silent idempotent no-op.
  const remote = await listRemoteSnapshots(set.bucket, set.name);
  if (!remote.includes(name)) {
    throw new Error(
      `Snapshot '${name}' is not backed up for set '${set.name}'.\n` +
        (remote.length
          ? `Backed-up snapshots:\n${remote.map((n) => `  ${n}`).join("\n")}\n`
          : `That set has no remote snapshots yet.\n`) +
        `List them with: s3cab list ${set.name} --remote`,
    );
  }

  // TTY → confirm; non-interactive → proceed on the explicit --snapshot.
  if (isInteractive(process.stdin)) {
    const ok = await promptYesNo(
      `Delete snapshot '${name}' from set '${set.name}' (bucket ${set.bucket})? This cannot be undone.`,
    );
    if (!ok) {
      // Cancelling is a normal outcome, not an error — exit 0. Guidance to
      // stderr; the result on stdout records that nothing was deleted.
      console.warn("Cancelled — nothing was deleted.");
      return { set: set.name, snapshot: name, deleted: false };
    }
  }

  await deleteRemoteSnapshot(set.bucket, set.name, name);

  // The objects the snapshot referenced are still stored — point at `cleanup`,
  // which reclaims whatever nothing references any more. Guidance → stderr.
  console.warn(
    `Deleted snapshot '${name}' from set '${set.name}'.\n` +
      `Objects it referenced are still stored; reclaim unreferenced ones with: ` +
      `s3cab cleanup ${set.bucket}`,
  );

  return { set: set.name, snapshot: name, deleted: true };
}
