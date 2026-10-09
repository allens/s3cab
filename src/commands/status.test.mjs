import assert from "node:assert/strict";
import { createReadStream } from "node:fs";
import { mkdtempDisposable } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import { s3Seam } from "../../test/helpers/s3-seam.mjs";
import { useTempHome } from "../../test/helpers/temp-home.mjs";

// Only the S3 seam is faked, so the remote diff runs through the real snapshot
// reader and deletion-record parser. The remote snapshot is served from the
// local file of the same name: a backed-up snapshot is byte-identical to it.

/** Keys the fake bucket lists. */
/** @type {string[]} */
let keys = [];
/** Text objects (the deletion record), by URI. */
/** @type {Record<string, string>} */
let textByUri = {};
/** Stored objects' sizes, by URI — what a HEAD finds. */
/** @type {Record<string, number>} */
let sizeByUri = {};
/** Where the remote snapshot's bytes come from. */
/** @type {string} */
let remoteSnapshotPath;

mock.module("../lib/s3.mjs", {
  exports: s3Seam({
    listObjects: async function* (/** @type {string} */ uri) {
      const prefix = uri.slice("s3://b/".length);
      yield* keys
        .filter((key) => key.startsWith(prefix))
        .map((Key) => ({ Key }));
    },
    getText: async (/** @type {string} */ uri) => textByUri[uri],
    objectSize: async (/** @type {string} */ uri) => sizeByUri[uri],
    getStream: async () => createReadStream(remoteSnapshotPath),
  }),
});

const { status } = await import("./status.mjs");
const { writeSet } = await import("../lib/sets.mjs");
const { writeSnapshot } = await import("../../test/helpers/write-snapshot.mjs");

const mkTmpDir = async () => mkdtempDisposable(join("test", ".tmp"));
const NAME = "2026-10-09T1200";
const HELLO_HASH =
  "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";

/** @type {NodeJS.ProcessEnv} */
let savedEnv;
beforeEach(() => {
  savedEnv = { ...process.env };
  keys = [];
  textByUri = {};
  sizeByUri = {};
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
 * A set whose latest local snapshot is also its latest remote one, holding one
 * file of content `hello`.
 * @param {string} root
 */
const backedUpSet = async (root) => {
  const home = useTempHome(root);
  writeSet("photos", { dirs: [join(root, "photos")], bucket: "b" });
  const snapshotDir = join(home, ".s3cab", "sets", "photos", "snapshots");
  remoteSnapshotPath = await writeSnapshot(snapshotDir, NAME, [
    new File(["hello"], "a.txt"),
  ]);
  keys.push(`snapshots/photos/${NAME}.tsv.gz`);
};

/**
 * A deletion record naming `hash`.
 * @param {string} hash
 */
const recordDeleted = (hash) => {
  keys.push("objects.deleted-1.tsv");
  textByUri["s3://b/objects.deleted-1.tsv"] =
    "#DELETED\t\t2026-10-09T11:04:55.120Z\tgone on purpose\n" +
    `${hash}\t5\t2026-10-09T11:04:55.120Z\tallen@DESKTOP\n#END\n`;
};

describe("status", () => {
  it("tells you to snapshot first when the set has no local snapshot", async () => {
    await using dir = await mkTmpDir();
    useTempHome(dir.path);
    writeSet("photos", { dirs: [join(dir.path, "photos")], bucket: "b" });

    await assert.rejects(
      () => status("photos"),
      /No snapshot yet[\s\S]*s3cab snapshot photos/,
    );
  });

  it("has nothing to upload when the latest backup holds every hash", async () => {
    await using dir = await mkTmpDir();
    await backedUpSet(dir.path);

    const report = await status("photos");

    assert.equal(report.backedUp, NAME);
    assert.equal(report.toUpload, 0);
  });

  it("counts content a delete removed as needing upload, as backup would (ADR-0064)", async () => {
    await using dir = await mkTmpDir();
    await backedUpSet(dir.path);
    recordDeleted(HELLO_HASH);

    const report = await status("photos");

    assert.equal(report.toUpload, 1);
  });

  it("trusts a deleted object a later backup stored again — presence wins", async () => {
    await using dir = await mkTmpDir();
    await backedUpSet(dir.path);
    recordDeleted(HELLO_HASH);
    sizeByUri[`s3://b/objects/${HELLO_HASH}`] = 5;

    const report = await status("photos");

    assert.equal(report.toUpload, 0);
  });
});
