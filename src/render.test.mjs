import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import { afterEach, describe, it } from "node:test";
import {
  renderBackup,
  renderCleanup,
  renderCompareResult,
  renderForget,
  renderLines,
  renderList,
  renderDelete,
  renderProp,
  renderRestore,
  renderSetup,
  renderStatus,
  renderText,
  renderUpload,
  renderVerify,
} from "./render.mjs";

/** @import { BackupSet } from "./lib/sets.mjs" */
/** @import { CompareResult } from "./lib/compare.mjs" */
/** @import { SetReport } from "./lib/verify.mjs" */
/** @import { CleanupResult } from "./commands/cleanup.mjs" */
/** @import { RestoreResult } from "./commands/restore.mjs" */

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
  skipped: [],
  ...over,
});

// The render layer (ADR-0043) turns a command's returned data into the
// human-readable text the dispatcher writes to stdout. Renderers are pure
// (data in, string out), so they test without any I/O — this is where a
// command's *human* output is pinned as it converts. As slices land, each new
// renderer gets its cases here.

/**
 * A minimal `BackupSet` for the renderer — it reads name/bucket/dirs and
 * `dirsPath`, so the other derived path fields are elided (cast covers the
 * missing ones).
 * @param {string} name
 * @param {string} bucket
 * @param {string[]} dirs
 * @returns {BackupSet}
 */
const set = (name, bucket, dirs) =>
  /** @type {BackupSet} */ ({
    name,
    bucket,
    dirs,
    dirsPath: `/home/me/.s3cab/sets/${name}/dirs.txt`,
  });

describe("renderSetup", () => {
  it("confirms the set with its bucket and member directories, heading them with the editable dirs.txt path", () => {
    const text = renderSetup(
      set("photos", "my-backups", ["/home/me/Photos", "/home/me/Pics"]),
    );

    assert.equal(
      text,
      "Set 'photos' → bucket 'my-backups'\n" +
        "dirs (/home/me/.s3cab/sets/photos/dirs.txt):\n" +
        "  /home/me/Photos\n" +
        "  /home/me/Pics",
    );
  });

  it("steers toward editing dirs.txt when a set has none yet", () => {
    // A reattached set can land with no member dirs (a partial/legacy remote
    // marker); the confirmation must not print an empty directory list, and —
    // since there is no update mode (ADR-0052) — points at the dirs.txt file it
    // just named rather than a `setup` re-run (which would now error).
    const text = renderSetup(set("photos", "my-backups", []));

    assert.match(text, /Set 'photos' → bucket 'my-backups'/);
    assert.match(
      text,
      /dirs \(\/home\/me\/\.s3cab\/sets\/photos\/dirs\.txt\):/,
    );
    assert.match(text, /none yet — add them by editing that file/);
    assert.doesNotMatch(text, /s3cab setup/);
  });
});

describe("renderText", () => {
  it("passes an already-finished string straight through (aws/auth)", () => {
    // The degenerate renderer: the result *is* the prose (ADR-0043 does not
    // structure aws's recipe or auth's status), so it is returned verbatim.
    const recipe = "1. Create the bucket:\n   aws s3api create-bucket ...";
    assert.equal(renderText(recipe), recipe);
    assert.equal(renderText(""), ""); // and an empty string stays empty
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

  it("names each skipped path with its file type", () => {
    // The FUD this exists to kill: "Skipped 1 item" told you a symlink was left
    // out but never which one. The type is printed exactly as the snapshot
    // stored it — the walk writes it readable, so nothing restyles it here.
    const text = renderCompareResult(
      result({
        skipped: [
          {
            path: under("Personal Vault"),
            fileType: "Symbolic Link",
            reason: "Unsupported file type",
          },
        ],
      }),
    );

    assert.match(
      text,
      /\nSkipped \(1\)\n {2}Personal Vault {2}\(Symbolic Link\)/,
    );
    // The one-size-fits-all reason stays in the data, off the line.
    assert.doesNotMatch(text, /Unsupported file type/);
    // Skipped alone is still news, so the summary cannot say "No changes."
    assert.doesNotMatch(text, /No changes/);
    assert.match(
      text,
      /0 added, 0 renamed, 0 moved, 0 modified, 0 deleted · .* changed, 1 skipped$/,
    );
  });

  it("puts Skipped before Errors, after every change section", () => {
    const text = renderCompareResult(
      result({
        deleted: [{ path: under("gone.txt"), size: 10 }],
        skipped: [
          {
            path: under("pipe"),
            fileType: "Named Pipe",
            reason: "Unsupported file type",
          },
        ],
        errors: [{ path: under("locked.bin"), reason: "EACCES" }],
      }),
    );

    assert.ok(text.indexOf("Deleted") < text.indexOf("Skipped"));
    assert.ok(text.indexOf("Skipped") < text.indexOf("Errors"));
    // Printed exactly as stored — nothing between the snapshot and the screen
    // is entitled to reword a type.
    assert.match(text, /\n {2}pipe {2}\(Named Pipe\)/);
    assert.match(text, /, 1 skipped, 1 error$/);
  });

  it("keeps the skipped list on a first snapshot, where the listing is collapsed", () => {
    // `since: null` collapses the all-added listing to a count — but what
    // *couldn't* go in is the one thing that collapse can't tell you, and a
    // first run is when you find out (ADR-0078).
    const text = renderCompareResult(
      result({
        since: null,
        added: [{ path: under("a.jpg"), size: 4, duplicates: [] }],
        skipped: [
          {
            path: under("Personal Vault"),
            fileType: "Symbolic Link",
            reason: "Unsupported file type",
          },
        ],
      }),
    );

    assert.match(text, /First snapshot: 1 file/);
    assert.match(
      text,
      /\nSkipped \(1\)\n {2}Personal Vault {2}\(Symbolic Link\)/,
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

describe("renderList", () => {
  it("lists every set compactly (name + snapshot times, newest first)", () => {
    const text = renderList({
      mode: "summary",
      sets: [
        { name: "photos", snapshots: ["2026-06-12T0915", "2026-06-11T0915"] },
        { name: "docs", snapshots: ["2026-05-12T0946"] },
      ],
    });

    assert.equal(
      text,
      "photos:\n  2026-06-12T0915\n  2026-06-11T0915\n" +
        "docs:\n  2026-05-12T0946",
    );
  });

  it("shows '(none yet)' for a set with no snapshots", () => {
    const text = renderList({
      mode: "summary",
      sets: [{ name: "empty", snapshots: [] }],
    });
    assert.equal(text, "empty:\n  (none yet)");
  });

  it("guides toward creating a set when there are none", () => {
    const text = renderList({ mode: "summary", sets: [] });
    assert.match(text, /No backup sets yet/);
    assert.match(text, /s3cab setup/);
  });

  it("shows a named set's full config (bucket, dirs with path, exclude file) above its snapshots", () => {
    const detailSet = {
      ...set("docs", "my-bucket", ["/data/docs"]),
      dirsPath: "/home/me/.s3cab/sets/docs/dirs.txt",
      excludePath: "/home/me/.s3cab/sets/docs/exclude.txt",
    };
    const text = renderList({
      mode: "detail",
      set: detailSet,
      overrides: { rolesAnywhere: false },
      snapshots: ["2026-05-12T0946"],
      remote: false,
    });

    assert.match(text, /^name: docs\n/);
    assert.match(text, /bucket: my-bucket/);
    assert.match(text, /dirs \(.*docs\/dirs\.txt\):\n {2}\/data\/docs/);
    assert.match(text, /exclude file: .*docs\/exclude\.txt/);
    assert.match(text, /\nsnapshots:\n {2}2026-05-12T0946$/);
    // A set with no provider settings of its own shows no block — absence IS the answer.
    assert.doesNotMatch(text, /provider overrides/);
  });

  it("shows the set's provider overrides after the bucket — the key's tail, never the secret", () => {
    const detailSet = {
      ...set("docs", "my-bucket", []),
      dirsPath: "/d.txt",
      excludePath: "/e.txt",
    };
    const text = renderList({
      mode: "detail",
      set: detailSet,
      overrides: {
        profile: "work",
        endpoint: "https://acct.r2.cloudflarestorage.com",
        region: "auto",
        keyId: "AKIAIOSFODNN7EXAMPLE",
        rolesAnywhere: false,
      },
      snapshots: [],
      remote: false,
    });

    assert.match(
      text,
      /bucket: my-bucket\nprovider overrides:\n {2}AWS profile: work\n {2}endpoint: https:\/\/acct\.r2\.cloudflarestorage\.com\n {2}region: auto\n {2}access keys: set \(…MPLE\)\n/,
    );
  });

  it("shows Roles Anywhere as the sign-in, first in the block", () => {
    const detailSet = {
      ...set("docs", "my-bucket", []),
      dirsPath: "/d.txt",
      excludePath: "/e.txt",
    };
    const text = renderList({
      mode: "detail",
      set: detailSet,
      overrides: { region: "eu-west-1", rolesAnywhere: true },
      snapshots: [],
      remote: false,
    });

    // The sign-in mode leads the block — RA-first, mirroring authNotice and
    // resolveCredentials' RA-before-chain precedence.
    assert.match(
      text,
      /bucket: my-bucket\nprovider overrides:\n {2}sign-in: Roles Anywhere \(keyless\)\n {2}region: eu-west-1\n/,
    );
  });

  it("labels the detail snapshots 'remote snapshots' for --remote", () => {
    const detailSet = {
      ...set("docs", "my-bucket", []),
      dirsPath: "/d.txt",
      excludePath: "/e.txt",
    };
    const text = renderList({
      mode: "detail",
      set: detailSet,
      overrides: { rolesAnywhere: false },
      snapshots: [],
      remote: true,
    });
    // No local dirs → "(none)"; remote heading; no snapshots yet → "(none yet)".
    assert.match(text, /dirs \(\/d\.txt\):\n {2}\(none\)/);
    assert.match(text, /\nremote snapshots:\n {2}\(none yet\)$/);
  });
});

describe("renderLines (tree/hashes)", () => {
  it("renders one entry per line", () => {
    assert.equal(renderLines(["a/x.txt", "a/y.txt"]), "a/x.txt\na/y.txt");
  });

  it("renders an empty list as the empty string (a greppable stream)", () => {
    // tree of an empty set / a store with no objects: the honest, redirectable
    // answer is no lines — a placeholder would corrupt `> file` / a pipe.
    assert.equal(renderLines([]), "");
  });
});

describe("renderProp", () => {
  const props = {
    hash: "c0535e4be2b79ffd93291305436bf889314e4a3faec05ecffcbb7df31ad9e51a",
    size: 1_500_000,
    mtime: "2025-01-15T10:30:00.000Z",
    hashDuration: 0.01,
  };

  // `renderProp` reads S3CAB_DEBUG ambiently; each test pins it, and this
  // restores the prior value so the suite stays order-independent when the
  // environment already sets it.
  const originalDebug = process.env.S3CAB_DEBUG;
  afterEach(() => {
    if (originalDebug === undefined) {
      delete process.env.S3CAB_DEBUG;
    } else {
      process.env.S3CAB_DEBUG = originalDebug;
    }
  });

  it("renders hash, size (bytes + human), and modified time, aligned", () => {
    delete process.env.S3CAB_DEBUG;
    const text = renderProp(props);

    assert.match(text, /^hash {6}c0535e4b/);
    assert.match(text, /\nsize {6}1,500,000 bytes \(1\.5MB\)/);
    assert.match(text, /\nmodified {2}2025-01-15T10:30:00\.000Z$/);
    // The internal hash timing is not shown in the default human view.
    assert.doesNotMatch(text, /hashed|0\.01/);
  });

  it("surfaces the hash timing as a `hashed` row under S3CAB_DEBUG", () => {
    process.env.S3CAB_DEBUG = "1";
    assert.match(renderProp(props), /\nhashed {4}0\.01s$/);
  });
});

describe("renderStatus", () => {
  it("reports the upload count against latest local and remote snapshots", () => {
    const text = renderStatus({
      set: "photos",
      snapshot: "2026-07-04T1000",
      backedUp: "2026-07-01T0900",
      toUpload: 12,
    });
    assert.match(text, /^photos\n/);
    assert.match(text, /\n {2}latest snapshot {3}2026-07-04T1000\n/);
    assert.match(text, /\n {2}backed up {9}2026-07-01T0900\n/);
    assert.match(text, /\n {2}12 objects to upload$/);
  });

  it("collapses to 'up to date' at zero and 'never' when never backed up", () => {
    const text = renderStatus({
      set: "photos",
      snapshot: "2026-07-04T1000",
      backedUp: null,
      toUpload: 0,
    });
    assert.match(text, /\n {2}backed up {9}never\n/);
    assert.match(text, /\n {2}up to date$/);
  });
});

/**
 * A `SetReport` with sensible empties, overlaid by `over`.
 * @param {Partial<SetReport> & { set: string }} over
 * @returns {SetReport}
 */
const report = (over) => ({
  snapshotsChecked: 1,
  referencedObjects: 0,
  problems: [],
  expectedMissing: [],
  unreadableSnapshots: [],
  ...over,
});

describe("renderVerify", () => {
  it("headlines a clean run green and prints no per-set blocks", () => {
    const text = renderVerify(
      {
        bucket: "photos-bucket",
        sets: [
          report({ set: "docs", referencedObjects: 40 }),
          report({ set: "music", referencedObjects: 4002 }),
        ],
      },
      { color: false },
    );
    // 2 sets, 4,042 referenced objects checked — all verified.
    assert.equal(
      text,
      "photos-bucket: 2 sets, 4,042 objects checked — all verified ✓",
    );
  });

  it("maps each problem 1:1 to a file line and headlines the finding count", () => {
    const text = renderVerify(
      {
        bucket: "photos-bucket",
        sets: [
          report({ set: "docs", referencedObjects: 40 }),
          report({
            set: "music",
            referencedObjects: 4002,
            problems: [
              {
                path: "invoices/2024/jan.pdf",
                problem: "missing",
                snapshots: ["2026-06-01", "2026-06-15"],
              },
              {
                path: "reports/q1.xlsx",
                problem: "wrong-size",
                snapshots: ["2026-06-01"],
                recordedSize: 24_102,
                storedSize: 24_000,
              },
            ],
          }),
        ],
      },
      { color: false },
    );

    // Headline: 1 of the 2 sets has findings.
    assert.match(
      text,
      /^photos-bucket: 2 sets, 4,042 objects checked — 1 set with findings ✗\n/,
    );
    // Only the finding set gets a block, with a file count.
    assert.match(text, /\n {2}music {3}2 files with problems\n/);
    assert.doesNotMatch(text, /docs/);
    // missing → which snapshots reference it; wrong-size → recorded vs stored.
    assert.match(
      text,
      /invoices\/2024\/jan\.pdf {3}missing {6}\(in snapshots 2026-06-01, 2026-06-15\)/,
    );
    assert.match(
      text,
      /reports\/q1\.xlsx {9}wrong size {3}\(recorded 24,102 bytes, stored 24,000\)/,
    );
  });

  it("reports an unreadable snapshot as its own finding line", () => {
    const text = renderVerify(
      {
        bucket: "b",
        sets: [
          report({
            set: "music",
            referencedObjects: 10,
            unreadableSnapshots: [
              { snapshot: "2026-05-01T0800", reason: "unexpected end of file" },
            ],
          }),
        ],
      },
      { color: false },
    );
    assert.match(text, /\n {2}music {3}could not fully check\n/);
    assert.match(
      text,
      /snapshot 2026-05-01T0800 could not be read \(unexpected end of file\)/,
    );
  });

  it("emits no ANSI without colour, and colours the verdict + set name with it", () => {
    const data = {
      bucket: "b",
      sets: [
        report({
          set: "docs",
          problems: [{ path: "x", problem: "missing", snapshots: ["s"] }],
        }),
      ],
    };
    const ESC = "\x1b";

    assert.ok(!renderVerify(data, { color: false }).includes(ESC));

    const coloured = renderVerify(data, { color: true });
    // Verdict is red+bold (31/1); the finding set name is red (31).
    assert.ok(coloured.includes(`${ESC}[31m`));
    assert.ok(coloured.includes(`${ESC}[1m`));
  });

  it("reports deliberately deleted files as context under a clean verdict (ADR-0064)", () => {
    const text = renderVerify(
      {
        bucket: "b",
        sets: [
          report({
            set: "media",
            referencedObjects: 10,
            expectedMissing: [
              {
                path: "/data/x.mov",
                snapshots: ["s1"],
                deletedOn: "2026-07-19T1422",
              },
              {
                path: "/data/y.mov",
                snapshots: ["s1"],
                deletedOn: "2026-07-19T1422",
              },
            ],
          }),
        ],
      },
      { color: false },
    );
    assert.match(text, /all verified ✓/);
    assert.match(
      text,
      /\n {2}media {3}2 files deleted from backups \(s3cab delete — deleted 2026-07-19T1422; expected, not damage\)/,
    );
  });

  it("summarizes many deletion dates, reporting the true latest regardless of path order", () => {
    // `expectedMissing` arrives path-sorted (verifySet), so the newest deletion
    // can sit anywhere in the list. Here the newest date is on the
    // alphabetically-first path: taking the raw encounter order's last element
    // would report the *oldest*-looking "latest" — the dates must be sorted.
    const text = renderVerify(
      {
        bucket: "b",
        sets: [
          report({
            set: "media",
            expectedMissing: [
              {
                path: "/data/a.mov",
                snapshots: ["s1"],
                deletedOn: "2026-07-19T1422",
              },
              {
                path: "/data/b.mov",
                snapshots: ["s1"],
                deletedOn: "2026-05-01T0900",
              },
              {
                path: "/data/c.mov",
                snapshots: ["s1"],
                deletedOn: "2026-06-01T0900",
              },
            ],
          }),
        ],
      },
      { color: false },
    );
    assert.match(text, /3 deletions, latest 2026-07-19T1422/);
  });
});

describe("renderBackup", () => {
  it("reports uploads against the candidate set, with an already-stored aside", () => {
    const text = renderBackup({
      set: "photos",
      snapshot: "2026-07-04T1000",
      candidates: 120,
      uploaded: 3,
    });
    assert.equal(
      text,
      "Backed up 'photos' (snapshot 2026-07-04T1000): " +
        "uploaded 3 of 120 objects (117 already stored).",
    );
  });

  it("drops the aside when every candidate uploaded", () => {
    const text = renderBackup({
      set: "photos",
      snapshot: "2026-07-04T1000",
      candidates: 3,
      uploaded: 3,
    });
    assert.equal(
      text,
      "Backed up 'photos' (snapshot 2026-07-04T1000): uploaded 3 objects.",
    );
  });

  it("reports the up-to-date case when nothing was new to upload", () => {
    const text = renderBackup({
      set: "photos",
      snapshot: "2026-07-04T1000",
      candidates: 0,
      uploaded: 0,
    });
    assert.match(text, /already up to date, nothing new to upload\.$/);
  });
});

describe("renderUpload", () => {
  const key =
    "objects/c0535e4be2b79ffd93291305436bf889314e4a3faec05ecffcbb7df31ad9e51a";

  it("confirms a transferred object with its full key and human size", () => {
    const text = renderUpload({
      mode: "file",
      hash: "c0535e4b",
      size: 1_500_000,
      key,
      uploaded: true,
    });
    assert.equal(text, `Uploaded ${key} (1.5MB).`);
    // Never truncated (ADR-0043) — the whole content address is shown.
    assert.match(text, /ad9e51a/);
  });

  it("reports an already-stored object rather than a re-upload", () => {
    const text = renderUpload({
      mode: "file",
      hash: "c0535e4b",
      size: 200,
      key,
      uploaded: false,
    });
    assert.equal(text, `${key} already stored (200B).`);
  });

  it("reports a snapshot upload's content line under an upload headline", () => {
    const text = renderUpload({
      mode: "snapshot",
      set: "photos",
      snapshot: "2026-07-04T1000",
      candidates: 120,
      uploaded: 3,
    });
    assert.equal(
      text,
      "Uploaded snapshot '2026-07-04T1000' to 'photos': " +
        "uploaded 3 of 120 objects (117 already stored).",
    );
  });

  it("reports the up-to-date case for a snapshot upload with nothing new", () => {
    const text = renderUpload({
      mode: "snapshot",
      set: "photos",
      snapshot: "2026-07-04T1000",
      candidates: 0,
      uploaded: 0,
    });
    assert.match(text, /already up to date, nothing new to upload\.$/);
  });

  it("reports a folder seed's content line under a 'Seeded' headline", () => {
    const text = renderUpload({
      mode: "dir",
      set: "photos",
      dir: "/home/me/Photos/2026",
      candidates: 40,
      uploaded: 40,
      skipped: [],
    });
    assert.equal(
      text,
      "Seeded '/home/me/Photos/2026' into 'photos': uploaded 40 objects.",
    );
  });

  it("reports the already-stored case for a folder seed", () => {
    const text = renderUpload({
      mode: "dir",
      set: "photos",
      dir: "/home/me/Photos/2026",
      candidates: 40,
      uploaded: 10,
      skipped: [],
    });
    assert.equal(
      text,
      "Seeded '/home/me/Photos/2026' into 'photos': " +
        "uploaded 10 of 40 objects (30 already stored).",
    );
  });

  it("names every file a folder seed skipped, and the backup that stores them", () => {
    // Each is a file the user asked to seed and didn't get, so the list is given
    // in full (the renderRestore rule) with the reason and the constructive fix.
    const text = renderUpload({
      mode: "dir",
      set: "photos",
      dir: "/home/me/Photos/2026",
      candidates: 40,
      uploaded: 38,
      skipped: [
        { path: "/home/me/Photos/2026/live.raw", reason: "changed" },
        { path: "/home/me/Photos/2026/gone.raw", reason: "removed" },
      ],
    });

    assert.match(text, /uploaded 38 of 40 objects/);
    assert.match(text, /Skipped 2 files that couldn't be confirmed/);
    assert.match(
      text,
      / {2}\/home\/me\/Photos\/2026\/live\.raw {3}\(changed\)/,
    );
    assert.match(
      text,
      / {2}\/home\/me\/Photos\/2026\/gone\.raw {3}\(removed\)/,
    );
    assert.match(text, /nothing to repair/);
    assert.match(text, / {2}s3cab backup photos$/);
  });

  it("says 'file' singular for one skip", () => {
    const text = renderUpload({
      mode: "dir",
      set: "photos",
      dir: "/d",
      candidates: 1,
      uploaded: 0,
      skipped: [{ path: "/d/x.raw", reason: "unreadable" }],
    });
    // Reason-neutral header, so an `unreadable` skip is not described as a change.
    assert.match(text, /Skipped 1 file that couldn't be confirmed/);
    assert.doesNotMatch(text, /changed/);
  });
});

/**
 * A RestoreResult with sensible defaults, overlaid by `over` — keeps each test
 * to the fields it cares about.
 * @param {Partial<RestoreResult>} over
 * @returns {RestoreResult}
 */
const restoreResult = (over) => ({
  set: "photos",
  bucket: "my-backups",
  snapshot: "2026-07-04T1000",
  restored: [],
  skipped: [],
  missing: [],
  deleted: [],
  ...over,
});

describe("renderRestore", () => {
  it("summarizes the written files by set and snapshot", () => {
    const text = renderRestore(
      restoreResult({ restored: ["/home/me/a.jpg", "/home/me/b.jpg"] }),
    );
    assert.equal(
      text,
      "Restored 2 files from 'photos' (snapshot 2026-07-04T1000).",
    );
  });

  it("lists every skipped existing file in full, pointing at --overwrite", () => {
    const text = renderRestore(
      restoreResult({
        restored: ["/home/me/a.jpg"],
        skipped: ["/home/me/b.jpg", "/home/me/c.jpg"],
      }),
    );
    assert.match(
      text,
      /^Restored 1 file from 'photos' \(snapshot 2026-07-04T1000\)\.\n/,
    );
    assert.match(
      text,
      /\nSkipped 2 existing files \(rerun with --overwrite to replace\):\n {2}\/home\/me\/b\.jpg\n {2}\/home\/me\/c\.jpg$/,
    );
  });

  it("keeps the set/snapshot context when everything requested was skipped", () => {
    // restored empty but skipped non-empty (the files existed, no --overwrite):
    // still lead with the count line so the snapshot context isn't lost.
    const text = renderRestore(restoreResult({ skipped: ["/home/me/b.jpg"] }));
    assert.match(
      text,
      /^Restored 0 files from 'photos' \(snapshot 2026-07-04T1000\)\.\n/,
    );
    assert.match(
      text,
      /\nSkipped 1 existing file \(rerun with --overwrite to replace\):\n {2}\/home\/me\/b\.jpg$/,
    );
  });

  it("reports an empty selection plainly instead of blank output", () => {
    const text = renderRestore(restoreResult({}));
    assert.equal(
      text,
      "Nothing to restore from 'photos' (snapshot 2026-07-04T1000).",
    );
  });

  it("names every file the bucket could not supply, and how to check the rest", () => {
    // The missing block comes last (what's left on screen) and carries the
    // copy-pasteable next step, ADR-0030.
    const text = renderRestore(
      restoreResult({
        restored: ["/home/me/a.jpg"],
        missing: ["/home/me/b.jpg", "/home/me/c.jpg"],
      }),
    );
    assert.match(
      text,
      /^Restored 1 file from 'photos' \(snapshot 2026-07-04T1000\)\.\n/,
    );
    assert.match(
      text,
      /\nCould not restore 2 files — the backup no longer holds their contents:\n {2}\/home\/me\/b\.jpg\n {2}\/home\/me\/c\.jpg\n/,
    );
    assert.match(text, /\n {2}s3cab verify my-backups$/);
  });

  it("keeps the set/snapshot context when every requested file was missing", () => {
    // Nothing written and nothing skipped must not read as "Nothing to restore"
    // — that would hide a failed restore behind an empty-selection message.
    const text = renderRestore(restoreResult({ missing: ["/home/me/b.jpg"] }));
    assert.match(
      text,
      /^Restored 0 files from 'photos' \(snapshot 2026-07-04T1000\)\.\n/,
    );
    assert.match(
      text,
      /\nCould not restore 1 file — the backup no longer holds its contents:\n/,
    );
  });

  it("lists deliberately deleted files with their dates, apart from the missing alarm (ADR-0064)", () => {
    const text = renderRestore(
      restoreResult({
        restored: ["/home/me/a.jpg"],
        deleted: [{ path: "/home/me/x.env", deletedOn: "2026-07-19T1422" }],
      }),
    );
    assert.match(
      text,
      /\nSkipped 1 file whose contents were deliberately deleted from the backups \(s3cab delete\):\n {2}\/home\/me\/x\.env {2}\(deleted 2026-07-19T1422\)/,
    );
    assert.doesNotMatch(text, /Could not restore/);
  });
});

describe("renderDelete", () => {
  it("confirms what a completed delete removed, and that snapshots stand", () => {
    const text = renderDelete({
      bucket: "my-backups",
      paths: ["D:\\raw"],
      sets: ["media"],
      everywhere: false,
      deletedObjects: 297,
      deletedFiles: 312,
      deletedBytes: 2_300_000,
      survivors: 0,
      deleted: true,
    });
    assert.equal(
      text,
      "my-backups: deleted 297 objects (2.3MB across 312 files). " +
        "Snapshots were not modified.",
    );
  });

  it("says nothing was deleted for a dry run / declined / nothing-to-do result", () => {
    const text = renderDelete({
      bucket: "my-backups",
      paths: ["D:\\raw"],
      sets: ["media"],
      everywhere: false,
      deletedObjects: 297,
      deletedFiles: 312,
      deletedBytes: 2_300_000,
      survivors: 0,
      deleted: false,
    });
    assert.equal(text, "Nothing was deleted.");
  });
});

describe("renderForget", () => {
  it("records a forgotten snapshot", () => {
    assert.equal(
      renderForget({
        set: "photos",
        snapshots: ["2026-06-12T0915"],
        forgotten: true,
      }),
      "Snapshot '2026-06-12T0915' forgotten from set 'photos'.",
    );
  });

  it("counts a multi-snapshot removal rather than listing them again", () => {
    // The names were just echoed in the confirmation prompt; the result line is
    // the tally.
    assert.equal(
      renderForget({
        set: "photos",
        snapshots: ["2026-06-12T0915", "2026-06-19T0902"],
        forgotten: true,
      }),
      "2 snapshots forgotten from set 'photos'.",
    );
  });

  it("records a declined removal as kept", () => {
    assert.equal(
      renderForget({
        set: "photos",
        snapshots: ["2026-06-12T0915"],
        forgotten: false,
      }),
      "Snapshot '2026-06-12T0915' kept — nothing was removed.",
    );
  });
});

describe("renderCleanup", () => {
  /** @param {Partial<CleanupResult>} over */
  const cleanupResult = (over) => ({
    bucket: "my-backups",
    storedObjects: 1024,
    referencedObjects: 980,
    orphanObjects: 44,
    reclaimableBytes: 2_300_000,
    withinGrace: 0,
    missingObjects: 0,
    deleted: 0,
    ...over,
  });

  it("reports the inventory for a dry run (nothing deleted)", () => {
    const text = renderCleanup(cleanupResult({}));
    assert.equal(
      text,
      "my-backups: 1,024 objects stored, 44 orphaned (2.3MB reclaimable)",
    );
  });

  it("appends the grace and missing tallies only when non-zero", () => {
    const text = renderCleanup(
      cleanupResult({ withinGrace: 12, missingObjects: 3 }),
    );
    assert.match(text, /, 12 too new to touch \(7-day grace\)/);
    assert.match(text, /, 3 missing \(referenced but absent\)$/);
  });

  it("reports what a --delete run reclaimed", () => {
    const text = renderCleanup(
      cleanupResult({
        orphanObjects: 44,
        reclaimableBytes: 2_300_000,
        deleted: 44,
      }),
    );
    assert.equal(
      text,
      "my-backups: deleted 44 orphaned objects, reclaimed 2.3MB.",
    );
  });
});
