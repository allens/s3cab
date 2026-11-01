import assert from "node:assert/strict";
import { isUtf8 } from "node:buffer";
import {
  mkdirSync,
  readdirSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { mkdtempDisposable } from "node:fs/promises";
import { dirname, join, posix, relative, sep } from "node:path";
import { describe, it } from "node:test";
import { ESCAPES } from "./path-match.mjs";
import {
  backupMatcher,
  readExcludePatterns,
  walkDirs,
  walkSet,
} from "./walk.mjs";

/**
 * @import { PathLike } from "node:fs"
 * @import { BackupSet } from "./sets.mjs"
 */

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
 * Make the records' paths relative to `root`, `/`-separated, sorted by path.
 * @template {{ path: string }} T
 * @param {string} root
 * @param {T[]} records
 * @returns {T[]}
 */
const relRecords = (root, records) =>
  records
    .map((record) => ({
      ...record,
      path: relative(root, record.path).split(sep).join(posix.sep),
    }))
    .sort((a, b) => a.path.localeCompare(b.path));

const symlinks = {
  skip:
    process.platform === "win32"
      ? "symlink creation requires Developer Mode on Windows"
      : false,
};

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

  it("hands back exclusion records (the matched pattern, and whether it was a folder) as data", async () => {
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
    assert.deepStrictEqual(relRecords(root, excluded), [
      { pattern: "build/", path: "build", isDir: true },
      { pattern: "**/*.tmp", path: "scratch.tmp", isDir: false },
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
});

describe("backupMatcher skips only what the walk skips", () => {
  const inBackup = backupMatcher(["C:\\set", "/home/me/set"]);

  it("leaves out a folder named exactly .s3cab, and what is in it", () => {
    assert.equal(inBackup("C:\\set\\.s3cab", true), false);
    assert.equal(inBackup("C:\\set\\.s3cab\\a.txt", false), false);
    assert.equal(inBackup("/home/me/set/x/.s3cab/a.txt", false), false);
  });

  it("keeps a .s3cab spelled in another case, which the walk enters", () => {
    assert.equal(inBackup("C:\\set\\.S3CAB\\a.txt", false), true);
  });

  it("keeps a file named .s3cab", () => {
    assert.equal(inBackup("/home/me/set/notes/.s3cab", false), true);
  });

  it("matches a Windows root only as the disk spells it", () => {
    // Both sides are real paths, so a folder spelled otherwise is another
    // folder: in a case-sensitive directory, `SET` beside `set` is not saved.
    assert.equal(inBackup("C:\\set\\a.txt", false), true);
    assert.equal(inBackup("C:\\SET\\a.txt", false), false);
    assert.equal(inBackup("C:\\other\\a.txt", false), false);
  });
});

describe("walkDirs never follows or records a link (ADR-0103)", () => {
  it(
    "records nothing for a link to a file or folder inside the backup, or a broken one",
    symlinks,
    async () => {
      await using dir = await mkTmpDir();
      const base = dir.path;
      write(base, "regular.txt");
      write(base, "sub/inner.txt");
      symlinkSync("regular.txt", join(base, "link.txt"));
      symlinkSync("sub", join(base, "linkdir"));
      symlinkSync("missing.txt", join(base, "broken"));

      const root = realpathSync.native(base);
      const { files, excluded, errors } = walkDirs([base], []);

      // `linkdir/inner.txt` is absent: the folder link is never descended into.
      // Its target is saved under its real path already.
      assert.deepStrictEqual(relPaths(root, files), [
        "regular.txt",
        "sub/inner.txt",
      ]);
      assert.deepStrictEqual(excluded, []);
      assert.deepStrictEqual(errors, []);
    },
  );

  it(
    "makes each link leading out of the backup an error naming its target",
    symlinks,
    async () => {
      await using outside = await mkTmpDir();
      write(outside.path, "a.txt");
      write(outside.path, "folder/b.txt");
      const away = realpathSync.native(outside.path);

      await using dir = await mkTmpDir();
      const base = dir.path;
      const root = realpathSync.native(base);
      symlinkSync(join(away, "a.txt"), join(base, "out-file"));
      symlinkSync(join(away, "folder"), join(base, "out-folder"));

      const { files, errors } = walkDirs([base], []);

      assert.deepStrictEqual(files, []);
      assert.deepStrictEqual(relRecords(root, errors), [
        {
          path: "out-file",
          reason: `link to a file outside the backup: ${join(away, "a.txt")}`,
        },
        {
          path: "out-folder",
          reason: `link to a folder outside the backup: ${join(away, "folder")}`,
        },
      ]);
    },
  );

  it(
    "makes a link into a .s3cab folder an error, since the walk never enters one",
    symlinks,
    async () => {
      await using dir = await mkTmpDir();
      const base = dir.path;
      const root = realpathSync.native(base);
      write(base, ".s3cab/kept.txt");
      symlinkSync(join(root, ".s3cab", "kept.txt"), join(base, "to-file"));
      symlinkSync(join(root, ".s3cab"), join(base, "to-folder"));

      const { files, errors } = walkDirs([base], []);

      assert.deepStrictEqual(files, []);
      assert.deepStrictEqual(relRecords(root, errors), [
        {
          path: "to-file",
          reason: `link to a file outside the backup: ${join(root, ".s3cab", "kept.txt")}`,
        },
        {
          path: "to-folder",
          reason: `link to a folder outside the backup: ${join(root, ".s3cab")}`,
        },
      ]);
    },
  );

  it(
    "keeps a link to a plain file named .s3cab, which the walk records",
    symlinks,
    async () => {
      await using dir = await mkTmpDir();
      const base = dir.path;
      const root = realpathSync.native(base);
      write(base, "notes/.s3cab");
      symlinkSync(join(root, "notes", ".s3cab"), join(base, "to-it"));

      const { files, errors } = walkDirs([base], []);

      assert.deepStrictEqual(relPaths(root, files), ["notes/.s3cab"]);
      assert.deepStrictEqual(errors, []);
    },
  );

  it(
    "keeps a link inside a member directory that is itself under a .s3cab folder",
    symlinks,
    async () => {
      await using dir = await mkTmpDir();
      write(dir.path, ".s3cab/member/a.txt");
      const base = join(realpathSync.native(dir.path), ".s3cab", "member");
      symlinkSync("a.txt", join(base, "link.txt"));

      const { files, errors } = walkDirs([base], []);

      assert.deepStrictEqual(relPaths(base, files), ["a.txt"]);
      assert.deepStrictEqual(errors, []);
    },
  );

  it(
    "makes a link whose target is there but won't resolve an error",
    symlinks,
    async (t) => {
      // A junction onto a volume GUID with no mount point: `stat` says a
      // folder, `realpath` ENOENT (ADR-0099).
      await using dir = await mkTmpDir();
      const base = dir.path;
      write(base, "sub/inner.txt");
      const link = join(realpathSync.native(base), "unresolvable");
      symlinkSync("sub", link);

      const native = realpathSync.native;
      t.mock.method(
        realpathSync,
        "native",
        /** @param {PathLike} path */ (path) => {
          if (path === link) {
            throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
          }
          return native(path);
        },
      );

      const { errors } = walkDirs([base], []);
      // A folder link, so its path ends with a separator, as its row's does.
      assert.deepStrictEqual(errors, [
        {
          path: link + sep,
          reason: "link to a place this computer can't resolve: sub",
        },
      ]);
    },
  );

  it(
    "excludes a link by pattern, a trailing slash matching only one to a folder",
    symlinks,
    async () => {
      await using dir = await mkTmpDir();
      const base = dir.path;
      write(base, "sub/inner.txt");
      symlinkSync("sub", join(base, "linkdir"));
      symlinkSync("missing", join(base, "broken"));

      const root = realpathSync.native(base);

      // A broken link has no target, so `broken/` can't say it is a folder.
      const slashed = walkDirs([base], ["linkdir/", "broken/"]);
      assert.deepStrictEqual(relRecords(root, slashed.excluded), [
        { pattern: "linkdir/", path: "linkdir", isDir: true },
      ]);

      const bare = walkDirs([base], ["broken"]);
      assert.deepStrictEqual(relRecords(root, bare.excluded), [
        { pattern: "broken", path: "broken", isDir: false },
      ]);
    },
  );
});

describe("readExcludePatterns (ADR-0100)", () => {
  it("refuses a pattern holding a tab or CR, naming each with * as the fix", async () => {
    await using dir = await mkTmpDir();
    const excludePath = join(dir.path, "exclude.txt");
    writeFileSync(excludePath, "*.tmp\nodd\tname.jpg\ncr\rhere\n");
    assert.throws(
      () => readExcludePatterns(excludePath),
      (error) =>
        error instanceof Error &&
        error.message.includes("because these patterns contain a tab") &&
        error.message.includes("  odd␉name.jpg\n") &&
        error.message.includes("  cr␍here\n") &&
        error.message.includes("  odd*name.jpg\n") &&
        error.message.endsWith("  cr*here") &&
        !error.message.includes("*.tmp"),
    );
  });

  it("says 'this pattern' for a single offender", async () => {
    await using dir = await mkTmpDir();
    const excludePath = join(dir.path, "exclude.txt");
    writeFileSync(excludePath, "*.tmp\nodd\tname.jpg\n");
    assert.throws(
      () => readExcludePatterns(excludePath),
      (error) =>
        error instanceof Error &&
        error.message.includes("because this pattern contains a tab") &&
        error.message.endsWith("  odd*name.jpg"),
    );
  });

  it("reads a file with CRLF line endings", async () => {
    await using dir = await mkTmpDir();
    const excludePath = join(dir.path, "exclude.txt");
    writeFileSync(excludePath, "*.tmp\r\ncache/\r\n");
    assert.deepStrictEqual(readExcludePatterns(excludePath), [
      "*.tmp",
      "cache/",
    ]);
  });

  it(
    "keeps an escaped space at a line's end, CRLF or not (ADR-0115)",
    { skip: !ESCAPES && "\\ is a separator on Windows" },
    async () => {
      await using dir = await mkTmpDir();
      const excludePath = join(dir.path, "exclude.txt");
      writeFileSync(excludePath, "notes\\ \r\nold\\  \n");
      assert.deepStrictEqual(readExcludePatterns(excludePath), [
        "notes\\ ",
        "old\\ ",
      ]);
    },
  );

  it(
    "refuses a \\ that escapes nothing, offering / as the separator (ADR-0115)",
    { skip: !ESCAPES && "\\ is a separator on Windows" },
    async () => {
      await using dir = await mkTmpDir();
      const excludePath = join(dir.path, "exclude.txt");
      // The CR of a CRLF line is not what the backslash escapes. The second
      // line is the shape a Windows-written exclude.txt brings with it.
      writeFileSync(
        excludePath,
        "*.tmp\nodd\\\r\n**\\node_modules\\\n**\\Thumbs.db\n" +
          "fine\\\\ \\#\\*\\?\nsub\\/x\n",
      );
      assert.throws(
        () => readExcludePatterns(excludePath),
        (error) =>
          error instanceof Error &&
          error.message.includes("because these patterns have a \\") &&
          error.message.includes("\n  odd\\\n") &&
          error.message.includes("\n  sub\\/x\n") &&
          error.message.includes("\n  **/node_modules/\n") &&
          error.message.includes("\n  **/Thumbs.db\n") &&
          error.message.includes("\n  sub/x\n") &&
          !error.message.includes("fine"),
      );
    },
  );

  it("shows a tab in a pattern before any other refusal", async () => {
    await using dir = await mkTmpDir();
    const excludePath = join(dir.path, "exclude.txt");
    writeFileSync(excludePath, "a\tb\\\n");
    assert.throws(() => readExcludePatterns(excludePath), /a␉b/);
  });
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

// The walk root is canonicalized with `realpathSync.native` (resolveWalkRoot), and
// these pin *that behaviour* rather than the error branch around it. Everything
// downstream is keyed on the paths the walk yields — snapshot entries, the drift
// guard's re-stat, restore's collision map — so a root that reaches the walk in a
// different spelling of the same location has to come back in one form, or those
// keys silently stop matching.
//
// Why they exist: swapping `realpathSync.native` for `resolve()` used to fail only
// the ENOENT-shaping test above, which reads as "the vault error branch broke" and
// invites deleting the now-unreachable branch — leaving canonicalization gone and
// the suite green. Nothing named the property itself. Note `realpathSync` *without*
// `.native` is not a substitute: measured 2026-08-18, the JS implementation returns
// the drive letter as given, so only `.native` (GetFinalPathNameByHandle) fixes the
// case. Every path here is derived from a real temp dir, never hardcoded to a drive.
describe("walkDirs canonicalizes its root", () => {
  it(
    "yields canonical paths for a root given with a lowercase drive letter",
    { skip: process.platform !== "win32" ? "win32-only behaviour" : false },
    async () => {
      await using dir = await mkTmpDir();
      write(dir.path, "a.txt");
      write(dir.path, "sub/b.txt");

      // The exact input a user can type into dirs.txt or `upload --dir`, and what
      // a lowercase-drive cwd hands `resolve()` — the two ways this reaches the
      // walk in the wild.
      const canonical = realpathSync.native(dir.path);
      const lowerDrive = canonical.charAt(0).toLowerCase() + canonical.slice(1);
      assert.notEqual(lowerDrive, canonical, "the fixture must differ in case");

      const { files } = walkDirs([lowerDrive], []);

      // Byte-identical to a walk of the canonical root: not merely "resolves to
      // the same file" (`resolve()` would pass that), but the same *string*,
      // which is what a path-keyed lookup compares.
      assert.deepStrictEqual(files, walkDirs([canonical], []).files);
      for (const file of files) {
        assert.ok(
          file.startsWith(canonical),
          `path kept the input's spelling instead of the canonical root: ${file}`,
        );
      }
    },
  );
});

describe("walkDirs on a root the OS won't canonicalize", () => {
  it("says the folder won't resolve, rather than dying on a bare ENOENT", async (t) => {
    await using dir = await mkTmpDir();
    write(dir.path, "keep.txt");

    // Constructed, not reproduced. The measured case is an unlocked OneDrive
    // Personal Vault — a junction onto a volume GUID with no mount point, which
    // `lstat` calls a directory and `readdir` lists, while
    // `GetFinalPathNameByHandle` answers ENOENT (proposals/filesystem-edge-cases.md).
    // Nothing portable creates one, so the *OS's answer* for this one path is
    // what's faked; the directory itself is real, which is the whole point — the
    // guard has to stat it, or it can't tell the two ENOENTs apart.
    const native = realpathSync.native;
    t.mock.method(
      realpathSync,
      "native",
      /** @param {PathLike} path */ (path) => {
        if (path === dir.path) {
          throw Object.assign(
            new Error(`ENOENT: no such file or directory, realpath '${path}'`),
            { code: "ENOENT" },
          );
        }
        return native(path);
      },
    );

    assert.throws(
      () => walkDirs([dir.path], []),
      (error) =>
        error instanceof Error &&
        // The user's goal, then the fact the old raw error contradicted: this
        // folder is *there* — it just has no resolvable location.
        error.message.startsWith(`Can't back up '${dir.path}'`) &&
        /the folder is there/.test(error.message) &&
        /won't say where it really is/.test(error.message) &&
        // The errno stays a parenthetical gloss; it is never the headline.
        !/^ENOENT/.test(error.message) &&
        error.message.includes("  s3cab list <set>"),
    );
  });

  it("leaves a genuinely missing root to its raw ENOENT", async () => {
    await using dir = await mkTmpDir();
    // Deliberate: both entry points refuse a missing directory long before the
    // walk (`assertWalkableDirs`, `upload --dir`), so re-explaining it here would
    // be a message for a path that can't arrive — and it must not be dressed up
    // as the unresolvable case, which claims the folder is there.
    assert.throws(() => walkDirs([join(dir.path, "nope")], []), {
      code: "ENOENT",
    });
  });

  it("won't call a file a folder that is there", async (t) => {
    await using dir = await mkTmpDir();
    write(dir.path, "plain.txt");
    const file = join(dir.path, "plain.txt");

    // The message says "folder", so it only fires for something that stats as
    // one — a path that exists but isn't a directory falls through to the raw
    // error rather than being described as a folder.
    const native = realpathSync.native;
    t.mock.method(
      realpathSync,
      "native",
      /** @param {PathLike} path */ (path) => {
        if (path === file) {
          throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
        }
        return native(path);
      },
    );

    assert.throws(
      () => walkDirs([file], []),
      (error) => Error.isError(error) && !/folder is there/.test(error.message),
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
          error.message.includes("odd␉name.jpg") &&
          error.message.includes("another␉one.jpg") &&
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
      assert.throws(() => walkDirs([dir.path], []), /two␊lines\.jpg/);

      await using other = await mkTmpDir();
      // Not idle strictness: the snapshot parser reads with `crlfDelay: Infinity`,
      // so a trailing \r would be stripped and the path would come back changed.
      write(other.path, "trailing\r.jpg");
      assert.throws(() => walkDirs([other.path], []), /trailing␍\.jpg/);
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
    "passes a link whose name or target holds a tab, which has no row to break",
    posixOnly,
    async () => {
      await using dir = await mkTmpDir();
      write(dir.path, "target.txt");
      symlinkSync("target.txt", join(dir.path, "link\tname"));
      symlinkSync("odd\ttarget", join(dir.path, "plain"));
      const { files, errors } = walkDirs([dir.path], []);
      assert.equal(files.length, 1);
      assert.deepStrictEqual(errors, []);
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
      assert.throws(() => walkDirs([dir.path], []), /bad␉dir.inside\.txt/);
    },
  );
});

/**
 * Create a file whose name has no UTF-8 form, as `<prefix>???.txt`. The bytes
 * are a lone surrogate written as WTF-8: Windows stores it as one in the UTF-16
 * name, Linux as three bytes that aren't UTF-8. Either way it reads back as a
 * string with three U+FFFD in its place.
 *
 * Some filesystems can't hold such a name, so this says whether one now exists:
 * APFS refuses it (`EILSEQ`), and WSL's `/mnt` drives store something valid.
 * @param {string} base
 * @param {string} prefix
 * @returns {boolean} Whether the folder now holds a name with no UTF-8 form
 */
function writeUnencodable(base, prefix) {
  const name = Buffer.concat([
    Buffer.from(join(base, prefix)),
    Buffer.from([0xed, 0xa0, 0x80]),
    Buffer.from(".txt"),
  ]);
  try {
    writeFileSync(name, "x");
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code === "EILSEQ") {
      return false;
    }
    throw error;
  }
  return readdirSync(base, { encoding: "buffer" }).some((n) => !isUtf8(n));
}

describe("walkDirs refuses a name with no UTF-8 form (ADR-0073)", () => {
  it("aborts, naming every offender, rather than recording it as missing", async (t) => {
    await using dir = await mkTmpDir();
    write(dir.path, "fine.txt");
    // Two in one folder read back as the same string: once a false "overlap".
    if (!writeUnencodable(dir.path, "one")) {
      t.skip("this filesystem can't hold a name with no UTF-8 form");
      return;
    }
    writeUnencodable(dir.path, "two");
    assert.throws(
      () => walkDirs([dir.path], []),
      (error) =>
        error instanceof Error &&
        /These 2 files can't be backed up/.test(error.message) &&
        /one�{3}\.txt {2}\(not valid Unicode\)/.test(error.message) &&
        /two�{3}\.txt {2}\(not valid Unicode\)/.test(error.message) &&
        /exclude file/.test(error.message),
    );
  });

  it("refuses it beside a valid name that reads the same", async (t) => {
    await using dir = await mkTmpDir();
    write(dir.path, "same���.txt");
    if (!writeUnencodable(dir.path, "same")) {
      t.skip("this filesystem can't hold a name with no UTF-8 form");
      return;
    }
    assert.throws(
      () => walkDirs([dir.path], []),
      /This file can't be backed up[^]*same�{3}\.txt {2}\(not valid Unicode\)/,
    );
  });

  it("leaves it out when a pattern matches it, and keeps a real U+FFFD", async (t) => {
    await using dir = await mkTmpDir();
    write(dir.path, "keep�.txt");
    if (!writeUnencodable(dir.path, "odd")) {
      t.skip("this filesystem can't hold a name with no UTF-8 form");
      return;
    }
    const { files, excluded } = walkDirs([dir.path], ["odd*.txt"]);
    assert.deepStrictEqual(relPaths(realpathSync.native(dir.path), files), [
      "keep�.txt",
    ]);
    assert.deepStrictEqual(
      excluded.map(({ pattern, isDir }) => ({ pattern, isDir })),
      [{ pattern: "odd*.txt", isDir: false }],
    );
  });
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
