import { posix, sep } from "node:path";

// The `restore` command (specs/backup.md): pull a set's files back from the
// cloud. Remote-only by nature — local snapshots record only hashes; the file
// *content* lives solely in the bucket's `objects/<sha256>` store — so there is
// no `--remote` flag (like `status`). The command body is built in a later
// slice; this file currently holds only the pure path-filter selector.

/**
 * Normalize a path for filter matching: separators to `/`, and case-folded on
 * Windows. Mirrors how the exclude matcher (tree.mjs) treats paths — `split(sep)`
 * so a backslash is a separator on Windows but a literal character on POSIX, and
 * the `win32` case-insensitivity of `createMatcher`'s `"i"` flag.
 * @param {string} p
 * @returns {string}
 */
const normalize = (p) => {
  const slashed = p.split(sep).join(posix.sep);
  return process.platform === "win32" ? slashed.toLowerCase() : slashed;
};

/**
 * Select which of a manifest's paths a restore should write, given the user's
 * positional `paths…` filters. A filter matches a path that equals it or lies
 * under it (a `/`-boundary prefix), so `…/Photos` selects `…/Photos/beach.jpg`
 * but not `…/PhotosArchive/x.jpg`. Filters are matched against the absolute
 * paths as the manifest stored them (copy one from `list`/`tree`), and a
 * trailing separator is ignored. With no filters every path is selected.
 *
 * Pure and order-preserving (returns the input subset in iteration order) so the
 * restore loop's reporting is deterministic and this is unit-testable without S3.
 * @param {Iterable<string>} paths - The manifest's file paths
 * @param {string[]} filters - Positional path filters (empty = match all)
 * @returns {string[]} The subset of `paths` to restore, in input order
 */
export function selectEntries(paths, filters) {
  const needles = filters
    .map(normalize)
    .map((n) => n.replace(/\/+$/, ""))
    .filter(Boolean);
  if (needles.length === 0) return [...paths];

  const selected = [];
  for (const path of paths) {
    const hay = normalize(path);
    if (needles.some((n) => hay === n || hay.startsWith(n + posix.sep))) {
      selected.push(path);
    }
  }
  return selected;
}
