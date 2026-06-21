import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { deleteObject } from "./s3.mjs";
import {
  claimRemoteSet,
  listRemoteSets,
  pushSetConfig,
  readRemoteInfo,
  readSetConfig,
  remoteSetPrefix,
  writeRemoteInfo,
} from "./set-marker.mjs";

// The remote `sets/<set>/` marker (ADR-0024). The pure prefix is covered without
// a bucket; the S3 ops are gated on S3CAB_TEST_BUCKET (+ ambient AWS
// credentials) like the other S3 suites, and skipped with a message otherwise.
// Each test uses a unique set name so the shared bucket stays isolated, and
// deletes its marker files on teardown.

const TEST_BUCKET = process.env.S3CAB_TEST_BUCKET;
const skip = TEST_BUCKET
  ? false
  : "set S3CAB_TEST_BUCKET (and AWS credentials) to run S3 integration tests";

/**
 * @param {string} bucket
 * @param {string} name
 */
async function cleanupSet(bucket, name) {
  for (const file of ["info", "dirs.txt", "exclude.txt"]) {
    await deleteObject(`s3://${bucket}/${remoteSetPrefix(name)}${file}`).catch(
      () => {},
    );
  }
}

describe("remoteSetPrefix", () => {
  it("places a set's marker under sets/<set>/", () => {
    assert.equal(remoteSetPrefix("photos"), "sets/photos/");
  });
});

describe("set marker (real bucket)", { skip }, () => {
  it("claimRemoteSet is atomic: the first writer wins, the second loses", async () => {
    const bucket = /** @type {string} */ (TEST_BUCKET);
    const name = `sm-claim-${Date.now()}`;
    try {
      const first = { owner: "machine-a", created: "2026-01-01T00:00" };
      const second = { owner: "machine-b", created: "2026-02-02T00:00" };

      assert.equal(await claimRemoteSet(bucket, name, first), true);
      assert.equal(await claimRemoteSet(bucket, name, second), false);

      // The losing claim did not overwrite the winner's marker.
      assert.deepEqual(await readRemoteInfo(bucket, name), first);
    } finally {
      await cleanupSet(bucket, name);
    }
  });

  it("readRemoteInfo returns undefined for an unclaimed set", async () => {
    const bucket = /** @type {string} */ (TEST_BUCKET);
    assert.equal(
      await readRemoteInfo(bucket, `sm-absent-${Date.now()}`),
      undefined,
    );
  });

  it("writeRemoteInfo re-stamps the marker (the --inherit takeover)", async () => {
    const bucket = /** @type {string} */ (TEST_BUCKET);
    const name = `sm-restamp-${Date.now()}`;
    try {
      await claimRemoteSet(bucket, name, {
        owner: "machine-a",
        created: "2026-01-01T00:00",
      });
      // Re-stamp OWNER, preserve CREATED (what --inherit does).
      await writeRemoteInfo(bucket, name, {
        owner: "machine-b",
        created: "2026-01-01T00:00",
      });
      assert.deepEqual(await readRemoteInfo(bucket, name), {
        owner: "machine-b",
        created: "2026-01-01T00:00",
      });
    } finally {
      await cleanupSet(bucket, name);
    }
  });

  it("pushSetConfig/readSetConfig round-trips dirs and an optional exclude", async () => {
    const bucket = /** @type {string} */ (TEST_BUCKET);
    const withExclude = `sm-cfg-x-${Date.now()}`;
    const noExclude = `sm-cfg-n-${Date.now()}`;
    try {
      await pushSetConfig(bucket, withExclude, {
        dirs: ["C:\\Photos", "D:\\Pics"],
        exclude: "*.tmp\nnode_modules/\n",
      });
      assert.deepEqual(await readSetConfig(bucket, withExclude), {
        dirs: ["C:\\Photos", "D:\\Pics"],
        exclude: "*.tmp\nnode_modules/\n",
      });

      // No exclude pushed → exclude reads back as undefined.
      await pushSetConfig(bucket, noExclude, { dirs: ["C:\\Photos"] });
      assert.deepEqual(await readSetConfig(bucket, noExclude), {
        dirs: ["C:\\Photos"],
        exclude: undefined,
      });
    } finally {
      await cleanupSet(bucket, withExclude);
      await cleanupSet(bucket, noExclude);
    }
  });

  it("listRemoteSets surfaces a claimed set's name", async () => {
    const bucket = /** @type {string} */ (TEST_BUCKET);
    const name = `sm-list-${Date.now()}`;
    try {
      await claimRemoteSet(bucket, name, {
        owner: "machine-a",
        created: "2026-01-01T00:00",
      });
      const found = await listRemoteSets(bucket);
      assert.ok(
        found.includes(name),
        `expected ${name} among ${found.join(", ")}`,
      );
    } finally {
      await cleanupSet(bucket, name);
    }
  });
});
