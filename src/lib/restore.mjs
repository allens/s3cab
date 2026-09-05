import { join, posix, resolve, sep } from "node:path";

import { foldsCase } from "./path-match.mjs";

/** @import { Props, SnapshotEntries } from "./snapshot-file.mjs" */

/**
 * Normalize a path for filter matching: separators to `/`, and case-folded on
 * Windows. Mirrors how the exclude matcher (lib/exclude.mjs) treats paths —
 * `split(sep)` so a backslash is a separator on Windows but a literal character
 * on POSIX, and the `win32` case-insensitivity of `compileExclude`'s `"i"` flag.
 * @param {string} p
 * @returns {string}
 */
const normalize = (p) => {
  const slashed = p.split(sep).join(posix.sep);
  return process.platform === "win32" ? slashed.toLowerCase() : slashed;
};

/**
 * @typedef {Object} RestoreStep
 * @property {string} dest - Where this entry is written (or left alone, for `skip`)
 * @property {"skip" | "fetch" | "copy"} action
 * @property {string} [hash] - Content hash (`fetch`/`copy` only)
 * @property {string} [mtime] - Snapshot mtime, as stored (`fetch`/`copy` only)
 * @property {string} [from] - Local path to copy from (`copy` only)
 */

/**
 * Decide what to do with each restore target, without touching the disk or the
 * network. Mirrors the snapshot's content-addressing: the first target with a
 * given hash is `fetch`ed, and every later target with the same hash is a
 * `copy` from wherever the first one landed (design #1 — identical content
 * downloads once). A target whose destination already exists is `skip`ped
 * unless `overwrite` — and a skipped entry never seeds the dedupe, since a
 * pre-existing file's content is unverified and so untrusted as a copy source.
 *
 * Pure and order-preserving, like `selectEntries`/`reroot`: `exists` is
 * injected so this is unit-testable without touching the filesystem.
 * @param {SnapshotEntries} entries - Source path → `{ hash, mtime }`
 * @param {string[]} targets - Snapshot source paths to restore, in order
 * @param {(source: string) => string} destFor - Maps a source path to its destination
 * @param {object} options
 * @param {(dest: string) => boolean} options.exists - Whether `dest` already exists
 * @param {boolean} [options.overwrite] - Overwrite an existing destination instead of skipping it
 * @returns {RestoreStep[]} One step per target, in input order
 */
export function planRestore(
  entries,
  targets,
  destFor,
  { exists, overwrite = false },
) {
  /** @type {RestoreStep[]} */
  const plan = [];
  /** @type {Map<string, string>} */
  const fetchedDestByHash = new Map();

  for (const source of targets) {
    const dest = destFor(source);
    if (exists(dest) && !overwrite) {
      plan.push({ dest, action: "skip" });
      continue;
    }

    const { hash, mtime } = /** @type {Props} */ (entries.get(source));
    const from = fetchedDestByHash.get(hash);
    if (from) {
      plan.push({ dest, action: "copy", hash, mtime, from });
    } else {
      plan.push({ dest, action: "fetch", hash, mtime });
      fetchedDestByHash.set(hash, dest);
    }
  }

  return plan;
}

/**
 * Select which of a snapshot's paths a restore should write, given the user's
 * positional `paths…` filters. A filter matches a path that equals it or lies
 * under it (a `/`-boundary prefix), so `…/Photos` selects `…/Photos/beach.jpg`
 * but not `…/PhotosArchive/x.jpg`. Filters are matched against the absolute
 * paths as the snapshot stored them (copy one from `list`/`tree`), and a
 * trailing separator is ignored. With no filters every path is selected.
 *
 * Pure and order-preserving (returns the input subset in iteration order) so the
 * restore loop's reporting is deterministic and this is unit-testable without S3.
 * @param {Iterable<string>} paths - The snapshot's file paths
 * @param {string[]} filters - Positional path filters (empty = match all)
 * @returns {string[]} The subset of `paths` to restore, in input order
 */
export function selectEntries(paths, filters) {
  const matches = pathMatcher(filters);
  return matches ? [...paths].filter(matches) : [...paths];
}

/**
 * Build the "does this path fall under any of these filters?" predicate that
 * `selectEntries` applies — a filter matches a path that equals it or lies under
 * it (a `/`-boundary prefix), separators unified and case folded on Windows
 * (`normalize`), a trailing separator ignored. Exported on its own because
 * `delete` asks the same question of snapshot *references* (which paths fall
 * under the named paths) — one matcher, so `restore`'s filters and `delete`'s
 * scope can never drift apart in what "under" means.
 *
 * Returns `undefined` when no filter survives normalization (none given, or
 * all blank/separator-only) — "no effective filter" is a fact each caller must
 * decide about, in opposite directions: `selectEntries` selects *everything*
 * (no filter means restore it all), while `delete` must match *nothing* (a
 * blank path silently matching the whole backup is the catastrophe). Handing
 * back a predicate that quietly picked either default would bake the wrong
 * one into somebody.
 * @param {string[]} filters - Path filters, as the user gave them
 * @returns {((path: string) => boolean) | undefined}
 */
export function pathMatcher(filters) {
  const needles = filters
    .map(normalize)
    .map((n) => n.replace(/\/+$/, ""))
    .filter(Boolean);
  if (needles.length === 0) {
    return undefined;
  }
  return (path) => {
    const hay = normalize(path);
    return needles.some((n) => hay === n || hay.startsWith(n + posix.sep));
  };
}

/**
 * Build the path re-rooter for `restore --output <dir>`: each file in the snapshot lands
 * under `<output>/<member-root-basename>/<path-below-that-root>` — shallow and
 * human-readable, and valid on *this* machine regardless of where the backup was
 * taken (docs/design/backup.md). The member roots are the snapshot's `#DIR` headers.
 *
 * Separator-agnostic, so a Windows snapshot re-roots correctly on POSIX and vice
 * versa: roots and paths are split on both `/` and `\`, and matched by exact
 * segments. Case-folded when — and only when — the root is Windows-shaped, since
 * there the two spellings name one file (`foldsCase`); the basename-collision
 * check below folds unconditionally, deliberately, to catch two roots that would
 * land in the same `<output>` directory. The destination is rebuilt with this
 * platform's separator under `output`. The longest matching root wins, so a
 * nested member dir takes precedence over a parent.
 *
 * `snapshot` writes canonical roots, so its own headers already agree with its
 * rows — the folding is for a snapshot a *user* has edited, which is a supported
 * thing to do to a file we promise is plain text (ADR-0002). It keys on the
 * path's shape rather than `process.platform` for the reason `path-match.mjs`
 * documents: a Windows snapshot restored on Linux is exactly the case `--output`
 * exists for.
 *
 * Two roots whose basename collides (e.g. `C:\a\Photos` and `D:\b\Photos`, both
 * wanting `<output>/Photos`) are rejected up front: restore them one at a time
 * with a path filter, or to their original locations. Pure and side-effect-free
 * (unit-testable without S3), like `selectEntries`.
 * @param {string[]} dirs - The snapshot's member roots (its `#DIR` headers)
 * @param {string} output - The `--output` directory
 * @returns {(path: string) => string} Maps a snapshot path to its destination
 */
export function reroot(dirs, output) {
  if (dirs.length === 0) {
    throw new Error(
      "This snapshot has no directory headers, so --output cannot re-root it. " +
        "Omit --output to restore to the original locations instead.",
    );
  }

  const roots = dirs
    .map((dir) => {
      const segments = dir.split(/[\\/]/).filter(Boolean);
      return {
        segments,
        base: segments.at(-1) ?? "",
        fold: foldsCase(dir),
      };
    })
    // Longest first: a nested root must win over a parent that also matches.
    .sort((a, b) => b.segments.length - a.segments.length);

  const seen = new Set();
  for (const { base } of roots) {
    const key = base.toLowerCase();
    if (seen.has(key)) {
      throw new Error(
        `Two backed-up directories are both named "${base}", so --output cannot keep ` +
          `them apart under one root. Restore them one at a time with a path ` +
          `filter, or to their original locations.`,
      );
    }
    seen.add(key);
  }

  const base = resolve(output);
  return (path) => {
    const segments = path.split(/[\\/]/).filter(Boolean);
    const root = roots.find(
      (r) =>
        r.segments.length <= segments.length &&
        r.segments.every((seg, i) => {
          // The length guard above puts `i` in range; `?? ""` is for the type
          // checker, and can't match a segment (they're non-empty by `filter`).
          const other = segments[i] ?? "";
          return r.fold
            ? seg.toLowerCase() === other.toLowerCase()
            : seg === other;
        }),
    );
    if (!root) {
      throw new Error(
        `Path is not under any backed-up directory, so --output cannot place it: ${path}`,
      );
    }
    // No `.`/`..` sandbox guard here on purpose: snapshot paths are first-party
    // (written by `snapshot` walking the real filesystem, which never emits `.`
    // or `..` segments), and a `..` could only arrive in a hand-crafted snapshot
    // — outside the trust model (your own bucket, your own backups, #2). Guarding
    // only `--output` would also be inconsistent: plain `restore` writes straight
    // to the snapshot's absolute paths, so it already trusts the snapshot to
    // direct writes anywhere. (Reviewers re-flag this as path traversal; it is a
    // deliberate non-guard, not an oversight — see PR #55.)
    return join(base, root.base, ...segments.slice(root.segments.length));
  };
}
