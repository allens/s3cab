import assert from "node:assert/strict";
import crypto from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtempDisposable } from "node:fs/promises";
import { join, resolve } from "node:path";
import { beforeEach, describe, it, mock } from "node:test";
import { fileProps } from "./file-props.mjs";
import { writeSnapshot } from "../../test/helpers/write-snapshot.mjs";

/** @import { SnapshotEntries, SnapshotRow } from "./snapshot-file.mjs" */
/** @import { Drift } from "./upload.mjs" */

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
/** @type {Error | undefined} Let every PUT fail, to drive the failure paths. */
let putError;
mock.module("./s3.mjs", {
  exports: {
    objectExists: async (/** @type {string} */ uri) => {
      headUris.push(uri);
      return baselineExists;
    },
    putFile: async (/** @type {string} */ path, /** @type {string} */ uri) => {
      putFiles.push({ path, uri }); // recorded even when it fails: it was tried
      if (putError) {
        throw putError;
      }
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
const {
  baselineHashes,
  fileChangedError,
  planUpload,
  uploadObjects,
  uploadSnapshot,
  uploadDir,
} = await import("./upload.mjs");

beforeEach(() => {
  baselineExists = true;
  headUris = [];
  putFiles = [];
  storedUris = new Set();
  storeHashes = [];
  listedPrefixes = [];
  deletionRecords = new Map();
  putError = undefined;
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

describe("baselineHashes", () => {
  it("is the baseline's content hashes, whatever paths they sit under", () => {
    const baseline = lookup({ "a.txt": "h1", "copy.txt": "h1", "b.txt": "h2" });
    assert.deepEqual(baselineHashes(baseline), new Set(["h1", "h2"]));
  });

  it("drops a hash the deletion record marks deleted (ADR-0064)", () => {
    // The baseline honestly says h1 was stored when it uploaded — but a later
    // `delete` removed it, so its word is punched through and the content is no
    // longer treated as stored. h2's skip survives untouched.
    const baseline = lookup({ "a.txt": "h1", "b.txt": "h2" });
    assert.deepEqual(baselineHashes(baseline, ["h1"]), new Set(["h2"]));
  });
});

describe("planUpload", () => {
  it("plans hashes in the target that aren't stored", () => {
    const target = lookup({ "a.txt": "h1", "b.txt": "h2", "c.txt": "h3" });
    const plan = planUpload(target, new Set(["h1"]));
    assert.deepEqual([...plan.keys()].sort(), ["h2", "h3"]);
  });

  it("plans everything when nothing is stored", () => {
    const target = lookup({ "a.txt": "h1", "b.txt": "h2" });
    const plan = planUpload(target, new Set());
    assert.deepEqual([...plan.keys()].sort(), ["h1", "h2"]);
  });

  it("plans a hash under several paths once — the first path wins", () => {
    const target = lookup({ "a.txt": "h1", "copy.txt": "h1", "b.txt": "h2" });
    const plan = planUpload(target, new Set());
    assert.deepEqual(
      plan,
      new Map([
        ["h1", "a.txt"],
        ["h2", "b.txt"],
      ]),
    );
  });

  it("matches on content — a file that only moved or was renamed is not re-uploaded", () => {
    const target = lookup({ "new/place.txt": "h1" });
    const stored = baselineHashes(lookup({ "old/place.txt": "h1" }));
    assert.equal(planUpload(target, stored).size, 0);
  });

  it("plans nothing when every target hash is already stored", () => {
    const target = lookup({ "a.txt": "h1", "b.txt": "h2" });
    const plan = planUpload(target, new Set(["h1", "h2", "h3"]));
    assert.equal(plan.size, 0);
  });
});

// The fused pipeline's PUT transform (ADR-0069): rows in, the same rows out, objects
// uploaded in passing. Driven here as `backup` drives it — straight over a row
// stream, with only the `putFile` seam mocked, so `putFiles` is the evidence of
// exactly which objects went up and in which order.
describe("uploadObjects (the streaming PUT transform)", () => {
  const sha = (/** @type {string} */ content) =>
    crypto.hash("sha256", Buffer.from(content), "hex");
  const uri = (/** @type {string} */ content) =>
    `s3://fused/objects/${sha(content)}`;

  /**
   * A snapshot row for a real file on disk — the shape the hash pass emits, with
   * the size/mtime the drift guard re-checks against.
   * @param {string} path
   * @returns {Promise<SnapshotRow>}
   */
  const row = async (path) => [path, await fileProps(path)];

  /**
   * Three files, two of which share their content (so they share one object).
   * @param {string} dirPath
   */
  const files = (dirPath) => {
    const paths = {
      a: join(dirPath, "a.txt"),
      copy: join(dirPath, "copy.txt"),
      c: join(dirPath, "c.txt"),
    };
    writeFileSync(paths.a, "hello");
    writeFileSync(paths.copy, "hello"); // identical content → one object
    writeFileSync(paths.c, "world");
    return paths;
  };

  /**
   * The three files' rows, in walk order.
   * @param {string} dirPath
   */
  const rowsOf = async (dirPath) => {
    const { a, copy, c } = files(dirPath);
    return [await row(a), await row(copy), await row(c)];
  };

  const uploader = (/** @type {Set<string>} */ stored = new Set()) =>
    uploadObjects({ bucket: "fused", stored });

  it("PUTs each distinct hash once and yields every row on unchanged", async () => {
    await using dir = await mkTmpDir();
    const rows = await rowsOf(dir.path);
    const upload = uploader();

    const out = await Array.fromAsync(upload.through(rows));

    // The transform is a pipe: what the snapshot records is exactly what came in.
    assert.deepEqual(out, rows);
    assert.deepEqual(
      putFiles.map((put) => put.uri),
      [uri("hello"), uri("world")],
    );
    assert.deepEqual(upload.result(), {
      candidates: 2,
      uploaded: 2,
      drifted: [],
      failure: undefined,
    });
  });

  it("attempts nothing for content already stored", async () => {
    await using dir = await mkTmpDir();
    const rows = await rowsOf(dir.path);
    const upload = uploader(new Set([sha("hello"), sha("world")]));

    const out = await Array.fromAsync(upload.through(rows));

    assert.deepEqual(out, rows);
    assert.deepEqual(putFiles, []);
    assert.equal(upload.result().candidates, 0);
  });

  it("counts an already-present object as a candidate but not an upload", async () => {
    await using dir = await mkTmpDir();
    const rows = await rowsOf(dir.path);
    storedUris.add(uri("hello")); // the conditional PUT will no-op on this one

    const upload = uploader();
    await Array.fromAsync(upload.through(rows));

    const { candidates, uploaded } = upload.result();
    assert.equal(candidates, 2);
    assert.equal(uploaded, 1);
  });

  it("passes an #ERROR row through without an upload", async () => {
    await using dir = await mkTmpDir();
    const unreadable = join(dir.path, "locked.bin");
    /** @type {[string, Error]} */
    const errorRow = [unreadable, new Error("EACCES: permission denied")];
    const upload = uploader();

    const out = await Array.fromAsync(upload.through([errorRow]));

    assert.deepEqual(out, [errorRow]);
    assert.deepEqual(putFiles, []);
    assert.equal(upload.result().candidates, 0);
  });

  it("keeps the rows flowing after an upload fails, and reports the failure", async () => {
    // The complete-local-artifact invariant: the caller's snapshot file must
    // still land in full, so a failed transfer must not tear the stream down.
    // Further uploads are abandoned — one dead network is enough.
    await using dir = await mkTmpDir();
    const rows = await rowsOf(dir.path);
    putError = new Error("connection reset");
    const upload = uploader();

    const out = await Array.fromAsync(upload.through(rows));

    assert.deepEqual(out, rows);
    assert.equal(putFiles.length, 1, "only the first object was attempted");
    const { candidates, uploaded, failure } = upload.result();
    assert.equal(candidates, 2);
    assert.equal(uploaded, 0);
    assert.equal(failure?.message, "connection reset");
  });

  it("skips a file that changed since it was hashed, and keeps storing the rest", async () => {
    // Drift is one file's problem, not the run's: its bytes no longer match the
    // hash recorded for them, but every other file's do — and those bytes are
    // worth having in the cloud for the fresh backup this asks for.
    await using dir = await mkTmpDir();
    const { a } = files(dir.path);
    const rows = await rowsOf(dir.path);
    writeFileSync(a, "different, longer bytes"); // a.txt drifts after hashing

    const upload = uploader();
    const out = await Array.fromAsync(upload.through(rows));

    assert.deepEqual(out, rows, "the drifted row still reaches the TSV");
    assert.deepEqual(
      putFiles.map((put) => put.uri),
      [uri("world")], // "hello" was skipped; c.txt still went up
    );
    const { drifted, uploaded, failure } = upload.result();
    // Drift is reported as data, not as a pre-built error: the caller decides
    // whether that is fatal (backup) or a reportable skip (the folder seed).
    assert.deepEqual(drifted, [{ path: a, reason: "changed" }]);
    assert.equal(failure, undefined, "drift is not a transport failure");
    assert.equal(uploaded, 1);
  });

  it("treats a file removed since it was hashed the same way", async () => {
    await using dir = await mkTmpDir();
    const { a } = files(dir.path);
    const rows = await rowsOf(dir.path);
    rmSync(a);

    const upload = uploader();
    await Array.fromAsync(upload.through(rows));

    assert.deepEqual(upload.result().drifted, [{ path: a, reason: "removed" }]);
    assert.deepEqual(
      putFiles.map((put) => put.uri),
      [uri("world")],
    );
  });

  it("treats a file it can no longer stat as changed, keeping the errno as the cause", async () => {
    // The failure mode Copilot caught on #245: a non-ENOENT stat error used to
    // escape the transform, and a throw here destroys the pipeline and truncates
    // the snapshot being written. A NUL in the path is the portable way to make
    // `lstat` fail with something other than ENOENT.
    await using dir = await mkTmpDir();
    const { c } = files(dir.path);
    const [, props] = await row(c);
    /** @type {SnapshotRow} */
    const unstattable = [join(dir.path, "no\0such.txt"), props];

    const upload = uploader();
    const out = await Array.fromAsync(upload.through([unstattable]));

    assert.deepEqual(out, [unstattable], "the row still reaches the TSV");
    assert.deepEqual(putFiles, [], "an unconfirmable file is never stored");
    const { drifted } = upload.result();
    assert.equal(drifted.length, 1);
    assert.equal(drifted[0]?.reason, "unreadable");
    assert.ok(drifted[0]?.cause, "the raw error rides along for S3CAB_DEBUG");
  });

  it("never throws mid-stream — that would truncate the caller's snapshot", async () => {
    // The load-bearing property: a throw inside a pipeline link destroys every
    // stream in the chain, including the snapshot writer. Both failure kinds at
    // once, and the transform still drains normally.
    await using dir = await mkTmpDir();
    const { a } = files(dir.path);
    const rows = await rowsOf(dir.path);
    writeFileSync(a, "different, longer bytes");
    putError = new Error("connection reset");

    const upload = uploader();
    const out = await Array.fromAsync(upload.through(rows));

    assert.deepEqual(out, rows);
  });

  it("reports a drift and a later transport failure separately, not first-wins", async () => {
    // Why the outcome has two fields. One slot meant the *first* failure won, so
    // a drift on an early row hid a dead network on a later one: the run still
    // failed but blamed the wrong thing, and any caller that tolerates drift
    // would have reported success on a dropped link. Drift is per-file and
    // plural; a transport failure is singular and terminal.
    await using dir = await mkTmpDir();
    const { a } = files(dir.path);
    const rows = await rowsOf(dir.path);
    writeFileSync(a, "different, longer bytes"); // row 1 drifts
    putError = new Error("connection reset"); // row 3's PUT then dies

    const upload = uploader();
    await Array.fromAsync(upload.through(rows));

    const { drifted, failure } = upload.result();
    assert.deepEqual(drifted, [{ path: a, reason: "changed" }]);
    assert.equal(failure?.message, "connection reset");
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

describe("fileChangedError", () => {
  /** @type {Drift} */
  const changed = { path: "photo.raw", reason: "changed" };

  it("names the file, what happened, and the fresh backup that fixes it", () => {
    const error = fileChangedError([changed], "photos");

    assert.match(error.message, /Couldn't back up 'photo.raw'/);
    assert.match(error.message, /changed while the backup was running/);
    assert.match(error.message, /s3cab backup photos/);
  });

  it("keeps the errno in a parenthetical for an unreadable file (ADR-0030)", () => {
    const error = fileChangedError(
      [{ path: "x.bin", reason: "unreadable", cause: { code: "EACCES" } }],
      "photos",
    );

    assert.match(error.message, /could no longer be read.*\(EACCES\)/);
  });

  it("says how many others when several files drifted", () => {
    // One drifting file is bad luck; several means something is actively writing
    // into the set, and the advice below reads very differently in that case. The
    // count is the only thing that distinguishes them, so it has to be said.
    const error = fileChangedError(
      [
        changed,
        { path: "b.raw", reason: "removed" },
        { path: "c.raw", reason: "changed" },
      ],
      "photos",
    );

    assert.match(error.message, /Couldn't back up 'photo.raw'/, "still leads");
    assert.match(error.message, /2 other files/);
  });

  it("says nothing about others when only one drifted", () => {
    // Deliberately narrow: the standing prose already contains "another program",
    // so a bare /other/ would match the singular message too.
    assert.doesNotMatch(
      fileChangedError([changed], "photos").message,
      /\d+ other files/,
    );
  });
});

// The staleness guard end to end: a file that changed (or vanished) since the
// snapshot recorded it is never stored under that snapshot's old-content hash
// (proposals/bugs.md), and the snapshot is never published — its presence would
// promise objects that aren't there. The guard fires before that file's PUT, so
// here (a one-file snapshot) `putFiles` stays empty.
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

  it("fails, storing neither the file nor the snapshot, when it changed since the snapshot", async () => {
    await using dir = await mkTmpDir();
    const { file, args } = await planOneFile(dir.path);

    // Rewrite with different-length content: size drifts even if the filesystem
    // mtime resolution were too coarse to catch the edit on its own.
    writeFileSync(file, "different, longer bytes");

    await assert.rejects(
      () => uploadSnapshot(args),
      /while the backup was running/,
    );
    assert.deepEqual(putFiles, []);
  });

  it("fails the same way when the file was removed since the snapshot", async () => {
    await using dir = await mkTmpDir();
    const { file, args } = await planOneFile(dir.path);

    rmSync(file);

    await assert.rejects(
      () => uploadSnapshot(args),
      /while the backup was running/,
    );
    assert.deepEqual(putFiles, []);
  });

  it("never publishes the manifest when an object upload failed", async () => {
    // A failed transfer is reported only after the rows have drained, but the
    // snapshot must still not go up: its presence is the promise that every
    // object it references is already stored.
    await using dir = await mkTmpDir();
    const { args } = await planOneFile(dir.path);
    putError = new Error("connection reset");

    await assert.rejects(() => uploadSnapshot(args), /connection reset/);
    assert.equal(
      putFiles.length,
      1,
      "the object was tried, the snapshot never",
    );
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
