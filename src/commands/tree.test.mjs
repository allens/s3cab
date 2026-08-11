import assert from "node:assert/strict";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { mkdtempDisposable } from "node:fs/promises";
import { dirname, join, posix, relative, sep } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { writeSet, writeSetExclude } from "../lib/sets.mjs";
import { renderTree } from "../render.mjs";
import { tree } from "./tree.mjs";
import { useTempHome } from "../../test/helpers/temp-home.mjs";

// `tree` and `tree --excluded` are the two halves of one walk: what a snapshot
// would keep, and what the set's patterns dropped. The walk itself is covered in
// lib/walk.test.mjs and the glob semantics in lib/exclude.test.mjs; what these
// assert is the command's own contribution — the shape it hands back, the
// stderr tally, and the rendered lines.

const mkTmpDir = async () => mkdtempDisposable(join("test", ".tmp"));

/**
 * @param {string} base
 * @param {string} relPath - always `/`-separated
 */
function write(base, relPath) {
  const full = join(base, ...relPath.split("/"));
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, "x");
}

/**
 * A one-directory set called `photos`, rooted at a fresh temp home, holding the
 * given files and exclude patterns.
 * @param {string} dirPath - The disposable directory to build under
 * @param {string[]} paths - Files to create (always `/`-separated)
 * @param {string[]} patterns - Lines for the set's exclude.txt
 * @returns {string} The set's realpath'd root, for relativizing results
 */
function makeSet(dirPath, paths, patterns) {
  useTempHome(dirPath);
  const root = join(dirPath, "photos");
  mkdirSync(root, { recursive: true });
  for (const path of paths) {
    write(root, path);
  }
  writeSet("photos", { dirs: [realpathSync.native(root)], bucket: "b" });
  writeSetExclude("photos", patterns.join("\n") + "\n");
  return realpathSync.native(root);
}

/**
 * @param {string} root
 * @param {string} path
 */
const rel = (root, path) => relative(root, path).split(sep).join(posix.sep);

/**
 * The "nothing was excluded" notice out of a mocked `console.warn`, or
 * `undefined` if it never came.
 * @param {{ mock: { calls: { arguments: unknown[] }[] } }} warn
 * @returns {string | undefined}
 */
const emptyNotice = (warn) =>
  warn.mock.calls
    .map(({ arguments: args }) => args.join(" "))
    .find((line) => line.startsWith("Nothing was excluded"));

/** @type {NodeJS.ProcessEnv} */
let savedEnv;
beforeEach(() => {
  savedEnv = { ...process.env };
});
afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in savedEnv)) {
      delete process.env[key];
    }
  }
  Object.assign(process.env, savedEnv);
});

describe("tree", () => {
  it("lists the files a snapshot would include", async (t) => {
    await using dir = await mkTmpDir();
    t.mock.method(console, "warn", () => {});
    const root = makeSet(
      dir.path,
      ["keep.txt", "sub/keep.txt", "scratch.tmp"],
      ["**/*.tmp"],
    );

    const files = tree("photos");
    assert.deepStrictEqual(
      /** @type {string[]} */ (files).map((path) => rel(root, path)).sort(),
      ["keep.txt", "sub/keep.txt"],
    );
  });
});

describe("tree --excluded", () => {
  it("returns each dropped path with the pattern that dropped it", async (t) => {
    await using dir = await mkTmpDir();
    t.mock.method(console, "warn", () => {});
    const root = makeSet(
      dir.path,
      ["keep.txt", "scratch.tmp", "sub/other.tmp", "build/out.js"],
      ["**/*.tmp", "build/"],
    );

    const excluded = /** @type {{ path: string, pattern: string }[]} */ (
      tree("photos", { excluded: true })
    );

    assert.deepStrictEqual(
      excluded
        .map(({ path, pattern }) => ({ path: rel(root, path), pattern }))
        .sort((a, b) => a.path.localeCompare(b.path)),
      [
        // The excluded directory is ONE entry, not one per file inside it —
        // the walk never descends, so `build/out.js` is not separately reported.
        { path: "build", pattern: "build/" },
        { path: "scratch.tmp", pattern: "**/*.tmp" },
        { path: "sub/other.tmp", pattern: "**/*.tmp" },
      ],
    );
  });

  it("tallies by pattern on stderr, biggest first, warning that a directory stands for its contents", async (t) => {
    await using dir = await mkTmpDir();
    const warn = t.mock.method(console, "warn", () => {});
    makeSet(
      dir.path,
      ["keep.txt", "a.tmp", "b.tmp", "sub/c.tmp", "build/out.js"],
      ["**/*.tmp", "build/"],
    );

    tree("photos", { excluded: true });

    const lines = warn.mock.calls.map(({ arguments: args }) => args.join(" "));
    const start = lines.findIndex((line) => line.startsWith("Excluded"));
    assert.notEqual(start, -1, `no tally in: ${lines.join(" | ")}`);
    assert.deepStrictEqual(lines.slice(start), [
      "Excluded 4 items (a directory stands for everything inside it):",
      "  3  **/*.tmp",
      "  1  build/",
    ]);
  });

  it("says so — and names the exclude file — when nothing matched", async (t) => {
    await using dir = await mkTmpDir();
    const warn = t.mock.method(console, "warn", () => {});
    makeSet(dir.path, ["keep.txt"], ["*.nomatch"]);

    const excluded = tree("photos", { excluded: true });

    // An empty result renders to the empty string (the right answer for a pipe),
    // so without the notice the command would be entirely silent at a terminal.
    assert.deepStrictEqual(excluded, []);
    assert.equal(renderTree(excluded), "");
    const notice = emptyNotice(warn);
    assert.ok(notice, "expected a 'nothing was excluded' notice");
    assert.match(notice, /exclude\.txt/);
  });

  it("gives the same neutral notice when the set has no patterns at all", async (t) => {
    await using dir = await mkTmpDir();
    const warn = t.mock.method(console, "warn", () => {});
    makeSet(dir.path, ["keep.txt"], []);

    tree("photos", { excluded: true });

    // An empty `excluded` means either "the patterns matched nothing" or "there
    // are no patterns", and the count can't tell them apart — so the notice must
    // not assert that any exist. (What distinguishes them is the walk's own
    // `Using exclude file …` line, which prints only when the file holds some.)
    const notice = emptyNotice(warn);
    assert.ok(notice, "expected a 'nothing was excluded' notice");
    assert.doesNotMatch(notice, /matched a pattern in/);
  });
});

describe("renderTree", () => {
  it("renders kept paths one per line and excluded entries as path + tab + pattern", () => {
    assert.equal(renderTree(["a.txt", "sub/b.txt"]), "a.txt\nsub/b.txt");
    assert.equal(
      renderTree([
        { path: "a.tmp", pattern: "**/*.tmp" },
        { path: "build", pattern: "build/" },
      ]),
      "a.tmp\t**/*.tmp\nbuild\tbuild/",
    );
    // The empty stream stays empty in both directions (ADR-0043).
    assert.equal(renderTree([]), "");
  });
});
