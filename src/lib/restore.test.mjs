import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";
import { foldsCase } from "./path-match.mjs";
import { planRestore, reroot, selectEntries } from "./restore.mjs";

/** @import { SnapshotEntries } from "./snapshot-file.mjs" */

// `selectEntries` is the pure path-filter selector behind `restore [paths…]`.
// It reads a path's spelling rules from the path itself, so every case here runs
// the same on every OS.
const paths = [
  "/home/me/Photos/beach.jpg",
  "/home/me/Photos/2024/ski.jpg",
  "/home/me/PhotosArchive/old.jpg",
  "/home/me/Docs/cv.pdf",
];

describe("selectEntries", () => {
  it("returns every path, in order, when there are no filters", () => {
    assert.deepEqual(selectEntries(paths, []), paths);
  });

  it("treats blank filters as no filter", () => {
    assert.deepEqual(selectEntries(paths, ["", " "]), paths);
  });

  it("matches everything under the root", () => {
    assert.deepEqual(selectEntries(paths, ["/"]), paths);
  });

  it("matches a path exactly", () => {
    assert.deepEqual(selectEntries(paths, ["/home/me/Docs/cv.pdf"]), [
      "/home/me/Docs/cv.pdf",
    ]);
  });

  it("matches everything under a directory filter", () => {
    assert.deepEqual(selectEntries(paths, ["/home/me/Photos"]), [
      "/home/me/Photos/beach.jpg",
      "/home/me/Photos/2024/ski.jpg",
    ]);
  });

  it("respects the /-boundary so a sibling prefix does not match", () => {
    // `/home/me/Photos` must not pull in `/home/me/PhotosArchive/old.jpg`.
    assert.deepEqual(selectEntries(paths, ["/home/me/Photos"]), [
      "/home/me/Photos/beach.jpg",
      "/home/me/Photos/2024/ski.jpg",
    ]);
  });

  it("ignores a trailing separator on the filter", () => {
    assert.deepEqual(selectEntries(paths, ["/home/me/Photos/"]), [
      "/home/me/Photos/beach.jpg",
      "/home/me/Photos/2024/ski.jpg",
    ]);
  });

  it("unions multiple filters, keeping input order and no duplicates", () => {
    assert.deepEqual(
      selectEntries(paths, ["/home/me/Docs", "/home/me/Photos/2024"]),
      ["/home/me/Photos/2024/ski.jpg", "/home/me/Docs/cv.pdf"],
    );
  });

  it("selects nothing when no path matches", () => {
    assert.deepEqual(selectEntries(paths, ["/home/me/Music"]), []);
  });

  // The spelling rules follow the path's shape, not the OS running the restore:
  // `restore --output` puts a Windows backup on Linux, where the paths are still
  // Windows paths. So none of these is platform-guarded.

  it("is case-sensitive for a POSIX path, on every OS", () => {
    assert.deepEqual(selectEntries(paths, ["/HOME/ME/photos"]), []);
  });

  it("treats a backslash in a POSIX path as part of the name, on every OS", () => {
    const posixPaths = ["/home/me/a\\b.txt"];
    assert.deepEqual(selectEntries(posixPaths, ["/home/me/a"]), []);
  });

  const winPaths = [
    "C:\\Users\\Me\\Photos\\beach.jpg",
    "C:\\Users\\Me\\Photos\\2024\\ski.jpg",
    "C:\\Users\\Me\\PhotosArchive\\old.jpg",
  ];
  const winPhotos = winPaths.slice(0, 2);

  it("matches under a drive-letter folder, in either separator, on every OS", () => {
    assert.deepEqual(
      selectEntries(winPaths, ["C:\\Users\\Me\\Photos"]),
      winPhotos,
    );
    assert.deepEqual(
      selectEntries(winPaths, ["C:/Users/Me/Photos"]),
      winPhotos,
    );
    assert.deepEqual(
      selectEntries(winPaths, ["C:\\Users\\Me\\Photos\\"]),
      winPhotos,
    );
  });

  it("folds case for a drive-letter path, on every OS", () => {
    assert.deepEqual(
      selectEntries(winPaths, ["c:\\users\\me\\photos"]),
      winPhotos,
    );
  });

  it("folds separators and case for a UNC path, on every OS", () => {
    const uncPaths = [
      "\\\\nas\\Share\\Photos\\beach.jpg",
      "\\\\nas\\Share\\Docs\\cv.pdf",
    ];
    assert.deepEqual(selectEntries(uncPaths, ["//NAS/share/photos"]), [
      uncPaths[0],
    ]);
  });

  it("matches only a path of the filter's own kind, so `/` takes no share path", () => {
    const mixed = ["/home/me/a.txt", "\\\\nas\\Share\\b.jpg", "C:\\c.txt"];
    assert.deepEqual(selectEntries(mixed, ["/"]), ["/home/me/a.txt"]);
  });
});

// `reroot` is the pure path re-rooter behind `restore --output <dir>`: each
// path in the snapshot lands at its full path under `<output>`, its root turned
// into a folder (ADR-0109). Destinations are built with the local separator under
// `resolve(output)`, so expected values use the same `join`/`resolve` to stay
// portable across OSes.
describe("reroot", () => {
  const out = resolve("out");
  const map = reroot("out");

  it("keeps a POSIX path's every segment under <output>", () => {
    assert.equal(
      map("/home/me/Photos/2024/ski.jpg"),
      join(out, "home", "me", "Photos", "2024", "ski.jpg"),
    );
  });

  it("turns a drive into its letter, in either separator, on any OS", () => {
    assert.equal(
      map("C:\\Users\\me\\a.txt"),
      join(out, "C", "Users", "me", "a.txt"),
    );
    assert.equal(map("d:/b.txt"), join(out, "d", "b.txt"));
  });

  it("puts a share under UNC, on any OS", () => {
    assert.equal(
      map("\\\\nas\\photos\\2024\\a.jpg"),
      join(out, "UNC", "nas", "photos", "2024", "a.jpg"),
    );
  });

  it("keeps two member dirs with one last name apart", () => {
    assert.notEqual(map("C:\\a\\Photos\\x.jpg"), map("D:\\b\\Photos\\x.jpg"));
    assert.notEqual(map("/a/Photos/x.jpg"), map("/b/Photos/x.jpg"));
  });

  it("keeps a share apart from a drive and from a POSIX path", () => {
    const places = [
      map("\\\\nas\\c\\a.txt"),
      map("C:\\nas\\c\\a.txt"),
      map("/nas/c/a.txt"),
    ];
    assert.equal(new Set(places).size, places.length);
  });

  it("keeps a POSIX folder named like a drive as it is", () => {
    assert.equal(map("/mnt/C:/a.txt"), join(out, "mnt", "C:", "a.txt"));
  });

  // A POSIX path's backslash is an ordinary filename character, not a
  // separator (path-match.mjs's shape rule). Windows reads it as one, so there
  // such a name has no place: `join` would resolve its `..`. `out` is
  // Windows-shaped exactly when this runs on Windows.
  it("places a POSIX name holding `\\` only under a non-Windows output", () => {
    for (const path of [
      "/home/u/back\\slash.txt",
      "/home/u/a\\..\\..\\..\\Windows\\x.txt",
      "/home/we\\ird/a.jpg",
    ]) {
      assert.equal(
        map(path),
        foldsCase(out) ? undefined : join(out, ...path.split("/")),
        path,
      );
    }
  });
});

// `planRestore` is the pure decision step behind the restore loop: for each
// target it decides skip / refuse / block / write, with no disk or network
// access — `stat` is injected so these run with a fake filesystem.
describe("planRestore", () => {
  const destFor = (/** @type {string} */ source) => source;
  /** @type {SnapshotEntries} */
  const entries = new Map([
    ["/a.jpg", { hash: "h1", mtime: "2026-01-01T00:00Z", size: 1 }],
    ["/b.jpg", { hash: "h1", mtime: "2026-01-01T00:00Z", size: 1 }], // same content as a.jpg
  ]);
  const writeOf = (/** @type {string} */ dest) => ({
    dest,
    action: "write",
    hash: "h1",
    mtime: "2026-01-01T00:00Z",
  });
  const FILE = { isDirectory: () => false };
  const FOLDER = { isDirectory: () => true };

  it("writes every target, a repeated hash included — dedupe is the restore loop's", () => {
    const plan = planRestore(entries, ["/a.jpg", "/b.jpg"], destFor, {
      stat: () => undefined,
    });
    assert.deepEqual(plan, [writeOf("/a.jpg"), writeOf("/b.jpg")]);
  });

  it("skips a target whose destination already exists", () => {
    const plan = planRestore(entries, ["/a.jpg", "/b.jpg"], destFor, {
      stat: (dest) => (dest === "/a.jpg" ? FILE : undefined),
    });
    assert.deepEqual(plan, [
      { dest: "/a.jpg", action: "skip" },
      writeOf("/b.jpg"),
    ]);
  });

  it("overwrite writes over an existing destination instead of skipping it", () => {
    const plan = planRestore(entries, ["/a.jpg"], destFor, {
      stat: (dest) => (dest === "/a.jpg" ? FILE : undefined),
      overwrite: true,
    });
    assert.deepEqual(plan, [writeOf("/a.jpg")]);
  });

  it("blocks a target whose destination is a folder, --overwrite or not", () => {
    // Not a skip: rerunning with --overwrite can't replace a folder, and would
    // download the whole object only to fail at the rename.
    for (const overwrite of [false, true]) {
      const plan = planRestore(entries, ["/a.jpg", "/b.jpg"], destFor, {
        stat: (dest) => (dest === "/a.jpg" ? FOLDER : undefined),
        overwrite,
      });
      assert.deepEqual(plan, [
        { dest: "/a.jpg", action: "block" },
        writeOf("/b.jpg"),
      ]);
    }
  });

  it("refuses a `:` in a Windows name — under either root", () => {
    // NTFS would take `a:b.jpg` as a stream of a file `a`; the drive's own `:`
    // and a UNC root are not names. `stat` isn't consulted for the refused
    // one: a stream left by an earlier restore must not read as "already here".
    for (const root of ["C:\\out\\", "\\\\nas\\share\\"]) {
      const named = new Map([
        [`${root}a:b.jpg`, { hash: "h1", mtime: "2026-01-01T00:00Z", size: 1 }],
        [`${root}b.jpg`, { hash: "h1", mtime: "2026-01-01T00:00Z", size: 1 }],
      ]);
      const plan = planRestore(named, [...named.keys()], destFor, {
        stat: (dest) => (dest.includes("a:b") ? FILE : undefined),
      });
      assert.deepEqual(plan, [
        { dest: `${root}a:b.jpg`, action: "refuse" },
        writeOf(`${root}b.jpg`),
      ]);
    }
  });

  it("refuses a path with no destination by its snapshot path, --overwrite or not", () => {
    // `stat` isn't consulted: `--overwrite` can't reach it either.
    const named = new Map([
      [
        "/home/u/a\\..\\x.txt",
        { hash: "h1", mtime: "2026-01-01T00:00Z", size: 1 },
      ],
    ]);
    const plan = planRestore(named, [...named.keys()], () => undefined, {
      stat: () => FILE,
      overwrite: true,
    });
    assert.deepEqual(plan, [
      { dest: "/home/u/a\\..\\x.txt", action: "refuse" },
    ]);
  });

  it("leaves a `:` alone in a POSIX name, where it is an ordinary character", () => {
    const named = new Map([
      ["/a:b.jpg", { hash: "h1", mtime: "2026-01-01T00:00Z", size: 1 }],
    ]);
    const plan = planRestore(named, ["/a:b.jpg"], destFor, {
      stat: () => undefined,
    });
    assert.deepEqual(plan, [writeOf("/a:b.jpg")]);
  });
});
