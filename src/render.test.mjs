import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import { describe, it } from "node:test";
import { renderCompareResult, renderSetup } from "./render.mjs";

/** @import { BackupSet } from "./lib/sets.mjs" */
/** @import { CompareResult } from "./lib/compare.mjs" */

// An absolute base for building snapshot-shaped paths — under the home dir so
// the header's `~` shortening is exercised, platform-correct.
const ROOT = join(homedir(), "Pictures");
const under = (/** @type {string[]} */ ...parts) => join(ROOT, ...parts);

/**
 * A CompareResult with sensible defaults, overlaid by `over` — keeps each test
 * to the fields it cares about.
 * @param {Partial<CompareResult>} over
 * @returns {CompareResult}
 */
const result = (over) => ({
  setName: "photos",
  dirs: [ROOT],
  since: "2026-07-01T0900",
  until: "2026-07-04T1000",
  added: [],
  moved: [],
  modified: [],
  deleted: [],
  errors: [],
  ...over,
});

// The render layer (ADR-0043) turns a command's returned data into the
// human-readable text the dispatcher writes to stdout. Renderers are pure
// (data in, string out), so they test without any I/O — this is where a
// command's *human* output is pinned as it converts. As slices land, each new
// renderer gets its cases here.

/**
 * A minimal `BackupSet` for the renderer — it reads only name/bucket/dirs, so
 * the derived path fields are elided (cast covers the missing ones).
 * @param {string} name
 * @param {string} bucket
 * @param {string[]} dirs
 * @returns {BackupSet}
 */
const set = (name, bucket, dirs) =>
  /** @type {BackupSet} */ ({ name, bucket, dirs });

describe("renderSetup", () => {
  it("confirms the set with its bucket and member directories", () => {
    const text = renderSetup(
      set("photos", "my-backups", ["/home/me/Photos", "/home/me/Pics"]),
    );

    assert.equal(
      text,
      "Set 'photos' → bucket 'my-backups'\n" +
        "  /home/me/Photos\n" +
        "  /home/me/Pics",
    );
  });

  it("guides toward adding directories when a set has none yet", () => {
    // An inherited set can land with no member dirs (a partial/legacy remote
    // marker); the confirmation must not print an empty directory list, and
    // should point at how to add them.
    const text = renderSetup(set("photos", "my-backups", []));

    assert.match(text, /Set 'photos' → bucket 'my-backups'/);
    assert.match(text, /no directories yet/);
    assert.match(text, /s3cab setup photos <directory>\.\.\./);
  });
});

describe("renderCompareResult", () => {
  it("renders header, per-category sections (only non-empty), and a summary", () => {
    const text = renderCompareResult(
      result({
        added: [
          { path: under("2025", "beach.jpg"), size: 5_000_000, duplicates: [] },
          {
            path: under("logo.png"),
            size: 1200,
            duplicates: [under("brand", "logo.png")],
          },
        ],
        moved: [
          {
            path: under("old", "report.pdf"),
            size: 300_000,
            to: under("2025", "report.pdf"),
          },
        ],
        modified: [{ path: under("notes.txt"), size: 200 }],
      }),
    );

    // Header: set name, base (home-shortened), and the compared range.
    assert.match(
      text,
      /^photos: ~[\\/]Pictures {2}2026-07-01T0900 → 2026-07-04T1000\n/,
    );
    // Sections with counts, paths shortened to the common base.
    assert.match(text, /\nAdded \(2\)\n {2}2025[\\/]beach\.jpg\n/);
    assert.match(
      text,
      /\n {2}logo\.png {2}\(duplicate of brand[\\/]logo\.png\)\n/,
    );
    assert.match(
      text,
      /\nMoved \(1\)\n {2}old[\\/]report\.pdf → 2025[\\/]report\.pdf\n/,
    );
    assert.match(text, /\nModified \(1\)\n {2}notes\.txt\n/);
    // Empty categories (deleted, errors) are omitted, not shown as "(0)".
    assert.doesNotMatch(text, /Deleted/);
    assert.doesNotMatch(text, /Errors/);
    // Summary lists every category (zeros included) + bytes changed.
    assert.match(
      text,
      /\n2 added, 0 renamed, 1 moved, 1 modified, 0 deleted · [\d.]+\wB changed$/,
    );
  });

  it("splits the one `moved` category into Renamed (same dir) and Moved (cross dir)", () => {
    // The data has a single `moved`; the human view distinguishes a rename
    // (same directory) from a move (different directory) — a real difference to
    // a person (build spec / ADR-0043).
    const text = renderCompareResult(
      result({
        moved: [
          // same directory → a rename
          { path: under("docs", "a.txt"), size: 1, to: under("docs", "b.txt") },
          // different directory → a move
          { path: under("in", "c.txt"), size: 2, to: under("out", "c.txt") },
        ],
      }),
    );

    assert.match(
      text,
      /\nRenamed \(1\)\n {2}docs[\\/]a\.txt → docs[\\/]b\.txt\n/,
    );
    assert.match(text, /\nMoved \(1\)\n {2}in[\\/]c\.txt → out[\\/]c\.txt\n/);
    // Renamed precedes Moved (ascending impact).
    assert.ok(text.indexOf("Renamed") < text.indexOf("Moved"));
    // Summary counts them separately.
    assert.match(text, /0 added, 1 renamed, 1 moved, 0 modified, 0 deleted/);
  });

  it("emits no ANSI escapes without colour, and colours headers (not items) with it", () => {
    const data = result({
      added: [{ path: under("a.jpg"), size: 1, duplicates: [] }],
    });
    const ESC = "\x1b"; // build the escape as a string — no control char in a regex

    const plain = renderCompareResult(data, { color: false });
    assert.ok(!plain.includes(ESC), "no ANSI escapes without colour");

    const coloured = renderCompareResult(data, { color: true });
    // The header is wrapped in green (32/39); the item line is not decorated.
    assert.ok(coloured.includes(`${ESC}[32mAdded (1)${ESC}[39m`));
    assert.match(coloured, /\n {2}a\.jpg\n/); // item stays plain
  });

  it("collapses a first snapshot (since === null) to a one-line count", () => {
    const text = renderCompareResult(
      result({
        since: null,
        added: [
          { path: under("a.jpg"), size: 3_000_000_000, duplicates: [] },
          { path: under("b.jpg"), size: 1_200_000_000, duplicates: [] },
        ],
      }),
    );

    assert.match(text, /First snapshot: 2 files \([\d.]+GB\)/);
    // The whole added listing is suppressed — no per-file lines, no "Added (2)".
    assert.doesNotMatch(text, /Added \(/);
    assert.doesNotMatch(text, /a\.jpg/);
    // The header shows only `until` (there is no `since`).
    assert.match(text, /^photos: ~[\\/]Pictures {2}2026-07-04T1000\n/);
  });

  it("collapses to 'No changes.' when nothing differs", () => {
    const text = renderCompareResult(result({}));
    assert.match(text, /\nNo changes\.$/);
    assert.doesNotMatch(text, /Added|Moved|Modified|Deleted/);
  });

  it("shows deleted and errors, appending the error count to the summary", () => {
    const text = renderCompareResult(
      result({
        deleted: [{ path: under("gone.txt"), size: 10 }],
        errors: [
          { path: under("locked.bin"), reason: "EACCES: permission denied" },
        ],
      }),
    );

    assert.match(text, /\nDeleted \(1\)\n {2}gone\.txt\n/);
    assert.match(
      text,
      /\nErrors \(1\)\n {2}locked\.bin {2}\(EACCES: permission denied\)/,
    );
    assert.match(
      text,
      /0 added, 0 renamed, 0 moved, 0 modified, 1 deleted · .* changed, 1 error$/,
    );
  });

  it("shortens against the common ancestor of multiple roots", () => {
    // Two roots under one parent: the base is that parent, so each path keeps
    // its root segment (replacing the old per-root shortest-wins shortening).
    const rootA = resolve(sep, "data", "rootA");
    const rootB = resolve(sep, "data", "rootB");
    const text = renderCompareResult(
      result({
        dirs: [rootA, rootB],
        modified: [
          { path: join(rootA, "sub", "x.txt"), size: 1 },
          { path: join(rootB, "y.txt"), size: 2 },
        ],
      }),
    );

    assert.match(text, new RegExp(`rootA\\${sep}sub\\${sep}x\\.txt`));
    assert.match(text, new RegExp(`rootB\\${sep}y\\.txt`));
  });

  it("shortens correctly when roots share only the drive / filesystem root", () => {
    // The common ancestor lands exactly on the root (POSIX `/`, Windows `C:\`).
    // A naive segment-join base ("" or a bare "C:") makes path.relative emit
    // wrong `..` escapes; the base must be re-formed into the real root.
    const rootA = resolve(sep, "aaa");
    const rootB = resolve(sep, "bbb");
    const text = renderCompareResult(
      result({
        dirs: [rootA, rootB],
        modified: [{ path: join(rootA, "x.txt"), size: 1 }],
      }),
    );

    assert.match(text, new RegExp(`(^| )aaa\\${sep}x\\.txt`));
    assert.doesNotMatch(text, /\.\./); // no parent-escape garbage
  });

  it("keeps a top segment starting with '..' relative, not an escape", () => {
    // `..stuff` under the root is a real directory name, not a parent escape —
    // it must display relative (this is the case compare.test.mjs delegates here).
    const text = renderCompareResult(
      result({ modified: [{ path: under("..stuff", "file.txt"), size: 1 }] }),
    );
    assert.match(text, new RegExp(`\\.\\.stuff\\${sep}file\\.txt`));
  });
});
