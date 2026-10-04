import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";
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

  it("treats blank/separator-only filters as no filter", () => {
    assert.deepEqual(selectEntries(paths, ["", "/"]), paths);
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
});

// `reroot` is the pure path re-rooter behind `restore --output <dir>`: each
// path in the snapshot lands under `<output>/<member-root-basename>/…`. Destinations are
// built with the local separator under `resolve(output)`, so expected values use
// the same `join`/`resolve` to stay portable across OSes.
describe("reroot", () => {
  it("re-roots each member dir's contents under <output>/<basename>", () => {
    const map = reroot(["/home/me/Photos", "/home/me/Docs"], "out");
    assert.equal(
      map("/home/me/Photos/2024/ski.jpg"),
      join(resolve("out"), "Photos", "2024", "ski.jpg"),
    );
    assert.equal(
      map("/home/me/Docs/cv.pdf"),
      join(resolve("out"), "Docs", "cv.pdf"),
    );
  });

  it("is separator-agnostic, so a Windows snapshot re-roots on any OS", () => {
    const map = reroot(["C:\\Users\\me\\Photos"], "out");
    assert.equal(
      map("C:\\Users\\me\\Photos\\beach.jpg"),
      join(resolve("out"), "Photos", "beach.jpg"),
    );
  });

  it("picks the longest matching root, so a nested member dir wins", () => {
    const map = reroot(["/data", "/data/photos"], "out");
    assert.equal(
      map("/data/photos/x.jpg"),
      join(resolve("out"), "photos", "x.jpg"),
    );
    assert.equal(
      map("/data/notes.txt"),
      join(resolve("out"), "data", "notes.txt"),
    );
  });

  it("rejects two roots that share a basename (they'd collide under one root)", () => {
    assert.throws(
      () => reroot(["/a/Photos", "/b/Photos"], "out"),
      /both named/,
    );
  });

  it("rejects a snapshot with no member dirs", () => {
    assert.throws(() => reroot([], "out"), /no directory headers/);
  });

  it("rejects a path that lies under no member root", () => {
    const map = reroot(["/home/me/Photos"], "out");
    assert.throws(
      () => map("/etc/passwd"),
      /not under any backed-up directory/,
    );
  });

  // A `#DIR` header and the rows under it can disagree in case once someone
  // edits the snapshot — a supported thing to do to a file we promise is plain
  // text. On Windows the two spellings are one path, so re-rooting must not read
  // the difference as "this file is under no backed-up directory". Folding keys
  // on the drive letter, not on the running platform, because these snapshots
  // get restored on other operating systems — which is what `--output` is for.
  it("folds case in a Windows root, so an edited #DIR still re-roots", () => {
    const map = reroot(["c:\\Users\\me\\Photos"], "out");
    assert.equal(
      map("C:\\Users\\me\\Photos\\beach.jpg"),
      join(resolve("out"), "Photos", "beach.jpg"),
    );
  });

  it("folds every segment of a Windows root, not just the drive", () => {
    const map = reroot(["C:\\USERS\\ME\\photos"], "out");
    assert.equal(
      map("C:\\Users\\me\\Photos\\beach.jpg"),
      join(resolve("out"), "photos", "beach.jpg"),
    );
  });

  it("keeps a POSIX root case-sensitive — there the two are different files", () => {
    const map = reroot(["/home/me/Photos"], "out");
    assert.throws(
      () => map("/home/me/photos/beach.jpg"),
      /not under any backed-up directory/,
    );
  });

  it("still picks the longest match when a shorter root also folds to a match", () => {
    const map = reroot(["C:\\data", "C:\\data\\photos"], "out");
    assert.equal(
      map("c:\\DATA\\Photos\\x.jpg"),
      join(resolve("out"), "photos", "x.jpg"),
    );
  });

  // A POSIX path's backslash is an ordinary filename character, not a
  // separator (path-match.mjs's shape rule) — `reroot` must not split on it
  // just because the root happens to be POSIX-shaped too. Windows itself
  // rejects a backslash in a filename, so this is POSIX-only.
  it(
    "keeps a literal backslash in a POSIX filename as one segment",
    {
      skip:
        process.platform === "win32" ? "backslash is a win32 separator" : false,
    },
    () => {
      const map = reroot(["/home/me/Photos"], "out");
      assert.equal(
        map("/home/me/Photos/weird\\name.jpg"),
        join(resolve("out"), "Photos", "weird\\name.jpg"),
      );
    },
  );

  // A `#DIR` header can carry a trailing separator once someone edits the
  // snapshot by hand. `preparePath`'s `base` answers "what comes after the
  // last separator", which is empty there — `reroot` must derive the root's
  // basename from its trimmed segments instead, the way it derives `path`'s.
  it("re-roots correctly when a #DIR header has a trailing separator", () => {
    const map = reroot(["/home/me/Photos/"], "out");
    assert.equal(
      map("/home/me/Photos/beach.jpg"),
      join(resolve("out"), "Photos", "beach.jpg"),
    );
  });
});

// `planRestore` is the pure decision step behind the restore loop: for each
// target it decides skip / refuse / write, with no disk or network access —
// `exists` is injected so these run with a fake filesystem.
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

  it("writes every target, a repeated hash included — dedupe is the restore loop's", () => {
    const plan = planRestore(entries, ["/a.jpg", "/b.jpg"], destFor, {
      exists: () => false,
    });
    assert.deepEqual(plan, [writeOf("/a.jpg"), writeOf("/b.jpg")]);
  });

  it("skips a target whose destination already exists", () => {
    const plan = planRestore(entries, ["/a.jpg", "/b.jpg"], destFor, {
      exists: (dest) => dest === "/a.jpg",
    });
    assert.deepEqual(plan, [
      { dest: "/a.jpg", action: "skip" },
      writeOf("/b.jpg"),
    ]);
  });

  it("overwrite writes over an existing destination instead of skipping it", () => {
    const plan = planRestore(entries, ["/a.jpg"], destFor, {
      exists: (dest) => dest === "/a.jpg",
      overwrite: true,
    });
    assert.deepEqual(plan, [writeOf("/a.jpg")]);
  });

  it("refuses a `:` in a Windows name — under either root", () => {
    // NTFS would take `a:b.jpg` as a stream of a file `a`; the drive's own `:`
    // and a UNC root are not names. `exists` isn't consulted for the refused
    // one: a stream left by an earlier restore must not read as "already here".
    for (const root of ["C:\\out\\", "\\\\nas\\share\\"]) {
      const named = new Map([
        [`${root}a:b.jpg`, { hash: "h1", mtime: "2026-01-01T00:00Z", size: 1 }],
        [`${root}b.jpg`, { hash: "h1", mtime: "2026-01-01T00:00Z", size: 1 }],
      ]);
      const plan = planRestore(named, [...named.keys()], destFor, {
        exists: (dest) => dest.includes("a:b"),
      });
      assert.deepEqual(plan, [
        { dest: `${root}a:b.jpg`, action: "refuse" },
        writeOf(`${root}b.jpg`),
      ]);
    }
  });

  it("leaves a `:` alone in a POSIX name, where it is an ordinary character", () => {
    const named = new Map([
      ["/a:b.jpg", { hash: "h1", mtime: "2026-01-01T00:00Z", size: 1 }],
    ]);
    const plan = planRestore(named, ["/a:b.jpg"], destFor, {
      exists: () => false,
    });
    assert.deepEqual(plan, [writeOf("/a:b.jpg")]);
  });
});
