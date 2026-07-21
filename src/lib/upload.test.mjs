import assert from "node:assert/strict";
import crypto from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtempDisposable } from "node:fs/promises";
import { join, resolve } from "node:path";
import { beforeEach, describe, it, mock } from "node:test";
import { writeSnapshot } from "../../test/helpers/write-snapshot.mjs";

/** @import { SnapshotEntries } from "./snapshot-file.mjs" */

// This file mocks the s3.mjs seam, per docs/design/testing.md ("mock at s3.mjs,
// not the AWS SDK"): the baseline-trust check (one HEAD before the baseline is
// believed) and the drift guard run here with zero AWS, on every push. The
// recorded `putFiles`/`headUris`/`listedPrefixes` are the assertions' evidence
// of exactly which remote calls a run made. Module mocking has a load-bearing
// ordering rule (see objects.test.mjs): the mock is registered first and
// upload.mjs is imported dynamically below — there is deliberately no static
// import of it. The runner needs `--experimental-test-module-mocks`.

/** Whether the mocked `objectExists` reports the remote baseline present. */
let baselineExists = true;
/** @type {string[]} URIs HEADed via `objectExists`. */
let headUris = [];
/** @type {{ path: string, uri: string }[]} PUTs, in call order. */
let putFiles = [];
/** @type {Set<string>} object URIs the store already holds (PUT no-ops → false). */
let storedUris = new Set();
/** @type {string[]} Hashes the mocked store LIST yields under `objects/`. */
let storeHashes = [];
/** @type {string[]} Prefix URIs LISTed — empty when no LIST fallback ran. */
let listedPrefixes = [];
/** @type {Map<string, { deletedOn: string }>} the bucket's deletion records */
let deletionRecords = new Map();
mock.module("./s3.mjs", {
  exports: {
    objectExists: async (/** @type {string} */ uri) => {
      headUris.push(uri);
      return baselineExists;
    },
    putFile: async (/** @type {string} */ path, /** @type {string} */ uri) => {
      putFiles.push({ path, uri });
      return !storedUris.has(uri); // false = the store already held this object
    },
    listObjects: async function* (/** @type {string} */ uri) {
      listedPrefixes.push(uri);
      for (const hash of storeHashes) {
        yield { Key: `objects/${hash}` };
      }
    },
    // Imported by modules in upload.mjs's graph (objects.mjs, remote.mjs);
    // no test here reaches them.
    getStream: async () => {
      throw new Error("unexpected getStream in upload tests");
    },
    deleteObject: async () => {},
    isObjectNotFound: () => false,
  },
});
mock.module("./deletion-record.mjs", {
  exports: {
    readDeletionRecords: async () => deletionRecords,
  },
});
const { planUpload, uploadSnapshot, uploadDir } = await import("./upload.mjs");

beforeEach(() => {
  baselineExists = true;
  headUris = [];
  putFiles = [];
  storedUris = new Set();
  storeHashes = [];
  listedPrefixes = [];
  deletionRecords = new Map();
});

const mkTmpDir = async () => mkdtempDisposable(join("test", ".tmp"));

/**
 * Build a snapshot lookup from a path→hash map — only the hash matters to
 * `planUpload`, so size/mtime are filler.
 * @param {Record<string, string>} pathToHash
 * @returns {SnapshotEntries}
 */
const lookup = (pathToHash) =>
  new Map(
    Object.entries(pathToHash).map(([path, hash]) => [
      path,
      { hash, size: 0, mtime: "" },
    ]),
  );

describe("planUpload", () => {
  it("plans hashes in the target but not in the baseline", async () => {
    const target = lookup({ "a.txt": "h1", "b.txt": "h2", "c.txt": "h3" });
    const baseline = lookup({ "a.txt": "h1" });
    const plan = await planUpload(target, { baseline });
    assert.deepEqual([...plan.keys()].sort(), ["h2", "h3"]);
  });

  it("plans everything when nothing is known to be stored", async () => {
    const target = lookup({ "a.txt": "h1", "b.txt": "h2" });
    // No sources at all, and an empty baseline, read the same.
    const bare = await planUpload(target);
    assert.deepEqual([...bare.keys()].sort(), ["h1", "h2"]);
    const empty = await planUpload(target, { baseline: new Map() });
    assert.deepEqual([...empty.keys()].sort(), ["h1", "h2"]);
  });

  it("plans a hash under several paths once — the first path wins", async () => {
    const target = lookup({ "a.txt": "h1", "copy.txt": "h1", "b.txt": "h2" });
    const plan = await planUpload(target);
    assert.deepEqual(
      plan,
      new Map([
        ["h1", "a.txt"],
        ["h2", "b.txt"],
      ]),
    );
  });

  it("matches on content — a file that only moved or was renamed is not re-uploaded", async () => {
    const target = lookup({ "new/place.txt": "h1" });
    const baseline = lookup({ "old/place.txt": "h1" });
    const plan = await planUpload(target, { baseline });
    assert.equal(plan.size, 0);
  });

  it("plans nothing when every target hash is already in the baseline", async () => {
    const target = lookup({ "a.txt": "h1", "b.txt": "h2" });
    const baseline = lookup({ x: "h1", y: "h2", z: "h3" });
    const plan = await planUpload(target, { baseline });
    assert.equal(plan.size, 0);
  });

  it("re-plans a baseline hash the deletion record marks deleted (ADR-0064)", async () => {
    // The baseline honestly says h1 was stored when it uploaded — but a later
    // `delete` removed it, so its word is punched through and the file goes up
    // again. h2's skip survives untouched.
    const target = lookup({ "a.txt": "h1", "b.txt": "h2" });
    const baseline = lookup({ "a.txt": "h1", "b.txt": "h2" });
    const plan = await planUpload(target, { baseline, deleted: ["h1"] });
    assert.deepEqual(plan, new Map([["h1", "a.txt"]]));
  });

  it("streams listed store hashes out of the plan (the first-backup LIST diff)", async () => {
    const target = lookup({ "a.txt": "h1", "b.txt": "h2", "c.txt": "h3" });
    // An async iterable, as listObjectHashes yields — including hashes the
    // target never references (other sets' objects in the shared store).
    async function* listed() {
      yield "h2";
      yield "h-other-set";
    }
    const plan = await planUpload(target, { listed: listed() });
    assert.deepEqual(
      plan,
      new Map([
        ["h1", "a.txt"],
        ["h3", "c.txt"],
      ]),
    );
  });

  it("accepts a plain array for listed, and applies baseline and listed together", async () => {
    const target = lookup({ "a.txt": "h1", "b.txt": "h2", "c.txt": "h3" });
    const baseline = lookup({ "old.txt": "h1" });
    const plan = await planUpload(target, { baseline, listed: ["h3"] });
    assert.deepEqual(plan, new Map([["h2", "b.txt"]]));
  });
});

/**
 * Snapshot one real file as the upload target, plus a baseline snapshot of the
 * same file — so the target's one hash is in the baseline, and whether it gets
 * planned is decided entirely by whether the baseline is trusted. Returns the
 * file path, its content hash, and the shared `uploadSnapshot` args.
 * @param {string} dirPath - A temp dir to build the fixture in
 */
const oneFileFixture = async (dirPath) => {
  const contentDir = resolve(dirPath, "content");
  mkdirSync(contentDir, { recursive: true });
  const file = join(contentDir, "photo.raw");
  writeFileSync(file, "original bytes");
  const hash = crypto.hash("sha256", readFileSync(file), "hex");

  const snapshotDir = join(dirPath, "snapshots");
  mkdirSync(snapshotDir, { recursive: true });
  const target = "2025-01-15T1030";
  const baseline = "2025-01-15T1020";
  await writeSnapshot(snapshotDir, baseline, [file]);
  await writeSnapshot(snapshotDir, target, [file]);

  return {
    file,
    hash,
    args: {
      bucket: "trust-bucket",
      set: "trusty",
      snapshotDir,
      name: target,
      since: baseline,
    },
  };
};

// The baseline-trust check (proposals/bugs.md, the HIGH baseline-trust bug):
// a `--since` baseline is believed iff its snapshot still exists remotely —
// presence proves its objects were stored (objects-first/snapshot-last) and
// cleanup never deletes referenced objects. A baseline forgotten remotely may
// claim more is stored than is, and a hash it wrongly skips never reaches the
// conditional-PUT backstop — so on a miss the baseline is dropped entirely and
// the store is LISTed, as a first backup would.
describe("uploadSnapshot baseline trust", () => {
  it("trusts a baseline that still exists remotely — no object PUT, no store LIST", async () => {
    await using dir = await mkTmpDir();
    const { args } = await oneFileFixture(dir.path);

    const result = await uploadSnapshot(args);

    // The one HEAD, on the baseline's remote snapshot URI.
    assert.deepEqual(headUris, [
      `s3://trust-bucket/snapshots/trusty/${args.since}.tsv.zst`,
    ]);
    assert.deepEqual(listedPrefixes, []);
    // Nothing planned; the only PUT is the snapshot itself, last and alone.
    assert.deepEqual(
      putFiles.map(({ uri }) => uri),
      [`s3://trust-bucket/snapshots/trusty/${args.name}.tsv.zst`],
    );
    assert.equal(result.candidates, 0);
  });

  it("re-uploads content a delete removed, even under a trusted baseline (ADR-0064)", async () => {
    // The PR-A interlock's second half: remote existence proves the baseline's
    // objects were stored *then*; the deletion record says what a later
    // `delete` removed since. The file is still on disk and in the fresh
    // snapshot, so it re-uploads — objects first, snapshot last — with no LIST
    // fallback (the baseline itself is still trusted).
    await using dir = await mkTmpDir();
    const { file, hash, args } = await oneFileFixture(dir.path);
    deletionRecords.set(hash, { deletedOn: "2026-07-19T1422" });

    const result = await uploadSnapshot(args);

    assert.deepEqual(listedPrefixes, []);
    assert.deepEqual(putFiles, [
      { path: file, uri: `s3://trust-bucket/objects/${hash}` },
      {
        path: join(args.snapshotDir, `${args.name}.tsv.zst`),
        uri: `s3://trust-bucket/snapshots/trusty/${args.name}.tsv.zst`,
      },
    ]);
    assert.equal(result.candidates, 1);
  });

  it("distrusts a baseline gone from the cloud — LISTs the store and re-plans its objects", async () => {
    await using dir = await mkTmpDir();
    const { file, hash, args } = await oneFileFixture(dir.path);

    baselineExists = false; // forgotten remotely (or never uploaded)
    const result = await uploadSnapshot(args);

    // Fallback ran: the store was LISTed, the stale baseline's skip was not
    // honoured, and the object was uploaded before the snapshot (objects
    // first, snapshot last).
    assert.deepEqual(listedPrefixes, ["s3://trust-bucket/objects/"]);
    assert.deepEqual(putFiles, [
      { path: file, uri: `s3://trust-bucket/objects/${hash}` },
      {
        path: join(args.snapshotDir, `${args.name}.tsv.zst`),
        uri: `s3://trust-bucket/snapshots/trusty/${args.name}.tsv.zst`,
      },
    ]);
    assert.equal(result.candidates, 1);
    assert.equal(result.uploaded, 1);
  });

  it("the LIST fallback still skips objects the store genuinely has", async () => {
    await using dir = await mkTmpDir();
    const { hash, args } = await oneFileFixture(dir.path);

    baselineExists = false;
    storeHashes = [hash]; // the object survived (still referenced elsewhere)
    const result = await uploadSnapshot(args);

    assert.deepEqual(
      putFiles.map(({ uri }) => uri),
      [`s3://trust-bucket/snapshots/trusty/${args.name}.tsv.zst`],
    );
    assert.equal(result.candidates, 0);
  });
});

// The snapshot→upload staleness guard: a planned file that changed (or vanished)
// since the snapshot must abort the run, never store its current bytes under the
// snapshot's old-content hash (proposals/bugs.md). The guard fires before any
// PUT, so a drifted file rejects with `putFiles` still empty — no object stored,
// no snapshot published.
describe("uploadSnapshot drift guard", () => {
  /**
   * Snapshot one real file as the upload target, with an empty baseline so the
   * file is planned (its hash isn't in the baseline). Returns the file path and
   * the shared `uploadSnapshot` args.
   * @param {string} dirPath - A temp dir to build the fixture in
   */
  const planOneFile = async (dirPath) => {
    const contentDir = resolve(dirPath, "content");
    mkdirSync(contentDir, { recursive: true });
    const file = join(contentDir, "photo.raw");
    writeFileSync(file, "original bytes");

    const snapshotDir = join(dirPath, "snapshots");
    mkdirSync(snapshotDir, { recursive: true });
    const target = "2025-01-15T1030";
    const baseline = "2025-01-15T1020";
    await writeSnapshot(snapshotDir, baseline, []); // empty → target file planned
    await writeSnapshot(snapshotDir, target, [file]);

    return {
      file,
      args: {
        bucket: "drift-guard-bucket",
        set: "drifty",
        snapshotDir,
        name: target,
        since: baseline,
      },
    };
  };

  it("aborts when a planned file changed since the snapshot", async () => {
    await using dir = await mkTmpDir();
    const { file, args } = await planOneFile(dir.path);

    // Rewrite with different-length content: size drifts even if the filesystem
    // mtime resolution were too coarse to catch the edit on its own.
    writeFileSync(file, "different, longer bytes");

    await assert.rejects(() => uploadSnapshot(args), /changed or was removed/);
    assert.deepEqual(putFiles, []);
  });

  it("aborts when a planned file was removed since the snapshot", async () => {
    await using dir = await mkTmpDir();
    const { file, args } = await planOneFile(dir.path);

    rmSync(file);

    await assert.rejects(() => uploadSnapshot(args), /changed or was removed/);
    assert.deepEqual(putFiles, []);
  });
});

// The folder-seed primitive (`upload --dir`): walk a live subtree honouring the
// set's excludes, hash each file, and conditional-PUT its object — no snapshot,
// no baseline diff, no store LIST (the conditional PUT is the "already stored?"
// check). Real walk + real hashing over a temp fixture; only the `putFile` seam
// is mocked, so `putFiles` is the evidence of exactly which objects went up.
describe("uploadDir (seed a folder's objects)", () => {
  const sha = (/** @type {string} */ content) =>
    crypto.hash("sha256", Buffer.from(content), "hex");

  /**
   * Build a subtree with a duplicate, a nested file, and a `.tmp` to be excluded.
   * @param {string} dirPath - A temp dir to build the fixture in
   */
  const seedFixture = (dirPath) => {
    const root = resolve(dirPath, "photos");
    mkdirSync(join(root, "sub"), { recursive: true });
    writeFileSync(join(root, "a.txt"), "hello");
    writeFileSync(join(root, "b.txt"), "hello"); // identical content → deduped
    writeFileSync(join(root, "c.txt"), "world");
    writeFileSync(join(root, "scratch.tmp"), "junk"); // matched by the exclude
    writeFileSync(join(root, "sub", "d.txt"), "deep");

    const excludePath = join(dirPath, "exclude.txt");
    writeFileSync(excludePath, "*.tmp\n");
    return { root, excludePath };
  };

  it("walks (honouring excludes), dedups by content, and PUTs each object once", async () => {
    await using dir = await mkTmpDir();
    const { root, excludePath } = seedFixture(dir.path);

    const result = await uploadDir({
      bucket: "seed-bucket",
      dir: root,
      excludePath,
    });

    // Three distinct objects: "hello" (a.txt/b.txt share it), "world", "deep".
    // scratch.tmp is excluded, so its bytes never reach a PUT.
    const expected = ["hello", "world", "deep"]
      .map((c) => `s3://seed-bucket/objects/${sha(c)}`)
      .sort();
    assert.deepEqual(putFiles.map(({ uri }) => uri).sort(), expected);
    assert.equal(result.candidates, 3);
    assert.equal(result.uploaded, 3);
  });

  it("counts an already-stored object as a candidate but not an upload", async () => {
    await using dir = await mkTmpDir();
    const { root, excludePath } = seedFixture(dir.path);
    storedUris.add(`s3://seed-bucket/objects/${sha("world")}`); // already present

    const result = await uploadDir({
      bucket: "seed-bucket",
      dir: root,
      excludePath,
    });

    // Still considered (a conditional PUT is attempted), but not transferred.
    assert.equal(result.candidates, 3);
    assert.equal(result.uploaded, 2);
  });
});
