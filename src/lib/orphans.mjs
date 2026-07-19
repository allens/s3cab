import { formatByteValue } from "./format.mjs";

// The pure core of `delete`'s **orphan check** (docs/design/snapshot-deletion.md):
// given the bucket's referenced enumeration (`referencedObjects` in remote.mjs)
// and the snapshots a run is about to delete, work out what content would be left
// with no snapshot referencing it — plus the two shapes the command prints, the
// stdout summary and the report file's body. No S3, no filesystem, no clock: the
// command owns the I/O and the policy, so all of this is unit-testable by
// asserting on returned strings and data, with no mocked seams (the same split
// `planCleanup` keeps with `cleanup`).
//
// Sibling of cleanup.mjs, deliberately not folded into it: `cleanup` answers
// "what does *nothing* reference *now*" over `stored − referenced`, while this
// answers "what would nothing reference *after* a hypothetical deletion" over
// `referenced − referenced`. Same vocabulary, different question, no shared
// computation — and `planCleanup` is explicitly left alone (see that design's box).

/** @import { ReferencedResult } from "./verify.mjs" */

/**
 * One selected snapshot's share of the orphans: the content that **only** it
 * references among the selection, and so is attributable to it alone.
 * @typedef {Object} SnapshotOrphans
 * @property {string} snapshot - The snapshot name, as the user gave it
 * @property {number} files - Paths that would lose their last reference
 * @property {number} bytes - Bytes the underlying objects hold (counted once per object)
 */

/**
 * What a deletion would orphan. `bySnapshot` attributes content referenced by
 * exactly one of the selected snapshots to that snapshot; content referenced by
 * two or more lands in `shared*` — it is orphaned only because all of them are
 * going, and naming that category is what stops the per-snapshot rows summing to
 * less than the total with no explanation.
 *
 * Counts are **files** (paths), because that is what a user is deciding about and
 * what the report file lists; bytes are counted **once per object**, because
 * content-addressed dedup stores one copy however many paths point at it — so
 * `files` and `bytes` deliberately do not scale together.
 * @typedef {Object} OrphanPlan
 * @property {SnapshotOrphans[]} bySnapshot - Per selected snapshot, in the order given
 * @property {number} sharedFiles - Files orphaned only because several selected snapshots go together
 * @property {number} sharedBytes - Bytes those hold
 * @property {number} totalFiles - Every orphaned path
 * @property {number} totalBytes - Every orphaned object's size, counted once each
 * @property {number} totalObjects - Distinct orphaned objects
 * @property {boolean} lastOfSet - The selection takes out the set's last remote snapshot
 * @property {OrphanEntry[]} entries - Every orphaned path, for the report file
 * @property {{ set: string, snapshot: string, reason: string }[]} unreadable - Snapshots that would not read
 */

/**
 * One orphaned path in the report file. No size: sizes belong to *objects*, not
 * paths, and the report is a per-path list — see `formatOrphanReport`.
 * @typedef {Object} OrphanEntry
 * @property {string} path - The path the content was stored under
 * @property {string[]} snapshots - Which of the selected snapshots referenced it, sorted
 */

/**
 * Compute what deleting `snapshots` from `set` would orphan.
 *
 * Two properties make this the only correct formulation
 * (docs/design/snapshot-deletion.md), and both are load-bearing here:
 *
 * - **Bucket-wide.** Dedup is global across sets (ADR-0013), so another set can
 *   reference the same content. `referencedBySet` is the whole bucket for exactly
 *   this reason — answering from the target set alone would report content as
 *   orphaned that another set still needs, which is the fastest way to make a
 *   deletion preview lie.
 * - **Over the whole selection at once.** Content two of the named snapshots share
 *   and nothing else references is orphaned only when *both* go; evaluating each
 *   snapshot independently against the current state reports zero for each while
 *   deleting both orphans it.
 *
 * Pure and non-throwing: `unreadable` is passed through as data, and what to do
 * about it is the command's call (a warning there, not the abort `cleanup` makes —
 * `delete` never acts on this set, it only shows it).
 * @param {Map<string, ReferencedResult>} referencedBySet - The bucket's per-set referenced enumeration (`referencedObjects`)
 * @param {{ set: string, snapshots: string[], remoteSnapshots: string[] }} selection - The target set, the snapshots to delete, and every snapshot that set has remotely
 * @returns {OrphanPlan}
 */
export function planOrphans(
  referencedBySet,
  { set, snapshots, remoteSnapshots },
) {
  const unreadable = [...referencedBySet].flatMap(([name, r]) =>
    r.unreadable.map((u) => ({
      set: name,
      snapshot: u.snapshot,
      reason: u.reason,
    })),
  );

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
  /** @type {Map<string, SnapshotOrphans>} */
  const bySnapshot = new Map(
    snapshots.map((name) => [name, { snapshot: name, files: 0, bytes: 0 }]),
  );
  /** @type {OrphanEntry[]} */
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

    // Content fixes size, so every path records the same one; a *torn* snapshot
    // can disagree, and the largest is the safe figure to show before a deletion
    // (never understate what is at stake). `verify` is where a disagreement is a
    // finding — here it must not derail the preview.
    let bytes = 0;
    /** @type {Set<string>} */
    const referencing = new Set();
    for (const { sizes, snapshots: refs } of entry.paths.values()) {
      for (const size of sizes) {
        bytes = Math.max(bytes, size);
      }
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
 * @param {OrphanPlan} plan
 * @param {{ set: string, reportPath: string }} context - The set being deleted from, and where the full list was written
 * @returns {string}
 */
export function formatOrphanSummary(plan, { set, reportPath }) {
  const lines = [];

  if (plan.totalFiles === 0) {
    lines.push(
      `Orphan preview — nothing would be orphaned. Every file these snapshots ` +
        `reference is also referenced elsewhere.`,
    );
  } else {
    lines.push(
      `Orphan preview — what no snapshot would reference once these are gone:`,
      ``,
    );

    /** @type {[string, number, number][]} */
    const rows = plan.bySnapshot.map(({ snapshot, files: f, bytes }) => [
      snapshot,
      f,
      bytes,
    ]);
    if (plan.sharedFiles > 0) {
      rows.push([
        `shared across ${plan.bySnapshot.length} snapshots`,
        plan.sharedFiles,
        plan.sharedBytes,
      ]);
    }
    rows.push(["total orphaned", plan.totalFiles, plan.totalBytes]);

    // Right-align the numbers so the magnitudes line up — the column being
    // compared is the one being scanned.
    const label = Math.max(...rows.map(([name]) => name.length));
    const fileCol = Math.max(...rows.map(([, f]) => files(f).length));
    const byteCol = Math.max(
      ...rows.map(([, , bytes]) => formatByteValue(bytes).length),
    );
    const row = (/** @type {[string, number, number]} */ [name, f, bytes]) =>
      `  ${name.padEnd(label)}  ${files(f).padStart(fileCol)}  ` +
      `${formatByteValue(bytes).padStart(byteCol)}`;

    const total = rows.pop();
    for (const r of rows) {
      lines.push(row(r));
    }
    if (total) {
      lines.push(
        `  ${" ".repeat(label)}  ${"─".repeat(fileCol + byteCol + 2)}`,
        row(total),
      );
    }
  }

  if (plan.lastOfSet) {
    lines.push(
      ``,
      `This is the last remote snapshot of set '${set}' — deleting it orphans ` +
        `everything the set alone was keeping, and leaves nothing to restore from.`,
    );
  }

  if (plan.unreadable.length > 0) {
    // Not `cleanup`'s abort: nothing is deleted off the back of these numbers, so
    // an incomplete preview is a caveat to state, not a reason to refuse. The
    // direction of the error matters and is worth saying — an unread snapshot's
    // references are unknown, so content it alone holds is listed as orphaned
    // when it is not.
    const where = plan.unreadable.map((u) => `${u.set}/${u.snapshot}`);
    lines.push(
      ``,
      `Warning: ${where.length} snapshot(s) would not read, so their references ` +
        `are unknown and this preview may overstate what is orphaned ` +
        `(${where.join(", ")}).`,
      `Check them with: s3cab verify`,
    );
  }

  lines.push(``, `Full list:`, `  ${reportPath}`);
  return lines.join("\n");
}

/**
 * The report file's body: a header recording what the run was and what it
 * totalled, then one tab-separated row per orphaned path — the snapshots that
 * referenced it, then the path, so the ragged column is last. Never truncated
 * (ADR-0010); this is the artifact the summary's counts abbreviate.
 *
 * **No per-row size, deliberately.** The question this file answers is "am I
 * about to lose the last copy of *this file*", which a size does not help with —
 * and a size column here actively misleads, because content-addressed dedup
 * stores one copy for however many paths point at it, so summing the column
 * overstates the space involved. The one trustworthy figure is the total, and it
 * belongs in the header where it cannot be summed into something wrong.
 * @param {OrphanPlan} plan
 * @param {{ set: string, bucket: string, snapshots: string[], generated: string }} context
 * @returns {string}
 */
export function formatOrphanReport(
  plan,
  { set, bucket, snapshots, generated },
) {
  const header = [
    `# s3cab delete — files that would be left with nothing referencing them`,
    `# generated:  ${generated}`,
    `# set:        ${set}`,
    `# bucket:     ${bucket}`,
    `# snapshots:  ${snapshots.join(", ")}`,
    `#`,
    `# ${files(plan.totalFiles)}, holding ${formatByteValue(plan.totalBytes)} ` +
      `across ${objects(plan.totalObjects)}.`,
    `# (Fewer objects than files: identical content is stored once, however many`,
    `# files hold it — so the space freed is the object total, not the file count.)`,
    `#`,
    `# Deleting those snapshots leaves the files below with nothing referencing`,
    `# them. Reclaim the space with: s3cab cleanup ${bucket}`,
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
 * orphan list to write, only the fact that a deletion happened without one.
 * Recorded anyway: an audit trail that silently omits the runs that bypassed the
 * safety is worse than one that names the gap.
 * @param {{ set: string, bucket: string, snapshots: string[], generated: string }} context
 * @returns {string}
 */
export function formatForcedReport({ set, bucket, snapshots, generated }) {
  return (
    [
      `# s3cab delete — no orphan analysis (--force)`,
      `# generated:  ${generated}`,
      `# set:        ${set}`,
      `# bucket:     ${bucket}`,
      `# snapshots:  ${snapshots.join(", ")}`,
      `#`,
      `# --force skipped the orphan check, so what these snapshots left`,
      `# unreferenced was never computed, and cannot be worked out from here`,
      `# now that they are gone.`,
      `#`,
      `# To see what is unreferenced in the bucket today: s3cab cleanup ${bucket}`,
    ].join("\n") + `\n`
  );
}

/** @param {number} n */
const files = (n) => `${n.toLocaleString("en")} ${n === 1 ? "file" : "files"}`;

/** @param {number} n */
const objects = (n) =>
  `${n.toLocaleString("en")} stored ${n === 1 ? "object" : "objects"}`;
