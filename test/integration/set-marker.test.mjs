import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  claimRemoteSet,
  listRemoteSets,
  pushSetConfig,
  readRemoteInfo,
  readSetConfig,
  writeRemoteInfo,
} from "../../src/lib/set-marker.mjs";
import { bucket, cleanupSetMarker } from "../helpers/integration.mjs";

// The remote `sets/<set>/` marker's S3 behaviour (ADR-0024), against a real
// bucket. Each test uses a unique set name so the shared bucket stays isolated,
// and deletes its marker files on teardown. The gate/harness lives in the shared
// integration helper.

describe("set marker (real bucket)", () => {
  it("claimRemoteSet is atomic: the first writer wins, the second loses", async () => {
    const name = `sm-claim-${Date.now()}`;
    try {
      const first = { owner: "machine-a", created: "2026-01-01T00:00" };
      const second = { owner: "machine-b", created: "2026-02-02T00:00" };

      assert.equal(await claimRemoteSet(bucket, name, first), true);
      assert.equal(await claimRemoteSet(bucket, name, second), false);

      // The losing claim did not overwrite the winner's marker.
      assert.deepEqual(await readRemoteInfo(bucket, name), first);
    } finally {
      await cleanupSetMarker(name);
    }
  });

  it("readRemoteInfo returns undefined for an unclaimed set", async () => {
    assert.equal(
      await readRemoteInfo(bucket, `sm-absent-${Date.now()}`),
      undefined,
    );
  });

  it("writeRemoteInfo re-stamps the marker (the reattach takeover)", async () => {
    const name = `sm-restamp-${Date.now()}`;
    try {
      await claimRemoteSet(bucket, name, {
        owner: "machine-a",
        created: "2026-01-01T00:00",
      });
      // Re-stamp OWNER, preserve CREATED (what reattach does).
      await writeRemoteInfo(bucket, name, {
        owner: "machine-b",
        created: "2026-01-01T00:00",
      });
      assert.deepEqual(await readRemoteInfo(bucket, name), {
        owner: "machine-b",
        created: "2026-01-01T00:00",
      });
    } finally {
      await cleanupSetMarker(name);
    }
  });

  it("pushSetConfig/readSetConfig round-trips dirs and an optional exclude", async () => {
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

      // Re-pushing the same set with no exclude DELETES the stale remote one
      // (mirror local), so reattach can't resurrect a removed exclude.txt.
      await pushSetConfig(bucket, withExclude, { dirs: ["C:\\Photos"] });
      assert.deepEqual(await readSetConfig(bucket, withExclude), {
        dirs: ["C:\\Photos"],
        exclude: undefined,
      });

      // No exclude pushed → exclude reads back as undefined.
      await pushSetConfig(bucket, noExclude, { dirs: ["C:\\Photos"] });
      assert.deepEqual(await readSetConfig(bucket, noExclude), {
        dirs: ["C:\\Photos"],
        exclude: undefined,
      });
    } finally {
      await cleanupSetMarker(withExclude);
      await cleanupSetMarker(noExclude);
    }
  });

  it("listRemoteSets surfaces a claimed set's name", async () => {
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
      await cleanupSetMarker(name);
    }
  });
});
