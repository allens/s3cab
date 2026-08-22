import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtempDisposable } from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { ValidationError } from "./error.mjs";
import { compileFindPattern, findInSnapshots, prepare } from "./find.mjs";
import { writeSet } from "./sets.mjs";
import { useTempHome } from "../../test/helpers/temp-home.mjs";
import { writeSnapshot } from "../../test/helpers/write-snapshot.mjs";

/** @import { BackupSet } from "./sets.mjs" */

// Tests for the find engine (ADR-0088). Two halves, tested apart because they
// answer different questions:
//
// - **Matching** is pure, so it is tested with literal Windows *and* POSIX paths
//   on whatever machine runs the suite. That is the point: the case rule keys on
//   the path's shape, so a Windows path must fold on Linux and a POSIX path must
//   not fold on Windows, and only literal paths can assert both from one run.
// - **The scan** needs real `.tsv.zst` snapshots, so it writes them into a temp
//   S3CAB_HOME. Its fixtures use paths this platform resolves, since what is
//   under test there is spans, dedup and unreadable snapshots — not path shape.

const mkTmpDir = async () => mkdtempDisposable(join("test", ".tmp"));

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

/**
 * Whether `pattern` matches `path` — the whole matcher in one call, for the
 * table-ish assertions below.
 * @param {string} pattern
 * @param {string} path
 * @returns {boolean}
 */
const matches = (pattern, path) =>
  compileFindPattern(pattern).test(prepare(path));

/** Where the scan fixtures' file paths live (resolved, so it works on any OS). */
const BASE = resolve("/data");

/**
 * A snapshot fixture file: a relative path under {@link BASE} and its contents,
 * which is what fixes its hash — two files with the same contents dedup to one
 * object, which is exactly what pass 2 reports on.
 * @param {string} path - Relative to {@link BASE}
 * @param {string} contents
 * @param {number} [lastModified] - Epoch ms, for the mtime the row records
 * @returns {File}
 */
const file = (path, contents, lastModified = 1_500_000_000_000) =>
  new File([contents], path, { lastModified });

/**
 * Create a set holding the given snapshots.
 * @param {string} name
 * @param {string} bucket
 * @param {Record<string, File[]>} snapshots - Snapshot name → its files
 * @returns {Promise<BackupSet>}
 */
async function seedSet(name, bucket, snapshots) {
  const set = writeSet(name, { dirs: [BASE], bucket });
  mkdirSync(set.snapshotsDir, { recursive: true });
  for (const [snapshot, files] of Object.entries(snapshots)) {
    await writeSnapshot(set.snapshotsDir, snapshot, files, BASE);
  }
  return set;
}

/** @param {string} path - Relative to {@link BASE} */
const at = (path) => resolve(BASE, path);

describe("compileFindPattern", () => {
  it("matches the basename when the pattern has no separator", () => {
    assert.equal(matches("junkfile.dat", "/home/me/old/junkfile.dat"), true);
    assert.equal(matches("junkfile.dat", "/junkfile.dat"), true);
    assert.equal(matches("junkfile.dat", "/home/me/junkfile.dat.bak"), false);
    // A bare name names a *file*, so a directory of that name is not a match —
    // that is what the trailing separator is for.
    assert.equal(matches("secretsdir", "/home/me/secretsdir/secret1"), false);
  });

  it("globs within the basename", () => {
    assert.equal(matches("*.jpg", "/home/me/photos/beach.jpg"), true);
    assert.equal(matches("*.jpg", "/home/me/photos/beach.jpeg"), false);
    assert.equal(matches("tax-201?.pdf", "/docs/tax-2019.pdf"), true);
    assert.equal(matches("tax-201?.pdf", "/docs/tax-19.pdf"), false);
    // `*` is one-or-more, not POSIX find's zero-or-more: the token grammar is
    // `exclude`'s (ADR-0088), and only the anchoring changed.
    assert.equal(matches("*secret1", "/home/me/copy-secret1"), true);
    assert.equal(matches("*secret1", "/home/me/secret1"), false);
  });

  it("floats a pattern with a separator over the whole path", () => {
    const path = "C:\\Users\\me\\secretsdir\\secret1";
    assert.equal(matches("secretsdir/secret1", path), true);
    assert.equal(matches("me/secretsdir/secret1", path), true);
    assert.equal(matches("C:/Users/me/secretsdir/secret1", path), true);
    // Floating, but segment-aligned: a fragment must start at a separator.
    assert.equal(matches("dir/secret1", path), false);
  });

  it("keeps * inside one segment and lets ** cross segments", () => {
    assert.equal(matches("*/junkfile.dat", "/home/me/junkfile.dat"), true);
    assert.equal(matches("*/junkfile.dat", "/junkfile.dat"), false);
    assert.equal(matches("me/**/tax.pdf", "/home/me/2019/docs/tax.pdf"), true);
    assert.equal(matches("me/**/tax.pdf", "/home/me/tax.pdf"), true);
  });

  it("matches everything beneath a directory given a trailing separator", () => {
    assert.equal(matches("secretsdir/", "/home/me/secretsdir/secret1"), true);
    assert.equal(matches("secretsdir/", "/home/me/secretsdir/a/b/c.txt"), true);
    // The directory row itself is not a file, and snapshots have no directory
    // rows — a path that merely *is* the directory must not match.
    assert.equal(matches("secretsdir/", "/home/me/secretsdir"), false);
    assert.equal(matches("secretsdir/", "/home/me/secretsdirX/y"), false);
  });

  it("folds case for a Windows path and not for a POSIX one", () => {
    assert.equal(matches("SECRET1", "C:\\Users\\me\\secret1"), true);
    assert.equal(matches("secret1", "C:\\Users\\ME\\SECRET1"), true);
    assert.equal(matches("SECRETSDIR/", "C:\\me\\secretsdir\\a"), true);
    assert.equal(matches("SECRET1", "/home/me/secret1"), false);
    assert.equal(matches("secret1", "/home/me/SECRET1"), false);
  });

  it("rejects a pattern with nothing in it to match", () => {
    assert.throws(() => compileFindPattern(""), ValidationError);
    assert.throws(() => compileFindPattern("/"), ValidationError);
  });
});

describe("prepare", () => {
  it("normalizes a Windows path's separators and folds its case", () => {
    assert.deepEqual(prepare("C:\\Users\\me\\a.txt"), {
      path: "C:/Users/me/a.txt",
      base: "a.txt",
      windows: true,
    });
  });

  it("treats a backslash in a POSIX path as an ordinary character", () => {
    assert.deepEqual(prepare("/home/me/we\\ird"), {
      path: "/home/me/we\\ird",
      base: "we\\ird",
      windows: false,
    });
  });
});

describe("findInSnapshots", () => {
  it("reports the object backing a matched path, with the sets searched", async () => {
    await using dir = await mkTmpDir();
    useTempHome(dir.path);
    const set = await seedSet("myset", "my-bucket", {
      "2026-06-11T0915": [file("notes/secret1", "S")],
    });

    const result = await findInSnapshots([set], ["secret1"]);

    assert.deepEqual(result.searched, [
      { name: "myset", bucket: "my-bucket", snapshots: 1 },
    ]);
    assert.equal(result.files.length, 1);
    const [found] = result.files;
    assert.equal(found?.path, at("notes/secret1"));
    assert.equal(found?.objects.length, 1);
    const [object] = found?.objects ?? [];
    assert.equal(object?.size, 1);
    assert.deepEqual(object?.spans, [
      {
        set: "myset",
        first: "2026-06-11T0915",
        last: "2026-06-11T0915",
        count: 1,
      },
    ]);
    assert.deepEqual(object?.alsoBacks, []);
  });

  it("collapses consecutive snapshots into a range, and a gap splits it", async () => {
    await using dir = await mkTmpDir();
    useTempHome(dir.path);
    const secret = file("notes/secret1", "S");
    const set = await seedSet("myset", "my-bucket", {
      "2026-06-11T0915": [secret],
      "2026-06-12T0915": [secret],
      "2026-06-13T0915": [file("notes/other", "X")],
      "2026-06-14T0915": [secret],
    });

    const result = await findInSnapshots([set], ["secret1"]);

    assert.deepEqual(result.files[0]?.objects[0]?.spans, [
      {
        set: "myset",
        first: "2026-06-11T0915",
        last: "2026-06-12T0915",
        count: 2,
      },
      {
        set: "myset",
        first: "2026-06-14T0915",
        last: "2026-06-14T0915",
        count: 1,
      },
    ]);
  });

  it("lists every snapshot separately under --all", async () => {
    await using dir = await mkTmpDir();
    useTempHome(dir.path);
    const secret = file("notes/secret1", "S");
    const set = await seedSet("myset", "my-bucket", {
      "2026-06-11T0915": [secret],
      "2026-06-12T0915": [secret],
    });

    const result = await findInSnapshots([set], ["secret1"], { all: true });

    assert.deepEqual(
      result.files[0]?.objects[0]?.spans.map(({ first, last, count }) => ({
        first,
        last,
        count,
      })),
      [
        { first: "2026-06-11T0915", last: "2026-06-11T0915", count: 1 },
        { first: "2026-06-12T0915", last: "2026-06-12T0915", count: 1 },
      ],
    );
  });

  it("reports one object per content the path held, newest version first", async () => {
    await using dir = await mkTmpDir();
    useTempHome(dir.path);
    const set = await seedSet("myset", "my-bucket", {
      "2026-06-11T0915": [file("notes/secret1", "old", 1_000_000_000_000)],
      "2026-06-12T0915": [file("notes/secret1", "old", 1_000_000_000_000)],
      "2026-06-13T0915": [file("notes/secret1", "new", 1_700_000_000_000)],
    });

    const result = await findInSnapshots([set], ["secret1"]);

    const objects = result.files[0]?.objects ?? [];
    assert.equal(objects.length, 2);
    // Asserted in the order the result gives them: newest version first, which
    // is the order a reader scanning a path's history wants.
    assert.deepEqual(
      objects.map(({ size, mtime, spans }) => ({
        size,
        mtime,
        snapshots: spans.map(({ first, last }) => `${first}..${last}`),
      })),
      [
        {
          size: 3,
          mtime: "2023-11-14T22:13:20Z",
          snapshots: ["2026-06-13T0915..2026-06-13T0915"],
        },
        {
          size: 3,
          mtime: "2001-09-09T01:46:40Z",
          snapshots: ["2026-06-11T0915..2026-06-12T0915"],
        },
      ],
    );
  });

  it("reports the other paths the same content is stored under", async () => {
    await using dir = await mkTmpDir();
    useTempHome(dir.path);
    const set = await seedSet("myset", "my-bucket", {
      "2026-06-11T0915": [
        file("notes/secret1", "S"),
        file("backup/copy-of-it", "S"),
        file("notes/unrelated", "X"),
      ],
    });

    const result = await findInSnapshots([set], ["secret1"]);

    assert.deepEqual(result.files[0]?.objects[0]?.alsoBacks, [
      at("backup/copy-of-it"),
    ]);
  });

  it("does not count a path that matched as a path the object 'also' backs", async () => {
    await using dir = await mkTmpDir();
    useTempHome(dir.path);
    const set = await seedSet("myset", "my-bucket", {
      "2026-06-11T0915": [
        file("notes/secret1", "S"),
        file("backup/copy-secret1", "S"),
      ],
    });

    const result = await findInSnapshots([set], ["secret1", "copy-secret1"]);

    assert.deepEqual(
      result.files.map(({ path, objects }) => [path, objects[0]?.alsoBacks]),
      [
        [at("backup/copy-secret1"), []],
        [at("notes/secret1"), []],
      ],
    );
  });

  it("searches every set given, and names each one's bucket", async () => {
    await using dir = await mkTmpDir();
    useTempHome(dir.path);
    const secret = file("notes/secret1", "S");
    const mine = await seedSet("myset", "my-bucket", {
      "2026-06-11T0915": [secret],
    });
    const work = await seedSet("work", "work-bucket", {
      "2026-06-12T0915": [secret],
      "2026-06-13T0915": [secret],
    });

    const result = await findInSnapshots([mine, work], ["secret1"]);

    assert.deepEqual(result.searched, [
      { name: "myset", bucket: "my-bucket", snapshots: 1 },
      { name: "work", bucket: "work-bucket", snapshots: 2 },
    ]);
    assert.deepEqual(
      result.files[0]?.objects[0]?.spans.map(({ set, count }) => [set, count]),
      [
        ["myset", 1],
        ["work", 2],
      ],
    );
  });

  it("finds nothing without failing, and still says what it searched", async () => {
    await using dir = await mkTmpDir();
    useTempHome(dir.path);
    const set = await seedSet("myset", "my-bucket", {
      "2026-06-11T0915": [file("notes/secret1", "S")],
    });

    const result = await findInSnapshots([set], ["nothing-like-this"]);

    assert.deepEqual(result.files, []);
    assert.deepEqual(result.unreadable, []);
    assert.deepEqual(result.searched, [
      { name: "myset", bucket: "my-bucket", snapshots: 1 },
    ]);
  });

  it("reports a snapshot it could not read, and searches the rest anyway", async () => {
    await using dir = await mkTmpDir();
    useTempHome(dir.path);
    const set = await seedSet("myset", "my-bucket", {
      "2026-06-11T0915": [file("notes/secret1", "S")],
    });
    writeFileSync(join(set.snapshotsDir, "2026-06-12T0915.tsv.zst"), "");

    const result = await findInSnapshots([set], ["secret1"]);

    assert.equal(result.unreadable.length, 1);
    assert.deepEqual(
      result.unreadable.map(({ set: name, snapshot }) => [name, snapshot]),
      [["myset", "2026-06-12T0915"]],
    );
    assert.equal(result.files[0]?.path, at("notes/secret1"));
  });

  it("matches any of several patterns, and reports each path once", async () => {
    await using dir = await mkTmpDir();
    useTempHome(dir.path);
    const set = await seedSet("myset", "my-bucket", {
      "2026-06-11T0915": [
        file("notes/secret1", "S"),
        file("notes/aws-keys.txt", "K"),
        file("notes/unrelated", "X"),
      ],
    });

    const result = await findInSnapshots([set], ["secret1", "*.txt"]);

    assert.deepEqual(
      result.files.map(({ path }) => path),
      [at("notes/aws-keys.txt"), at("notes/secret1")],
    );
  });
});
