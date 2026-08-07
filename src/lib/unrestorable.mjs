import {
  alignTotalTable,
  countOf,
  formatByteValue,
  formatCount,
} from "./format.mjs";
import {
  safeSize,
  unreadableMessage,
  unreadableSnapshots,
} from "./referenced.mjs";

// The pure core of `forget`'s **unrestorable check** (docs/design/snapshot-deletion.md):
// given the bucket's referenced enumeration (`referencedObjects` in remote.mjs)
// and the snapshots a run is about to forget, work out which files no surviving
// snapshot would hold — so `restore` could no longer produce them — plus the two
// shapes the command prints, the stdout summary and the report file's body. No S3,
// no filesystem, no clock: the command owns the I/O and the policy, so all of this
// is unit-testable by asserting on returned strings and data, with no mocked seams
// (the same split `planCleanup` keeps with `cleanup`).
//
// **Unrestorable, not orphaned** (ADR-0063's vocabulary verdict). `orphan` stays
// object-side, `cleanup`'s storage-accounting word (CONTEXT.md) — and the hashes
// below genuinely do become orphans, which is why the computation still says so.
// What this module *reports* is the user consequence of that state, read through
// the **Restore** vocabulary: a file no surviving snapshot lists. One state, two
// vantage points; the user is deciding about files, not about reference counts.
//
// Sibling of cleanup.mjs, deliberately not folded into it: `cleanup` answers
// "what does *nothing* reference *now*" over `stored − referenced`, while this
// answers "what would nothing reference *after* a hypothetical removal" over
// `referenced − referenced`. Different question, no shared computation — and
// `planCleanup` is explicitly left alone (see that design's box).

/** @import { ReferencedResult } from "./referenced.mjs" */

/**
 * One selected snapshot's share: the content that **only** it references among
 * the selection, and so is attributable to it alone.
 * @typedef {Object} SnapshotUnrestorable
 * @property {string} snapshot - The snapshot name, as the user gave it
 * @property {number} files - Files that would lose their last reference
 * @property {number} bytes - Bytes the underlying objects hold (counted once per object)
 */

/**
 * What a removal would leave unrestorable. `bySnapshot` attributes content
 * referenced by exactly one of the selected snapshots to that snapshot; content
 * referenced by two or more lands in `shared*` — it goes only because all of them
 * are going, and naming that category is what stops the per-snapshot rows summing
 * to less than the total with no explanation.
 *
 * Counts are **files** (paths), because that is what a user is deciding about and
 * what the report file lists; bytes are counted **once per object**, because
 * content-addressed dedup stores one copy however many paths point at it — so
 * `files` and `bytes` deliberately do not scale together.
 * @typedef {Object} UnrestorablePlan
 * @property {SnapshotUnrestorable[]} bySnapshot - Per selected snapshot, in the order given
 * @property {number} sharedFiles - Files lost only because several selected snapshots go together
 * @property {number} sharedBytes - Bytes those hold
 * @property {number} totalFiles - Every unrestorable file
 * @property {number} totalBytes - Every orphaned object's size, counted once each
 * @property {number} totalObjects - Distinct objects left orphaned (the reclaimable ones)
 * @property {boolean} lastOfSet - The selection takes out the set's last remote snapshot
 * @property {UnrestorableEntry[]} entries - Every unrestorable file, for the report file
 * @property {string[]} unreadable - `set/snapshot` names that would not read
 */

/**
 * One unrestorable file in the report. No size: sizes belong to *objects*, not
 * paths, and the report is a per-file list — see `formatUnrestorableReport`.
 * @typedef {Object} UnrestorableEntry
 * @property {string} path - The path the content was stored under
 * @property {string[]} snapshots - Which of the selected snapshots referenced it, sorted
 */

/**
 * Compute what forgetting `snapshots` from `set` would leave unrestorable.
 *
 * Two properties make this the only correct formulation
 * (docs/design/snapshot-deletion.md), and both are load-bearing here:
 *
 * - **Bucket-wide.** Dedup is global across sets (ADR-0013), so another set can
 *   reference the same content. `referencedBySet` is the whole bucket for exactly
 *   this reason — answering from the target set alone would report files as
 *   unrestorable that another set still holds, which is the fastest way to make a
 *   preview lie.
 * - **Over the whole selection at once.** Content two of the named snapshots share
 *   and nothing else references goes only when *both* go; evaluating each snapshot
 *   independently against the current state reports zero for each while removing
 *   both loses it.
 *
 * Pure and non-throwing: `unreadable` is passed through as data, and what to do
 * about it is the command's call (a warning there, not the abort `cleanup` makes —
 * `forget` never acts on this set, it only shows it).
 * @param {Map<string, ReferencedResult>} referencedBySet - The bucket's per-set referenced enumeration (`referencedObjects`)
 * @param {{ set: string, snapshots: string[], remoteSnapshots: string[] }} selection - The target set, the snapshots to forget, and every snapshot that set has remotely
 * @returns {UnrestorablePlan}
 */
export function planUnrestorable(
  referencedBySet,
  { set, snapshots, remoteSnapshots },
) {
  const unreadable = unreadableSnapshots(referencedBySet);

  const selected = new Set(snapshots);
  // A set whose every snapshot failed to read has no entry at all — treat it as
  // referencing nothing rather than special-casing every access below. The
  // `unreadable` list above is what tells the user the preview is incomplete.
  const target = referencedBySet.get(set)?.referenced ?? new Map();

  // Step 1 — the doomed hashes: content this set holds that *no surviving
  // snapshot of this set* references. A hash survives the moment any snapshot
  // outside the selection points at it, under any path.
  /** @type {Set<string>} */
  const doomed = new Set();
  for (const [hash, { paths }] of target) {
    const survives = [...paths.values()].some(({ snapshots: refs }) =>
      [...refs].some((name) => !selected.has(name)),
    );
    if (!survives) {
      doomed.add(hash);
    }
  }

  // Step 2 — subtract every *other* set. `Set.difference` accepts any set-like,
  // and a Map qualifies (`size`/`has`/`keys`), so each set's `referenced` map is
  // subtracted in place with nothing materialized from it. The direction is what
  // makes that true: `doomed` is the receiver and must be a real Set, and it is
  // also the smaller side, so each pass allocates only what is still doomed.
  let orphaned = doomed;
  for (const [name, { referenced }] of referencedBySet) {
    if (name !== set) {
      orphaned = orphaned.difference(referenced);
    }
  }

  // Step 3 — attribute each orphaned hash to the selected snapshots referencing
  // it: exactly one → that snapshot's row; two or more → the shared line. Counting
  // references *within the selection* is what makes this order-independent, where
  // charging each hash to the last snapshot that released it would shift with
  // argument order.
  /** @type {Map<string, SnapshotUnrestorable>} */
  const bySnapshot = new Map(
    snapshots.map((name) => [name, { snapshot: name, files: 0, bytes: 0 }]),
  );
  /** @type {UnrestorableEntry[]} */
  const entries = [];
  let sharedFiles = 0;
  let sharedBytes = 0;
  let totalFiles = 0;
  let totalBytes = 0;

  for (const hash of orphaned) {
    const entry = target.get(hash);
    if (!entry) {
      continue; // unreachable: `orphaned ⊆ doomed ⊆ target`. Narrows the type.
    }

    const bytes = safeSize(entry);
    /** @type {Set<string>} */
    const referencing = new Set();
    for (const { snapshots: refs } of entry.paths.values()) {
      for (const name of refs) {
        referencing.add(name);
      }
    }

    const files = entry.paths.size;
    totalFiles += files;
    totalBytes += bytes;

    const named = [...referencing].sort();
    const sole =
      referencing.size === 1 ? bySnapshot.get(named[0] ?? "") : undefined;
    if (sole) {
      sole.files += files;
      sole.bytes += bytes;
    } else {
      sharedFiles += files;
      sharedBytes += bytes;
    }

    for (const path of entry.paths.keys()) {
      entries.push({ path, snapshots: named });
    }
  }

  entries.sort((a, b) => a.path.localeCompare(b.path));

  return {
    bySnapshot: [...bySnapshot.values()],
    sharedFiles,
    sharedBytes,
    totalFiles,
    totalBytes,
    totalObjects: orphaned.size,
    // Every remote snapshot the set has is in the selection — the deletion that
    // orphans everything unique to the set, and the most consequential form of
    // this operation.
    lastOfSet:
      remoteSnapshots.length > 0 &&
      remoteSnapshots.every((name) => selected.has(name)),
    entries,
    unreadable,
  };
}

/**
 * The stdout summary — what the user reads before answering the prompt.
 *
 * **One layout whatever the snapshot count.** A single snapshot yields a
 * one-row table whose total repeats that row, which is mildly redundant but never
 * unclear — and consistency across runs (plus one code path, and no threshold for
 * anyone to learn) is worth more than the two lines a special case would save.
 *
 * The report file's path lands **last, on its own indented line**, so it can be
 * pasted straight into an editor or Explorer — the copy-pasteable style ADR-0030
 * already requires for fixes, and the reason the file beats "pipe it somewhere"
 * on Windows, the primary environment.
 * @param {UnrestorablePlan} plan
 * @param {{ set: string, reportPath: string, bucket: string }} context - The set being forgotten from, where the full list was written, and the repository bucket (so the unreadable caveat's `verify` command pastes as-is)
 * @returns {string}
 */
export function formatUnrestorableSummary(plan, { set, reportPath, bucket }) {
  const lines = [];

  if (plan.totalFiles === 0) {
    lines.push(
      `Unrestorable preview — nothing would become unrestorable. Every file ` +
        `these snapshots hold is also held elsewhere.`,
    );
  } else {
    lines.push(
      `Unrestorable preview — what you could no longer restore once these are gone:`,
      ``,
    );

    /** @type {[string, string, string][]} */
    const rows = plan.bySnapshot.map(({ snapshot, files: f, bytes }) => [
      snapshot,
      formatCount(f),
      formatByteValue(bytes),
    ]);
    if (plan.sharedFiles > 0) {
      rows.push([
        `shared across ${plan.bySnapshot.length} snapshots`,
        formatCount(plan.sharedFiles),
        formatByteValue(plan.sharedBytes),
      ]);
    }
    rows.push([
      "total unrestorable",
      formatCount(plan.totalFiles),
      formatByteValue(plan.totalBytes),
    ]);

    lines.push(...alignTotalTable(["snapshot", "files", "size"], rows));
  }

  if (plan.lastOfSet) {
    lines.push(
      ``,
      `This is the last remote snapshot of set '${set}' — forgetting it loses ` +
        `everything the set alone was keeping, and leaves nothing to restore from.`,
    );
  }

  if (plan.unreadable.length > 0) {
    // Not `cleanup`'s abort, so no blocked-goal lead: nothing is removed off the
    // back of these numbers, and an incomplete preview is a caveat to state
    // rather than a reason to refuse. The *direction* of the error is the part
    // worth saying — an unread snapshot's references are unknown, so content it
    // alone holds gets listed as unrestorable when it is not.
    lines.push(
      ``,
      unreadableMessage({
        names: plan.unreadable,
        bucket,
        consequence: "this preview may overstate what becomes unrestorable",
      }),
    );
  }

  lines.push(``, `Full list:`, `  ${reportPath}`);
  return lines.join("\n");
}

/**
 * The report file's body: a header recording what the run was and what it
 * totalled, then one tab-separated row per unrestorable file — the snapshots that
 * referenced it, then the path, so the ragged column is last. Never truncated
 * (ADR-0010); this is the artifact the summary's counts abbreviate.
 *
 * **No per-row size, deliberately.** The question this file answers is "am I
 * about to lose the last copy of *this file*", which a size does not help with —
 * and a size column here actively misleads, because content-addressed dedup
 * stores one copy for however many paths point at it, so summing the column
 * overstates the space involved. The one trustworthy figure is the total, and it
 * belongs in the header where it cannot be summed into something wrong.
 * @param {UnrestorablePlan} plan
 * @param {{ set: string, bucket: string, snapshots: string[], generated: string }} context
 * @returns {string}
 */
export function formatUnrestorableReport(
  plan,
  { set, bucket, snapshots, generated },
) {
  const header = [
    `# s3cab forget — files you would no longer be able to restore`,
    `# generated:  ${generated}`,
    `# set:        ${set}`,
    `# bucket:     ${bucket}`,
    `# snapshots:  ${snapshots.join(", ")}`,
    `#`,
    `# ${countOf(plan.totalFiles, "file")}, holding ${formatByteValue(plan.totalBytes)} ` +
      `across ${countOf(plan.totalObjects, "stored object")}.`,
    `# (Fewer objects than files: identical content is stored once, however many`,
    `# files hold it — so the space freed is the object total, not the file count.)`,
    `#`,
    `# Forgetting those snapshots leaves no snapshot holding the files below, so`,
    `# restore can no longer produce them. Reclaim the space with:`,
    `#   s3cab cleanup ${bucket}`,
    `#`,
    `# referenced-by\tpath`,
  ];
  const rows = plan.entries.map(
    ({ path, snapshots: refs }) => `${refs.join(",")}\t${path}`,
  );
  return [...header, ...rows, ``].join("\n");
}

/**
 * The audit record for a `--force` run, which skipped the check — so there is no
 * file list to write, only the fact that a removal happened without one.
 * Recorded anyway: an audit trail that silently omits the runs that bypassed the
 * safety is worse than one that names the gap.
 * @param {{ set: string, bucket: string, snapshots: string[], generated: string }} context
 * @returns {string}
 */
export function formatForcedReport({ set, bucket, snapshots, generated }) {
  return (
    [
      `# s3cab forget — no unrestorable check (--force)`,
      `# generated:  ${generated}`,
      `# set:        ${set}`,
      `# bucket:     ${bucket}`,
      `# snapshots:  ${snapshots.join(", ")}`,
      `#`,
      `# --force skipped the unrestorable check, so what these snapshots were`,
      `# the last to hold was never computed, and cannot be worked out from here`,
      `# now that they are gone.`,
      `#`,
      `# To see what is unreferenced in the bucket today: s3cab cleanup ${bucket}`,
    ].join("\n") + `\n`
  );
}
