import assert from "node:assert/strict";
import { mkdirSync, realpathSync } from "node:fs";
import { mkdtempDisposable } from "node:fs/promises";
import { hostname } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { readRemoteInfo, readSetConfig } from "../lib/set-marker.mjs";
import { readSet, readSetExclude, starterExclude } from "../lib/sets.mjs";
import { setup } from "./setup.mjs";
import { useTempHome } from "../../test/helpers/temp-home.mjs";
import {
  bucket,
  cleanupSetMarker,
  skip,
} from "../../test/helpers/integration.mjs";

// setup's create / collision / inherit behaviour against a real bucket
// (docs/design/backup.md, ADR-0036). Each uses a unique set name so the shared
// bucket stays isolated, and deletes its `sets/<name>/` marker on teardown. The
// gate/harness lives in the shared integration helper.

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

describe("setup (real bucket)", { skip }, () => {
  it("create claims the name and publishes its config", async () => {
    await using dir = await mkTmpDir();
    useTempHome(dir.path);
    const name = `st-create-${Date.now()}`;
    const content = resolve(dir.path, "content");
    mkdirSync(content, { recursive: true });

    try {
      const set = await setup(name, [content], { bucket });
      assert.equal(set?.name, name);
      assert.equal(set?.bucket, bucket);
      assert.deepEqual(set?.dirs, [realpathSync.native(content)]);

      // The remote marker is claimed (owner = this machine) and the config is
      // published.
      const info = await readRemoteInfo(bucket, name);
      assert.equal(info?.owner, hostname());
      assert.match(String(info?.created), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
      const config = await readSetConfig(bucket, name);
      assert.deepEqual(config.dirs, [realpathSync.native(content)]);

      // A new set is born with the starter exclude file, locally and in the
      // published remote config (seeded before the push, so the two match).
      assert.equal(readSetExclude(name), starterExclude);
      assert.equal(config.exclude, starterExclude);
    } finally {
      await cleanupSetMarker(name);
    }
  });

  it("refuses a name already claimed (by another machine), pointing at --inherit", async () => {
    await using dir = await mkTmpDir();
    const name = `st-collide-${Date.now()}`;
    const content = resolve(dir.path, "content");
    mkdirSync(content, { recursive: true });

    try {
      // Machine A claims the name.
      useTempHome(join(dir.path, "a"));
      await setup(name, [content], { bucket });

      // Machine B (a fresh local home, same bucket) is refused.
      useTempHome(join(dir.path, "b"));
      await assert.rejects(
        () => setup(name, [content], { bucket }),
        /already set up[\s\S]*--inherit/,
      );
    } finally {
      await cleanupSetMarker(name);
    }
  });

  it("inherit recreates the set locally from the remote, preserving CREATED", async () => {
    await using dir = await mkTmpDir();
    const name = `st-inherit-${Date.now()}`;
    const content = resolve(dir.path, "content");
    mkdirSync(content, { recursive: true });

    try {
      // Machine A creates it.
      useTempHome(join(dir.path, "a"));
      await setup(name, [content], { bucket });
      const before = await readRemoteInfo(bucket, name);

      // Machine B inherits — no directories, recreated from the remote config.
      useTempHome(join(dir.path, "b"));
      const inherited = await setup(name, [], { bucket, inherit: true });
      assert.equal(inherited?.bucket, bucket);
      assert.deepEqual(inherited?.dirs, [realpathSync.native(content)]);
      // The local set really exists on machine B.
      assert.deepEqual(readSet(name).dirs, [realpathSync.native(content)]);
      // Machine A's starter exclude came over with the remote config.
      assert.equal(readSetExclude(name), starterExclude);

      // CREATED is preserved across the inherit (only OWNER is re-stamped).
      const after = await readRemoteInfo(bucket, name);
      assert.equal(after?.created, before?.created);
    } finally {
      await cleanupSetMarker(name);
    }
  });

  it("update re-publishes changed directories to the remote", async () => {
    await using dir = await mkTmpDir();
    useTempHome(dir.path);
    const name = `st-update-${Date.now()}`;
    const c1 = resolve(dir.path, "one");
    const c2 = resolve(dir.path, "two");
    mkdirSync(c1, { recursive: true });
    mkdirSync(c2, { recursive: true });

    try {
      await setup(name, [c1], { bucket });
      await setup(name, [c1, c2], { bucket }); // update: add a directory

      const config = await readSetConfig(bucket, name);
      assert.deepEqual(config.dirs, [
        realpathSync.native(c1),
        realpathSync.native(c2),
      ]);
    } finally {
      await cleanupSetMarker(name);
    }
  });
});
