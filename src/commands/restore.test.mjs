import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { mkdtempDisposable } from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { deleteObject } from "../lib/s3.mjs";
import { remoteSnapshotsPrefix } from "../lib/remote.mjs";
import { resolveRemoteSet, setSnapshotsDir } from "../lib/sets.mjs";
import { readSnapshot } from "../lib/snapshot-file.mjs";
import { backup } from "./backup.mjs";
import { planRestore, reroot, restore, selectEntries } from "./restore.mjs";
import { setup } from "./setup.mjs";
import { useTempHome } from "../../test/helpers/temp-home.mjs";

/** @import { SnapshotEntries } from "../lib/snapshot-file.mjs" */

// `selectEntries` is the pure path-filter selector behind `restore [paths…]`.
// Paths are written with forward slashes: on POSIX they are native, and on
// Windows `normalize` converts both separators to `/`, so these cases exercise
// the same matching on every OS (the win32-only case/separator behaviour gets
// its own guarded tests below).
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

  it("matches everything under a folder filter", () => {
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

  const onWin32 = process.platform === "win32";

  it("is case-insensitive on Windows, case-sensitive elsewhere", () => {
    const got = selectEntries(paths, ["/HOME/ME/photos"]);
    if (onWin32) {
      assert.deepEqual(got, [
        "/home/me/Photos/beach.jpg",
        "/home/me/Photos/2024/ski.jpg",
      ]);
    } else {
      assert.deepEqual(got, []);
    }
  });

  it(
    "accepts backslash paths and filters on Windows",
    { skip: !onWin32 },
    () => {
      const winPaths = ["C:\\Users\\me\\Photos\\beach.jpg"];
      assert.deepEqual(
        selectEntries(winPaths, ["C:\\Users\\me\\Photos"]),
        winPaths,
      );
      // A user who types forward slashes on Windows matches the same files.
      assert.deepEqual(
        selectEntries(winPaths, ["C:/Users/me/Photos"]),
        winPaths,
      );
    },
  );
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
    assert.throws(() => map("/etc/passwd"), /not under any backed-up folder/);
  });
});

// `planRestore` is the pure decision step behind the restore loop: for each
// target it decides skip / fetch / copy-from-an-earlier-fetch, with no disk or
// network access — `exists` is injected so these run with a fake filesystem.
describe("planRestore", () => {
  const destFor = (/** @type {string} */ source) => source;
  /** @type {SnapshotEntries} */
  const entries = new Map([
    ["/a.jpg", { hash: "h1", mtime: "2026-01-01T00:00Z", size: 1 }],
    ["/b.jpg", { hash: "h1", mtime: "2026-01-01T00:00Z", size: 1 }], // same content as a.jpg
    ["/c.jpg", { hash: "h2", mtime: "2026-01-02T00:00Z", size: 2 }],
  ]);

  it("fetches the first occurrence of a hash", () => {
    const plan = planRestore(entries, ["/a.jpg"], destFor, {
      exists: () => false,
    });
    assert.deepEqual(plan, [
      {
        dest: "/a.jpg",
        action: "fetch",
        hash: "h1",
        mtime: "2026-01-01T00:00Z",
      },
    ]);
  });

  it("copies a later occurrence of the same hash from the first fetch's destination", () => {
    const plan = planRestore(entries, ["/a.jpg", "/b.jpg"], destFor, {
      exists: () => false,
    });
    assert.deepEqual(plan, [
      {
        dest: "/a.jpg",
        action: "fetch",
        hash: "h1",
        mtime: "2026-01-01T00:00Z",
      },
      {
        dest: "/b.jpg",
        action: "copy",
        hash: "h1",
        mtime: "2026-01-01T00:00Z",
        from: "/a.jpg",
      },
    ]);
  });

  it("skips a target whose destination already exists", () => {
    const plan = planRestore(entries, ["/a.jpg"], destFor, {
      exists: (dest) => dest === "/a.jpg",
    });
    assert.deepEqual(plan, [{ dest: "/a.jpg", action: "skip" }]);
  });

  it("overwrite bypasses the skip but doesn't disable dedupe", () => {
    const plan = planRestore(entries, ["/a.jpg", "/b.jpg"], destFor, {
      exists: (dest) => dest === "/a.jpg",
      overwrite: true,
    });
    assert.deepEqual(plan, [
      {
        dest: "/a.jpg",
        action: "fetch",
        hash: "h1",
        mtime: "2026-01-01T00:00Z",
      },
      {
        dest: "/b.jpg",
        action: "copy",
        hash: "h1",
        mtime: "2026-01-01T00:00Z",
        from: "/a.jpg",
      },
    ]);
  });

  it("a skipped entry never seeds the dedupe — a later same-hash target still fetches", () => {
    // a.jpg is skipped (pre-existing, unverified content), so b.jpg — same
    // hash — must not be told to copy from it.
    const plan = planRestore(entries, ["/a.jpg", "/b.jpg"], destFor, {
      exists: (dest) => dest === "/a.jpg",
    });
    assert.deepEqual(plan, [
      { dest: "/a.jpg", action: "skip" },
      {
        dest: "/b.jpg",
        action: "fetch",
        hash: "h1",
        mtime: "2026-01-01T00:00Z",
      },
    ]);
  });

  it("different hashes never dedupe against each other", () => {
    const plan = planRestore(entries, ["/a.jpg", "/c.jpg"], destFor, {
      exists: () => false,
    });
    assert.deepEqual(plan, [
      {
        dest: "/a.jpg",
        action: "fetch",
        hash: "h1",
        mtime: "2026-01-01T00:00Z",
      },
      {
        dest: "/c.jpg",
        action: "fetch",
        hash: "h2",
        mtime: "2026-01-02T00:00Z",
      },
    ]);
  });
});

// The backup → restore round trip against a real bucket (specs/backup.md slice
// 4). Gated on S3CAB_TEST_BUCKET (+ ambient AWS credentials) like the other S3
// suites: restore inherently needs the cloud (the object content lives only in
// `objects/`), so there is no offline form of this test. Credentials must come
// from the environment (CI/OIDC) because useTempHome redirects HOME away from
// any ~/.aws config to isolate the set store and objects cache.
const TEST_BUCKET = process.env.S3CAB_TEST_BUCKET;
const skip = TEST_BUCKET
  ? false
  : "set S3CAB_TEST_BUCKET (and AWS credentials) to run S3 integration tests";

const mkTmpDir = async () => mkdtempDisposable(join("test", ".tmp"));

/** @type {NodeJS.ProcessEnv} */
let savedEnv;
beforeEach(() => {
  savedEnv = { ...process.env };
});
afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in savedEnv)) delete process.env[key];
  }
  Object.assign(process.env, savedEnv);
});

const sha256 = (/** @type {string} */ path) =>
  createHash("sha256").update(readFileSync(path)).digest("hex");

describe("backup → restore round trip (real bucket)", { skip }, () => {
  it("recovers files byte-identically, skips existing, and overwrites on request", async () => {
    await using dir = await mkTmpDir();
    useTempHome(dir.path);
    const bucket = /** @type {string} */ (TEST_BUCKET);
    const setName = `rt${Date.now()}`; // lowercase + digits: a valid set name

    // A small tree with a nested folder; unique content → unique object hashes,
    // so the shared objects/ store stays isolated and teardown deletes exactly
    // what this run made.
    const srcDir = join(dir.path, "Photos");
    mkdirSync(join(srcDir, "2024"), { recursive: true });
    const beach = join(srcDir, "beach.jpg");
    const ski = join(srcDir, "2024", "ski.jpg");
    writeFileSync(beach, `beach ${setName}`);
    writeFileSync(ski, `ski ${setName}`);

    await setup(setName, [srcDir], { bucket });
    const { snapshot } = await backup(setName);

    // The snapshot is the source of truth for what restore should reproduce
    // (its keys are the original absolute paths; realpath may differ from the
    // join above, so assert against the snapshot, not the literal paths).
    const { entries } = await readSnapshot(setSnapshotsDir(setName), snapshot);
    const hashes = [...new Set([...entries.values()].map((p) => p.hash))];

    try {
      // Wipe the originals, then restore to their original locations.
      rmSync(srcDir, { recursive: true, force: true });
      const r1 = await restore(setName);
      assert.equal(r1.snapshot, snapshot);
      assert.equal(r1.skipped.length, 0);
      assert.equal(r1.restored.length, entries.size);
      for (const [path, props] of entries) {
        assert.equal(sha256(path), props.hash, `content of ${path}`);
        assert.equal(
          statSync(path).mtime.getTime(),
          new Date(props.mtime).getTime(),
          `mtime of ${path}`,
        );
      }

      // A second restore touches nothing — every file now exists.
      const r2 = await restore(setName);
      assert.equal(r2.restored.length, 0);
      assert.equal(r2.skipped.length, entries.size);

      // --overwrite replaces a locally changed file with the backed-up content.
      const first = [...entries][0];
      assert.ok(first, "snapshot has at least one entry");
      const [firstPath, firstProps] = first;
      writeFileSync(firstPath, "locally changed since the backup");
      const r3 = await restore(setName, [], { overwrite: true });
      assert.equal(r3.skipped.length, 0);
      assert.equal(sha256(firstPath), firstProps.hash);

      // --output re-roots the same backup under a chosen folder, as
      // <output>/<source-basename>/… — independent of the originals.
      const outDir = join(dir.path, "restored");
      const r4 = await restore(setName, [], { output: outDir });
      assert.equal(r4.skipped.length, 0);
      assert.equal(r4.restored.length, entries.size);
      const wantHashes = new Set([...entries.values()].map((p) => p.hash));
      for (const dest of r4.restored) {
        assert.ok(dest.startsWith(resolve(outDir)), `${dest} under ${outDir}`);
        assert.ok(
          dest.includes("Photos"),
          `${dest} keeps the source folder name`,
        );
        assert.ok(wantHashes.has(sha256(dest)), `content of ${dest}`);
      }
    } finally {
      for (const hash of hashes) {
        await deleteObject(`s3://${bucket}/objects/${hash}`);
      }
      const { namespace } = resolveRemoteSet(setName);
      await deleteObject(
        `s3://${bucket}/${remoteSnapshotsPrefix(namespace)}${snapshot}.tsv.zst`,
      );
    }
  });
});
