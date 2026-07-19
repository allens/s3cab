import assert from "node:assert/strict";
import { mkdirSync, realpathSync } from "node:fs";
import { mkdtempDisposable } from "node:fs/promises";
import { hostname } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import { readRemoteInfo, readSetConfig } from "../../src/lib/set-marker.mjs";
import {
  readSet,
  readSetExclude,
  starterExclude,
} from "../../src/lib/sets.mjs";
import { reattach } from "../../src/commands/reattach.mjs";
import { setup } from "../../src/commands/setup.mjs";
import { useTempHome } from "../helpers/temp-home.mjs";
import { bucket, cleanupSetMarker } from "../helpers/integration.mjs";

// setup's create/collision behaviour and reattach's adopt behaviour against a
// real bucket (docs/design/backup.md, ADR-0036, ADR-0053). Each uses a unique set
// name so the shared bucket stays isolated, and deletes its `sets/<name>/` marker
// on teardown. The gate/harness lives in the shared integration helper.

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

describe("setup (real bucket)", () => {
  it("create claims the name and publishes its config", async () => {
    await using dir = await mkTmpDir();
    useTempHome(dir.path);
    const name = `st-create-${Date.now()}`;
    const content = resolve(dir.path, "content");
    mkdirSync(content, { recursive: true });

    try {
      const set = await setup([content], { set: name, bucket });
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

  it("refuses a name already claimed (by another machine), pointing at reattach", async () => {
    await using dir = await mkTmpDir();
    const name = `st-collide-${Date.now()}`;
    const content = resolve(dir.path, "content");
    mkdirSync(content, { recursive: true });

    try {
      // Machine A claims the name.
      useTempHome(join(dir.path, "a"));
      await setup([content], { set: name, bucket });

      // Machine B (a fresh local home, same bucket) is refused.
      useTempHome(join(dir.path, "b"));
      await assert.rejects(
        () => setup([content], { set: name, bucket }),
        /already set up[\s\S]*reattach/,
      );
    } finally {
      await cleanupSetMarker(name);
    }
  });

  it("reattach recreates the set locally from the remote, preserving CREATED", async () => {
    await using dir = await mkTmpDir();
    const name = `st-reattach-${Date.now()}`;
    const content = resolve(dir.path, "content");
    mkdirSync(content, { recursive: true });

    try {
      // Machine A creates it.
      useTempHome(join(dir.path, "a"));
      await setup([content], { set: name, bucket });
      const before = await readRemoteInfo(bucket, name);

      // Machine B reattaches — no directories, recreated from the remote config.
      useTempHome(join(dir.path, "b"));
      /** @type {string[]} */
      const warnings = [];
      const warn = mock.method(console, "warn", (/** @type {string} */ m) =>
        warnings.push(m),
      );
      const reattached = await reattach(name, [], { bucket });
      warn.mock.restore();
      assert.equal(reattached?.bucket, bucket);
      assert.deepEqual(reattached?.dirs, [realpathSync.native(content)]);
      // The local set really exists on machine B.
      assert.deepEqual(readSet(name).dirs, [realpathSync.native(content)]);
      // Machine A's starter exclude came over with the remote config.
      assert.equal(readSetExclude(name), starterExclude);
      // With directories present, reattach nudges that they came from the
      // creating machine and may need editing before a backup (ADR-0054).
      assert.match(
        warnings.join("\n"),
        /directory list came from the machine that created/,
      );

      // CREATED is preserved across the reattach (only OWNER is re-stamped).
      const after = await readRemoteInfo(bucket, name);
      assert.equal(after?.created, before?.created);
    } finally {
      await cleanupSetMarker(name);
    }
  });
});
