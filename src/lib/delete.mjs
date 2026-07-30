import {
  alignTotalTable,
  formatByteValue,
  formatCount,
  plural,
} from "./format.mjs";
import { unreadableMessage, unreadableSnapshots } from "./referenced.mjs";
import { pathMatcher } from "./restore.mjs";

// The pure core of the `delete` command (ADR-0064): given the bucket's
// referenced enumeration (`referencedObjects`, remote.mjs), the named paths,
// and the participating sets, work out which stored objects are deletable —
// plus the shapes the command prints (the stdout summary and the preview
// file's body). No S3, no filesystem, no clock: the command owns the I/O,
// the confirmation policy, and the record write, so all of this is
// unit-testable by asserting on returned data (the same split `planCleanup`
// and `planUnrestorable` keep with their commands).
//
// The scope rule (ADR-0064): paths resolve to content within the
// **participating sets** — the sets attached on this machine that point at
// this bucket — and an object is deletable only when *every* reference to it,
// bucket-wide, sits inside that selection. Any reference from an unattached
// set (another user's, or this user's other machine's) *protects* the object,
// so `delete` cannot break a stranger's restorability by construction.
// `--everywhere` switches that protection off for the matched hashes — the
// leaked-secret nuke — and is content-scoped: paths still resolve to hashes
// in the participating sets only (a stranger's same-named path may hold
// *different* content, which must never be swept up by name).

/** @import { ReferencedResult } from "./referenced.mjs" */

/**
 * One reference a deletable object holds somewhere in the bucket: the set, the
 * path, and whether that reference fell inside the selection (participating
 * set + named path). Outside `--everywhere`, every ref of a deletable object
 * is in-selection by definition; under it, `inSelection: false` rows are the
 * collateral references whose sets lose restorability.
 * @typedef {Object} DeleteRef
 * @property {string} set
 * @property {string} path
 * @property {boolean} inSelection
 */

/**
 * One object the plan would delete: its hash, the size to report (the largest
 * any snapshot row records — never understate what is at stake), every
 * reference it has bucket-wide, and which of the named paths matched it
 * (indexes into the plan's `paths`, for the per-path attribution).
 * @typedef {Object} DeletableObject
 * @property {string} hash
 * @property {number} size
 * @property {DeleteRef[]} refs
 * @property {Set<number>} filters
 */

/**
 * One matched file that survives: content under a named path that something
 * outside the selection still references — `keptBy` names the first such
 * reference, the reason the user reads.
 * @typedef {Object} SurvivorFile
 * @property {string} path - The matched path that stays restorable
 * @property {string} set - The participating set it matched in
 * @property {{ set: string, path: string }} keptBy - The outside reference protecting it
 */

/**
 * What a `delete` run would remove, and why the rest survives.
 * `byPath` attributes objects matched by exactly one named path to that path;
 * objects matched by several land in `shared*` (the same
 * sole-vs-shared attribution as forget's per-snapshot table, for the same
 * reason: the rows must sum to the total with no unexplained gap). Files are
 * distinct paths (what the user decides about); bytes are counted once per
 * object (dedup stores one copy) — so the two deliberately do not scale
 * together.
 * @typedef {Object} DeletePlan
 * @property {DeletableObject[]} deletable
 * @property {SurvivorFile[]} survivors - Matched files kept by outside references (empty under `--everywhere`)
 * @property {{ path: string, files: number, bytes: number }[]} byPath - Per named path, in the order given
 * @property {number} sharedFiles - Files in objects matched by several named paths
 * @property {number} sharedBytes - Bytes those objects hold
 * @property {{ set: string, files: number, inScope: boolean }[]} bySet - Sets losing references, sorted; `inScope: false` rows exist only under `--everywhere`
 * @property {number} totalFiles - Every path that loses its content
 * @property {number} totalBytes - Every deletable object's size, once each
 * @property {string[]} unmatchedPaths - Named paths matching nothing (an error upstream)
 * @property {string[]} unreadable - `set/snapshot` names that would not read
 */

/**
 * Compute what deleting the named paths would remove.
 *
 * Two-pass over the (already in-memory) enumeration: pass 1 finds the
 * **candidate** hashes — any in-scope reference under a named path — and pass
 * 2 classifies each candidate against *every* reference it has bucket-wide:
 * one reference outside the selection makes it a survivor (unless
 * `everywhere`), otherwise it is deletable and all its references become
 * record rows. Evaluated over the whole selection at once, like
 * `planUnrestorable` — content shared between two named paths goes only
 * because both are going.
 *
 * Pure and non-throwing: `unmatchedPaths` and `unreadable` are data, and what
 * to do about them (the loud no-match error; the abort-vs-warn unreadable
 * policy) is the command's call.
 * @param {Map<string, ReferencedResult>} referencedBySet - The bucket's per-set referenced enumeration (`referencedObjects`)
 * @param {{ paths: string[], scopeSets: string[], everywhere?: boolean }} selection
 * @returns {DeletePlan}
 */
export function planDelete(
  referencedBySet,
  { paths, scopeSets, everywhere = false },
) {
  const unreadable = unreadableSnapshots(referencedBySet);

  const scope = new Set(scopeSets);
  // A path that normalizes to nothing (blank, bare separator) gets no matcher
  // — it matches nothing, lands in `unmatchedPaths`, and the command errors
  // loudly. The opposite default (match everything) is the catastrophe.
  const matchers = paths.map((p) => pathMatcher([p]));
  const anyMatch = pathMatcher(paths) ?? (() => false);

  // Pass 1 — candidates: hashes with at least one in-scope reference under a
  // named path. `filtersHit` tracks which named paths matched *anything*
  // (deletable or surviving), so the no-match error fires only for a path
  // that truly names nothing backed up.
  /** @type {Map<string, { size: number, filters: Set<number> }>} */
  const candidates = new Map();
  /** @type {Set<number>} */
  const filtersHit = new Set();
  for (const [setName, { referenced }] of referencedBySet) {
    if (!scope.has(setName)) {
      continue;
    }
    for (const [hash, { paths: refPaths }] of referenced) {
      for (const path of refPaths.keys()) {
        /** @type {number[]} */
        const hit = [];
        matchers.forEach((matches, i) => {
          if (matches?.(path)) {
            hit.push(i);
          }
        });
        if (hit.length === 0) {
          continue;
        }
        const candidate = candidates.getOrInsertComputed(hash, () => ({
          size: 0,
          filters: new Set(),
        }));
        for (const i of hit) {
          candidate.filters.add(i);
          filtersHit.add(i);
        }
      }
    }
  }

  // Pass 2 — classify each candidate against every reference it has,
  // bucket-wide. The size is the max any row records for it (a torn snapshot
  // can disagree; never understate before a deletion).
  /** @type {DeletableObject[]} */
  const deletable = [];
  /** @type {SurvivorFile[]} */
  const survivors = [];
  for (const [hash, candidate] of candidates) {
    /** @type {DeleteRef[]} */
    const refs = [];
    /** @type {{ set: string, path: string } | undefined} */
    let keptBy;
    for (const [setName, { referenced }] of referencedBySet) {
      const entry = referenced.get(hash);
      if (!entry) {
        continue;
      }
      for (const [path, { sizes }] of entry.paths) {
        for (const size of sizes) {
          candidate.size = Math.max(candidate.size, size);
        }
        const inSelection = scope.has(setName) && anyMatch(path);
        refs.push({ set: setName, path, inSelection });
        if (!inSelection) {
          keptBy ??= { set: setName, path };
        }
      }
    }
    if (keptBy && !everywhere) {
      for (const ref of refs) {
        if (ref.inSelection) {
          survivors.push({ path: ref.path, set: ref.set, keptBy });
        }
      }
    } else {
      deletable.push({
        hash,
        size: candidate.size,
        refs,
        filters: candidate.filters,
      });
    }
  }

  // Attribution and totals. An object's files are its distinct ref paths (the
  // same path in two sets is one file the user recognizes); bytes count once
  // per object.
  /** @type {Map<number, { files: number, bytes: number }>} */
  const byFilter = new Map(paths.map((_, i) => [i, { files: 0, bytes: 0 }]));
  /** @type {Map<string, { files: number, inScope: boolean }>} */
  const bySetMap = new Map();
  let sharedFiles = 0;
  let sharedBytes = 0;
  let totalFiles = 0;
  let totalBytes = 0;
  for (const object of deletable) {
    const distinctPaths = new Set(object.refs.map((r) => r.path));
    const fileCount = distinctPaths.size;
    totalFiles += fileCount;
    totalBytes += object.size;

    const sole =
      object.filters.size === 1
        ? byFilter.get([...object.filters][0] ?? -1)
        : undefined;
    if (sole) {
      sole.files += fileCount;
      sole.bytes += object.size;
    } else {
      sharedFiles += fileCount;
      sharedBytes += object.size;
    }

    for (const ref of object.refs) {
      const set = bySetMap.getOrInsertComputed(ref.set, () => ({
        files: 0,
        inScope: scope.has(ref.set),
      }));
      set.files++;
    }
  }

  survivors.sort((a, b) => a.path.localeCompare(b.path));
  deletable.sort((a, b) => a.hash.localeCompare(b.hash));

  return {
    deletable,
    survivors,
    byPath: paths.map((path, i) => {
      const row = byFilter.get(i);
      return { path, files: row?.files ?? 0, bytes: row?.bytes ?? 0 };
    }),
    sharedFiles,
    sharedBytes,
    bySet: [...bySetMap]
      .map(([set, { files, inScope }]) => ({ set, files, inScope }))
      .sort((a, b) => a.set.localeCompare(b.set)),
    totalFiles,
    totalBytes,
    unmatchedPaths: paths.filter((_, i) => !filtersHit.has(i)),
    unreadable,
  };
}

/**
 * The record rows a plan's deletion writes: every (hash, path) reference the
 * deletable objects had, de-duplicated (the same path in two sets is one row —
 * the record explains hashes, and a reader wants each broken path once) and
 * sorted by path so the record reads like a file listing.
 * @param {DeletePlan} plan
 * @returns {{ hash: string, path: string }[]}
 */
export function deletionRows(plan) {
  /** @type {Map<string, { hash: string, path: string }>} */
  const rows = new Map();
  for (const { hash, refs } of plan.deletable) {
    for (const { path } of refs) {
      rows.set(`${hash}\t${path}`, { hash, path });
    }
  }
  return [...rows.values()].sort(
    (a, b) => a.path.localeCompare(b.path) || a.hash.localeCompare(b.hash),
  );
}

/**
 * What `delete` says about unreadable snapshots — shared verbatim by the acting
 * run, which throws it (commands/delete.mjs), and the dry run, which prints it
 * inside the preview. Both are one command reporting one condition, so they are
 * one sentence rather than two kept in step by hand.
 *
 * The consequence is the specific danger here, and it is why the interlock
 * exists at all: an unknown reference is exactly the kind that would have
 * protected the content from this delete. Worded without a number, as
 * `unreadableMessage` requires, so it reads for one unreadable snapshot or forty.
 * @param {string[]} names - The bucket's unreadable `set/snapshot` names
 * @param {string} bucket - The repository bucket
 * @returns {string}
 */
export const unreadableDeleteMessage = (names, bucket) =>
  unreadableMessage({
    names,
    bucket,
    lead: "Can't delete safely",
    consequence:
      "an unknown reference could be the only thing keeping this content alive",
  });

/**
 * The stdout summary — what the user reads before answering the prompt (or
 * after a dry run). The per-path table shares the unrestorable summary's
 * layout by sharing its code (`alignTotalTable`) — one shape whatever the
 * count, numbers right-aligned, sole-vs-shared attribution, the total under a
 * rule — while the rows, their names and the stored-object count trailing the
 * total stay this command's own; after it, the per-set
 * consent view — every set losing references, with the out-of-scope sets
 * called out hard under `--everywhere` (they are the rows the user must
 * recognize before typing the bucket name). The report file's path lands
 * last, on its own indented line (pasteable — ADR-0030's copy style).
 * @param {DeletePlan} plan
 * @param {{ everywhere: boolean, reportPath: string, bucket: string }} context
 * @returns {string}
 */
export function formatDeleteSummary(plan, { everywhere, reportPath, bucket }) {
  const lines = [];

  if (plan.deletable.length === 0) {
    lines.push(
      plan.survivors.length === 0
        ? `Delete preview — nothing to delete.`
        : `Delete preview — nothing to delete: every matched file's content ` +
            `is still referenced outside the named paths, so it all survives.`,
    );
  } else {
    lines.push(
      `Delete preview — files no backup could restore once this content is gone:`,
      ``,
    );

    /** @type {[string, string, string][]} */
    const rows = plan.byPath.map(({ path, files: f, bytes }) => [
      path,
      files(f),
      formatByteValue(bytes),
    ]);
    if (plan.sharedFiles > 0) {
      rows.push([
        `shared across ${plan.byPath.length} paths`,
        files(plan.sharedFiles),
        formatByteValue(plan.sharedBytes),
      ]);
    }
    rows.push([
      "total",
      files(plan.totalFiles),
      formatByteValue(plan.totalBytes),
    ]);

    lines.push(
      ...alignTotalTable(
        rows,
        `   (${formatCount(plan.deletable.length)} ` +
          `${plural(plan.deletable.length, "stored object")})`,
      ),
    );

    const inScope = plan.bySet.filter((s) => s.inScope);
    if (inScope.length > 0) {
      lines.push(
        ``,
        `Sets losing these files: ` +
          inScope.map((s) => `${s.set} (${files(s.files)})`).join(", "),
      );
    }

    const outside = plan.bySet.filter((s) => !s.inScope);
    if (outside.length > 0) {
      // Only --everywhere produces these rows: sets not attached on this
      // machine whose snapshots reference the doomed content. Recognizing —
      // or failing to recognize — these names is the decision.
      lines.push(
        ``,
        `WARNING (--everywhere): this also breaks restorability in sets not ` +
          `set up on this machine:`,
        ...outside.map((s) => `  ${s.set}  (${files(s.files)})`),
      );
    }
  }

  if (plan.survivors.length > 0 && !everywhere) {
    /** @type {Map<string, number>} */
    const bySet = new Map();
    for (const { keptBy } of plan.survivors) {
      bySet.set(keptBy.set, (bySet.get(keptBy.set) ?? 0) + 1);
    }
    lines.push(
      ``,
      `Survives (still referenced outside the named paths): ` +
        `${files(plan.survivors.length)} — kept by ` +
        [...bySet]
          .sort((a, b) => a[0].localeCompare(b[0]))
          .map(([set, n]) => `set '${set}' (${files(n)})`)
          .join(", ") +
        `.`,
      `To include a set of yours that isn't attached here: s3cab reattach <set>`,
    );
  }

  if (plan.unreadable.length > 0) {
    // Only ever rendered on the dry-run path — an acting run has already been
    // refused with this *same* text (commands/delete.mjs). One command, one
    // condition, one wording: the preview says what the refusal says, and
    // "Can't delete safely" stays true here because a real run can't proceed.
    lines.push(``, unreadableDeleteMessage(plan.unreadable, bucket));
  }

  lines.push(``, `Full list:`, `  ${reportPath}`);
  return lines.join("\n");
}

/**
 * The preview file's body: a banner saying nothing happened yet, then the
 * exact deletion record a `--delete` run would write (so what the user checks
 * *is* what gets recorded — the two cannot disagree), then the survivors with
 * the reference keeping each alive. Never truncated (ADR-0010).
 * @param {DeletePlan} plan
 * @param {string} record - The would-be record body (`formatDeletionRecord`)
 * @returns {string}
 */
export function formatDeletePreviewFile(plan, record) {
  const parts = [
    `# PREVIEW — nothing has been deleted. A --delete run would write the` +
      `\n# record below into the bucket, then delete the objects it lists.\n`,
    record,
  ];
  if (plan.survivors.length > 0) {
    parts.push(
      [
        `# These matched files survive — content still referenced outside the`,
        `# named paths (the reference that keeps each alive is shown first):`,
        `# kept-by\tpath`,
        ...plan.survivors.map(
          ({ path, keptBy }) => `set '${keptBy.set}': ${keptBy.path}\t${path}`,
        ),
        ``,
      ].join("\n"),
    );
  }
  return parts.join("\n");
}

/** @param {number} n */
const files = (n) => `${formatCount(n)} ${plural(n, "file")}`;
