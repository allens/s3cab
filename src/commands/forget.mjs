import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { loadSet } from "../lib/env.mjs";
import { requireArg } from "../lib/error.mjs";
import { s3cabDir } from "../lib/home.mjs";
import { formatMoment, localMoment } from "../lib/format.mjs";
import {
  formatForcedReport,
  formatUnrestorableReport,
  formatUnrestorableSummary,
  planUnrestorable,
} from "../lib/unrestorable.mjs";
import { promptYesNo } from "../lib/prompt.mjs";
import {
  deleteRemoteSnapshot,
  listRemoteSnapshots,
  referencedObjects,
} from "../lib/remote.mjs";
import { isInteractive } from "../lib/style.mjs";

// The **preview**: a transient decision aid, overwritten every run, in the s3cab
// root because it belongs to no set for longer than one command
// (docs/design/snapshot-deletion.md).
const PREVIEW_FILE = "forget-unrestorable-preview.txt";

/**
 * The **audit record** written into the set's own directory once a deletion
 * actually happens: `forget-unrestorable-<timestamp>.txt`. These accumulate on
 * purpose — the preview is a decision aid and is worthless once decided, but a
 * record of a destructive act is an audit trail, and audit trails are supposed to
 * accumulate. No cap: they are a few KB of text against a tool that moves
 * gigabytes, and a tool whose whole subject is "you decide what to retain" should
 * not quietly prune the user's own records.
 *
 * **Second** precision, unlike snapshot names' minute precision. A snapshot
 * refuses a same-minute collision loudly; this would silently overwrite a record
 * that — unlike a snapshot — cannot be reproduced, because the snapshots it
 * described are already gone. Seconds costs nothing and removes the case.
 * @param {string} timestamp
 * @returns {string}
 */
const auditFile = (timestamp) => `forget-unrestorable-${timestamp}.txt`;

/**
 * "Now" as the audit record's moment: a local name at second precision
 * (`2026-05-01T080213`) — the same shape as a snapshot name, one unit finer,
 * because a second `forget` within the same minute is plausible where a second
 * snapshot is not — plus the UTC instant and zone every timestamped artifact
 * records. Precision is per artifact; the instant and zone are not
 * ([ADR-0072](../../docs/adr/0072-timestamps-utc-in-files-local-in-names.md)).
 * @returns {{ name: string, instant: string, zone: string }}
 */
const auditMoment = () => localMoment("seconds");

/**
 * Remove remote snapshots — the retention **primitive** (docs/design/backup.md).
 * `s3cab forget --set <set> <snapshot>...` deletes just those snapshot objects
 * from `snapshots/<set>/`; the file content they referenced stays under `objects/`.
 * Reclaiming objects nothing references any more is `cleanup`'s job (the output
 * says so), so `forget` never touches `objects/`. (Local snapshots need no
 * command: the files are the API — delete the file.)
 *
 * The verb is `forget` because the command removes only the *record of a moment*
 * and leaves the content standing until `cleanup` sweeps it
 * ([ADR-0063](../../docs/adr/0063-forget-snapshots-delete-paths.md), matching
 * restic); `delete` is reserved for path-scoped content removal.
 *
 * Snapshots are the **bulk operand** and the set is addressed by `--set`
 * ([ADR-0062](../../docs/adr/0062-bulk-operands-positional-addressing-by-flag.md)):
 * several snapshots go in one run because the **unrestorable check** below is a
 * whole-bucket scan, and one run pays it once (docs/design/snapshot-deletion.md).
 *
 * **The unrestorable check** reports, before removing, which files no surviving
 * snapshot would hold — so `restore` could no longer produce them. It is the
 * information `cleanup`'s dry run only gives you *afterwards*, as hash counts with
 * no paths. (The vocabulary is ADR-0063's: `orphan` stays object-side, `cleanup`'s
 * word; this names the *user* consequence of the same state.) It is inescapably a
 * whole-bucket snapshot read (`referencedObjects`): dedup is global across sets
 * (ADR-0013), so answering from this set's own snapshots would report content as
 * unrestorable that another set still holds. The summary goes to stdout ending with
 * a file path; the confirmation comes last on stderr. Note the check reports what
 * would become *unrestorable* (and so *reclaimable*), not what `forget` removes:
 * `forget` never touches `objects/`, so every file it names stays stored (and
 * billed) until `cleanup`.
 *
 * **Two files, two purposes** (docs/design/snapshot-deletion.md). The full path
 * list is always written — it is computed anyway, and forgetting a `>` here costs
 * a second full scan:
 *  - the **preview**, `~/.s3cab/forget-unrestorable-preview.txt`, overwritten each
 *    run and written *before* the prompt, so declining still leaves you the list
 *    to read and re-run against without paying for a second scan;
 *  - the **audit record**, `~/.s3cab/sets/<set>/forget-unrestorable-<timestamp>.txt`,
 *    written only once a deletion actually happens, and kept.
 *
 * `--force`/`-f` skips the check and the confirmation **together** — skipping the
 * check leaves the prompt nothing useful to say (matching `rm -f` and
 * `upload --force`). It still writes an audit record, one that says the analysis
 * was skipped: a trail that silently omits the runs which bypassed the safety is
 * worse than one that names the gap.
 *
 * The set is **required** — no sole-set default, matching `restore`
 * ([ADR-0040](../../docs/adr/0040-restore-requires-set-name.md)): a destructive
 * command should never guess its target. On a **TTY** it confirms with a y/N
 * prompt naming the snapshots, set, and bucket (s3cab's first interactive prompt,
 * shared with `cleanup`); a **non-interactive** run refuses without `--force`
 * (clig: fail with instructions, never block on a prompt) — the tool-wide
 * destructive-command pattern
 * ([ADR-0064](../../docs/adr/0064-path-scoped-delete-deletion-record.md)), so a
 * scripted forget necessarily skips the check (the only non-interactive door,
 * `--force`, skips it). **Every** name is confirmed to exist before **any** is deleted, so a
 * typo gets a helpful error (and the prompt names real targets) rather than a
 * silent no-op (`DeleteObject` is idempotent) — and never a half-done run.
 *
 * @typedef {Object} ForgetResult
 * @property {string} set - The set the snapshots belonged to
 * @property {string[]} snapshots - The snapshots named for removal, in the order given
 * @property {boolean} forgotten - False only when the user declined the confirmation
 *
 * @param {string[]} [snapshots] - The snapshots to forget — the bulk operand (at least one)
 * @param {{ set?: string, force?: boolean }} [options] - `set` = the backup set they belong to (required); `force` skips the check and the confirmation (and is required for non-interactive runs)
 * @returns {Promise<ForgetResult>}
 */
export async function forget(snapshots = [], options = {}) {
  requireArg(options.set, "set");
  requireArg(snapshots.length, "snapshot");
  const force = Boolean(options.force);

  // Resolve the set and apply its env layer (its bucket + auth) over the ambient
  // shell (ADR-0022/0055 — the one s3cab layer).
  const set = loadSet(options.set);

  // The non-interactive gate, up front — before the whole-bucket scan. Forgetting
  // is destructive; with no terminal to confirm on, the intent must be explicit.
  // --force is the only non-interactive door and it skips the unrestorable check
  // too (the two travel together, rm -f), so a scripted forget files the "check
  // skipped" record. This is the tool-wide destructive-command pattern (ADR-0064);
  // before it, a bare non-interactive run proceeded.
  if (!force && !isInteractive(process.stdin)) {
    throw new Error(
      `Forgetting snapshots from set '${set.name}' needs a confirmation, and ` +
        `there is no terminal to ask on.\n` +
        `State the intent explicitly and skip the prompt (and the unrestorable ` +
        `check):\n` +
        `  s3cab forget --set ${set.name} ${snapshots.join(" ")} --force`,
    );
  }

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

  // One clock read for the whole run, so the audit filename and the `generated:`
  // line inside it agree by construction (ADR-0072, the same reason a snapshot
  // takes its name and its instant from one read).
  const moment = auditMoment();
  const context = {
    set: set.name,
    bucket: set.bucket,
    snapshots,
    generated: formatMoment(moment),
  };
  const auditPath = join(set.dir, auditFile(moment.name));

  // The unrestorable check — the whole-bucket scan, skipped only by --force. It runs
  // regardless of the TTY: a non-interactive run gets no prompt but still leaves
  // the report behind, which is the half of this that survives the terminal.
  /** @type {string | undefined} */
  let report;
  if (!force) {
    const referencedBySet = await referencedObjects(set.bucket);
    const plan = planUnrestorable(referencedBySet, {
      set: set.name,
      snapshots,
      remoteSnapshots: remote,
    });
    report = formatUnrestorableReport(plan, context);

    // The preview lands *before* the prompt, so declining still leaves the list
    // on disk to read and re-run against — without paying for a second scan.
    const previewPath = join(s3cabDir(), PREVIEW_FILE);
    await mkdir(s3cabDir(), { recursive: true });
    await writeFile(previewPath, report);

    // The summary is the command's *pre-decision* output, so it goes to stdout
    // here rather than through `render` (ADR-0043), which only runs once the
    // command has returned — by which point the deletion has happened.
    console.log(
      formatUnrestorableSummary(plan, {
        set: set.name,
        reportPath: previewPath,
      }),
    );
  }

  // TTY → confirm; non-interactive → proceed on the explicitly named snapshots.
  // **One prompt covers the whole run** (docs/design/snapshot-deletion.md): N
  // prompts in a feature built for bulk work is the pattern that trains people to
  // hold down `y`. --force skips this with the check, the two travelling together.
  if (!force && isInteractive(process.stdin)) {
    const ok = await promptYesNo(
      `Forget ${describe(snapshots)} from set '${set.name}' (bucket ${set.bucket})? This cannot be undone.`,
    );
    if (!ok) {
      // Cancelling is a normal outcome, not an error — exit 0. Guidance to
      // stderr; the result on stdout records that nothing was removed.
      console.warn("Cancelled — nothing was removed.");
      return { set: set.name, snapshots, forgotten: false };
    }
  }

  for (const name of snapshots) {
    await deleteRemoteSnapshot(set.bucket, set.name, name);
  }

  // The removal happened, so it earns an audit record — kept, unlike the
  // preview. A `--force` run has no analysis to record, so it files the stub that
  // says so rather than nothing at all. Written *after* the deletes: the record
  // states what was forgotten, and a run that threw part-way through has a
  // different story than this file would tell.
  await mkdir(set.dir, { recursive: true });
  await writeFile(auditPath, report ?? formatForcedReport(context));

  // The objects the snapshots referenced are still stored — point at `cleanup`,
  // which reclaims whatever nothing references any more. Guidance → stderr. *How
  // much* is reclaimable was the unrestorable preview's job above (and is in the
  // audit record); repeating it here would restate a number the user has just
  // answered a prompt about, and it is unavailable under --force anyway.
  console.warn(
    `Forgot ${describe(snapshots)} from set '${set.name}'.\n` +
      `Objects they referenced are still stored; reclaim unreferenced ones with: ` +
      `s3cab cleanup ${set.bucket}\n` +
      `Record of this removal:\n  ${auditPath}`,
  );

  return { set: set.name, snapshots, forgotten: true };
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
