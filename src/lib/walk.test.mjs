import assert from "node:assert/strict";
import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdtempDisposable } from "node:fs/promises";
import { dirname, join, posix, relative, sep } from "node:path";
import { describe, it } from "node:test";
import { walkDirs, walkSet } from "./walk.mjs";

/** @import { BackupSet } from "./sets.mjs" */

/**
 * A minimal resolved set for `walkSet` — it reads only name/dirs/dirsPath/
 * excludePath (the exclude path points at a nonexistent file so no patterns
 * load); the cast covers the other derived fields.
 * @param {string} root
 * @param {string[]} dirs
 * @returns {BackupSet}
 */
const setOf = (root, dirs) =>
  /** @type {BackupSet} */ ({
    name: "photos",
    dirs,
    dirsPath: join(root, "dirs.txt"),
    excludePath: join(root, "no-such-exclude.txt"),
  });

const mkTmpDir = async () => mkdtempDisposable(join("test", ".tmp"));

// These exercise the walk core `walkDirs(dirs, patterns)` directly: multi-root
// accumulation into `{ files, excluded }`, the always-skip `.s3cab`, overlap
// detection, directory recursion, and the exclusion records the walk hands back
// as data. The glob → RegExp semantics are unit-tested in exclude.test.mjs.

/**
 * Write a file under `base`, creating parent directories. `relPath` always
 * uses `/` as the separator.
 * @param {string} base
 * @param {string} relPath
 * @param {string} [contents]
 */
function write(base, relPath, contents = "x") {
  const full = join(base, ...relPath.split("/"));
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, contents);
}

/**
 * Make absolute paths relative to `root`, `/`-separated and sorted.
 * @param {string} root
 * @param {string[]} paths
 */
const relPaths = (root, paths) =>
  paths.map((path) => relative(root, path).split(sep).join(posix.sep)).sort();

/**
 * Create the given files under `base`, walk it with the given patterns, and
 * return what survived — relative to the root, `/`-separated, sorted.
 * @param {string} base
 * @param {string[]} patterns - Exclude patterns.
 * @param {string[]} paths - Files to create (always `/`-separated).
 */
function walkWithExcludes(base, patterns, paths) {
  for (const path of paths) {
    write(base, path);
  }
  const root = realpathSync.native(base);
  return relPaths(root, walkDirs([base], patterns).files);
}

describe("walkDirs", () => {
  it("drops patterned files, always skips .s3cab, keeps the rest", async () => {
    await using dir = await mkTmpDir();
    const base = dir.path;

    // Kept
    write(base, "keep.txt");
    write(base, "sub/keep.txt");

    // Dropped by exclude patterns (in root and in a subdirectory)
    write(base, ".DS_Store");
    write(base, "Thumbs.db");
    write(base, "scratch.tmp");
    write(base, "sub/.DS_Store");
    write(base, "sub/Thumbs.db");
    write(base, "sub/scratch.tmp");

    // The walker always skips a .s3cab/ directory, so its contents never surface
    // (defensive against stale snapshot directories left in a backed-up tree).
    write(base, ".s3cab/should-not-appear.txt");

    const root = realpathSync.native(base);
    const found = relPaths(
      root,
      walkDirs([base], ["**/*.tmp", "**/.DS_Store", "**/Thumbs.db"]).files,
    );

    assert.deepStrictEqual(found, ["keep.txt", "sub/keep.txt"]);
  });

  it("walks several roots into one list", async () => {
    await using dir = await mkTmpDir();
    const a = join(dir.path, "a");
    const b = join(dir.path, "b");
    write(a, "1.txt");
    write(a, "sub/2.txt");
    write(b, "3.txt");

    const found = relPaths(
      realpathSync.native(dir.path),
      walkDirs([a, b], []).files,
    );

    assert.deepStrictEqual(found, ["a/1.txt", "a/sub/2.txt", "b/3.txt"]);
  });

  it("errors clearly when member roots overlap, naming the duplicate file", async () => {
    await using dir = await mkTmpDir();
    write(dir.path, "top.txt");
    write(dir.path, "inner/deep.txt");
    const inner = join(dir.path, "inner");
    const duplicate = join(realpathSync.native(dir.path), "inner", "deep.txt");

    // A nested root re-walks files the outer root already yielded; the error
    // names the cause (overlapping directories) rather than a bare invariant,
    // and points at the offending file so the user can see which roots collide.
    assert.throws(
      () => walkDirs([dir.path, inner], []),
      (err) =>
        err instanceof Error &&
        /overlap/.test(err.message) &&
        err.message.includes(duplicate),
    );
  });

  it("applies patterns relative to each root", async () => {
    await using dir = await mkTmpDir();
    const a = join(dir.path, "a");
    const b = join(dir.path, "b");
    write(a, "drop.tmp");
    write(a, "keep.txt");
    write(b, "drop.tmp");
    write(b, "keep.txt");

    // `*.tmp` is anchored at each root, so both roots' drop.tmp go.
    const found = relPaths(
      realpathSync.native(dir.path),
      walkDirs([a, b], ["*.tmp"]).files,
    );

    assert.deepStrictEqual(found, ["a/keep.txt", "b/keep.txt"]);
  });

  it("a trailing slash excludes a directory and everything inside it", async () => {
    await using dir = await mkTmpDir();

    const found = walkWithExcludes(
      dir.path,
      ["build/"],
      ["build/out.js", "build/sub/deep.js", "builder/keep.js"],
    );

    // `builder/` is a different segment and must survive; the walk must not
    // recurse into the excluded `build/`.
    assert.deepStrictEqual(found, ["builder/keep.js"]);
  });

  it("hands back exclusion records (the matched pattern and dirent type) as data", async () => {
    await using dir = await mkTmpDir();
    const base = dir.path;
    write(base, "keep.txt");
    write(base, "scratch.tmp");
    // An excluded directory yields ONE record (the walk doesn't recurse into
    // it), not one per file inside — so its contents never reach `excluded`.
    write(base, "build/out.js");
    write(base, "build/sub/deep.js");

    const root = realpathSync.native(base);
    const { files, excluded } = walkDirs([base], ["**/*.tmp", "build/"]);

    assert.deepStrictEqual(relPaths(root, files), ["keep.txt"]);

    const records = excluded
      .map(({ fileType, reason, path }) => ({
        fileType,
        reason,
        path: relative(root, path).split(sep).join(posix.sep),
      }))
      .sort((a, b) => a.path.localeCompare(b.path));
    assert.deepStrictEqual(records, [
      { fileType: "Directory", reason: "build/", path: "build" },
      { fileType: "File", reason: "**/*.tmp", path: "scratch.tmp" },
    ]);
  });

  it("returns no exclusion records when no patterns are given", async () => {
    await using dir = await mkTmpDir();
    write(dir.path, "a.txt");
    write(dir.path, "b.tmp");

    // With an empty pattern list the walk does no matching at all, so nothing
    // is recorded as excluded (everything is kept).
    const { files, excluded } = walkDirs([dir.path], []);
    assert.equal(files.length, 2);
    assert.deepStrictEqual(excluded, []);
  });

  it(
    "records unsupported file types in skipped (not excluded), never in files",
    {
      skip:
        process.platform === "win32"
          ? "symlink creation requires Developer Mode on Windows"
          : false,
    },
    async () => {
      await using dir = await mkTmpDir();
      const base = dir.path;
      write(base, "regular.txt");
      // Symlinks are an unsupported type: they can't be content-addressed without
      // deciding whether to follow them (and may create cycles). They belong in
      // `skipped` (by-design, not backupable), not `excluded` (user-pattern match)
      // and not `files` — regardless of whether patterns exist.
      symlinkSync(join(base, "regular.txt"), join(base, "link.txt"));

      const root = realpathSync.native(base);

      // With patterns: symlink lands in skipped, not excluded
      const withPatterns = walkDirs([base], ["*.tmp"]);
      assert.deepStrictEqual(relPaths(root, withPatterns.files), [
        "regular.txt",
      ]);
      assert.deepStrictEqual(withPatterns.excluded, []);
      assert.equal(withPatterns.skipped.length, 1);
      const [wp0] = withPatterns.skipped;
      assert.ok(wp0);
      assert.equal(wp0.reason, "Unsupported file type");
      assert.equal(wp0.fileType, "SymbolicLink");

      // Without patterns: same — still goes to skipped, not silently passed through
      const noPatterns = walkDirs([base], []);
      assert.deepStrictEqual(relPaths(root, noPatterns.files), ["regular.txt"]);
      assert.deepStrictEqual(noPatterns.excluded, []);
      assert.equal(noPatterns.skipped.length, 1);
      const [np0] = noPatterns.skipped;
      assert.ok(np0);
      assert.equal(np0.reason, "Unsupported file type");
    },
  );

  it(
    "spaces the stored type token for the notice, leaving the record's alone",
    {
      skip:
        process.platform === "win32"
          ? "symlink creation requires Developer Mode on Windows"
          : false,
    },
    async (t) => {
      await using dir = await mkTmpDir();
      const base = dir.path;
      write(base, "regular.txt");
      symlinkSync(join(base, "regular.txt"), join(base, "link.txt"));
      symlinkSync(join(base, "regular.txt"), join(base, "link2.txt"));

      const warn = t.mock.method(console, "warn", () => {});
      const { skipped } = walkDirs([base], []);

      const notices = warn.mock.calls
        .map(({ arguments: args }) => args.join(" "))
        .filter((line) => line.startsWith("Skipped"));

      // The sentence gets `Symbolic Links`; the record the snapshot is written
      // from keeps `SymbolicLink`, which is the format's own token.
      assert.deepEqual(notices, [
        "Skipped 2 items that can't be backed up: 2 Symbolic Links",
      ]);
      assert.deepEqual(
        skipped.map(({ fileType }) => fileType),
        ["SymbolicLink", "SymbolicLink"],
      );
    },
  );
});

describe("walkSet dirs guard (ADR-0054)", () => {
  it("walks a set whose directories all exist", async () => {
    await using dir = await mkTmpDir();
    write(dir.path, "a.txt");
    const root = realpathSync.native(dir.path);
    const { files } = walkSet(setOf(dir.path, [root]));
    assert.deepStrictEqual(relPaths(root, files), ["a.txt"]);
  });

  it("aborts and lists every unavailable directory, pointing at the set's dirs.txt", async () => {
    await using dir = await mkTmpDir();
    const present = realpathSync.native(dir.path);
    const missingA = join(present, "gone-a");
    const missingB = join(present, "gone-b");
    const set = setOf(present, [present, missingA, missingB]);
    assert.throws(
      () => walkSet(set),
      (error) =>
        error instanceof Error &&
        /aren't available/.test(error.message) &&
        // aggregates *every* offender (not fail-at-first) …
        error.message.includes(missingA) &&
        error.message.includes(missingB) &&
        // … and points at the exact file to edit.
        error.message.includes(set.dirsPath),
    );
  });

  it("rejects a member path that is a file, not a directory", async () => {
    await using dir = await mkTmpDir();
    write(dir.path, "notadir.txt");
    const root = realpathSync.native(dir.path);
    assert.throws(
      () => walkSet(setOf(root, [join(root, "notadir.txt")])),
      /aren't available/,
    );
  });

  it("rejects an empty dirs list (nothing to back up)", async () => {
    await using dir = await mkTmpDir();
    assert.throws(
      () => walkSet(setOf(dir.path, [])),
      /no directories to back up[\s\S]*dirs\.txt/,
    );
  });
});

// Windows forbids characters 1-31 in a filename, so these names cannot exist
// there — the refusal can only fire on Linux or macOS, where CI also runs.
const posixOnly = { skip: process.platform === "win32" };

describe("walkDirs refuses paths the snapshot TSV can't hold (ADR-0073)", () => {
  it(
    "aborts on a tab, naming every offender with the character made visible",
    posixOnly,
    async () => {
      await using dir = await mkTmpDir();
      write(dir.path, "fine.txt");
      write(dir.path, "odd\tname.jpg");
      write(dir.path, "another\tone.jpg");
      assert.throws(
        () => walkDirs([dir.path], []),
        (error) =>
          error instanceof Error &&
          // every offender, never truncated (ADR-0010) …
          error.message.includes("odd<TAB>name.jpg") &&
          error.message.includes("another<TAB>one.jpg") &&
          // … rendered visibly, so a raw tab can't silently indent the list …
          !error.message.includes("odd\tname.jpg") &&
          // … and the way out is named.
          /exclude file/.test(error.message),
      );
    },
  );

  it(
    "aborts on a line break, and on a trailing carriage return",
    posixOnly,
    async () => {
      await using dir = await mkTmpDir();
      write(dir.path, "two\nlines.jpg");
      assert.throws(() => walkDirs([dir.path], []), /two<NL>lines\.jpg/);

      await using other = await mkTmpDir();
      // Not idle strictness: the snapshot parser reads with `crlfDelay: Infinity`,
      // so a trailing \r would be stripped and the path would come back changed.
      write(other.path, "trailing\r.jpg");
      assert.throws(() => walkDirs([other.path], []), /trailing<CR>\.jpg/);
    },
  );

  it(
    "does not abort when a pattern already excludes the offender",
    posixOnly,
    async () => {
      await using dir = await mkTmpDir();
      write(dir.path, "keep.txt");
      write(dir.path, "odd\tname.jpg");
      // The refusal sits in the kept-files loop, which an excluded entry never
      // reaches — that is what makes exclude.txt a real escape hatch, and `*`
      // compiles to [^/]+, which matches a tab.
      const { files, excluded } = walkDirs([dir.path], ["odd*name.jpg"]);
      assert.deepStrictEqual(relPaths(realpathSync.native(dir.path), files), [
        "keep.txt",
      ]);
      assert.equal(excluded.length, 1);
    },
  );

  it(
    "does not abort on an unsupported type, which isn't backed up either",
    posixOnly,
    async () => {
      await using dir = await mkTmpDir();
      write(dir.path, "target.txt");
      symlinkSync(join(dir.path, "target.txt"), join(dir.path, "link\tname"));
      const { skipped } = walkDirs([dir.path], []);
      assert.equal(skipped.length, 1);
    },
  );

  it(
    "refuses the files under a directory whose own name offends",
    posixOnly,
    async () => {
      await using dir = await mkTmpDir();
      write(dir.path, "bad\tdir/inside.txt");
      // Named per *file*, not once for the directory: the check rides the loop over
      // kept files, which is what keeps it out of the walk callback entirely. An
      // offending but empty directory therefore passes unremarked — correct, since
      // an empty directory is not backed up at all (ADR-0070).
      assert.throws(() => walkDirs([dir.path], []), /bad<TAB>dir.inside\.txt/);
    },
  );
});

describe("walkSet requires absolute member directories (ADR-0071)", () => {
  it("refuses a relative entry, and says why a full path is needed", async () => {
    await using dir = await mkTmpDir();
    // `mkTmpDir` builds under a relative root, so `dir.path` is already the case:
    // a set seeded this way would back up different files from a different cwd.
    const set = setOf(realpathSync.native(dir.path), [dir.path]);
    assert.throws(
      () => walkSet(set),
      (error) =>
        error instanceof Error &&
        error.message.includes(dir.path) &&
        /full path/.test(error.message) &&
        // the generic ADR-0054 message must not win the race …
        !/aren't available/.test(error.message) &&
        // … and both ways out are offered.
        error.message.includes(set.dirsPath) &&
        /--output/.test(error.message),
    );
  });

  // POSIX-only by necessity, not convenience: `C:\Users\me\Photos` *is* absolute
  // on Windows, so the case this covers — a Windows set adopted by `reattach` —
  // can only be reproduced from the other side.
  it(
    "covers a path absolute on another OS with the same message",
    posixOnly,
    async () => {
      await using dir = await mkTmpDir();
      const root = realpathSync.native(dir.path);
      // The reason one message names both causes: `isAbsolute` cannot tell this
      // from a relative entry, and guessing at path shapes to try would be worse.
      const foreign = "C:\\Users\\me\\Photos";
      assert.throws(
        () => walkSet(setOf(root, [foreign])),
        (error) =>
          error instanceof Error &&
          error.message.includes(foreign) &&
          /different kind of computer/.test(error.message),
      );
    },
  );

  it("still reports a genuinely missing absolute directory as unavailable", async () => {
    await using dir = await mkTmpDir();
    const root = realpathSync.native(dir.path);
    assert.throws(
      () => walkSet(setOf(root, [join(root, "gone")])),
      /aren't available/,
    );
  });
});
