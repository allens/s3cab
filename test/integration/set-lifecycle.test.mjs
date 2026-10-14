import assert from "node:assert/strict";
import { mkdirSync, realpathSync } from "node:fs";
import { mkdtempDisposable } from "node:fs/promises";
import { hostname, userInfo } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import {
  holding,
  readRemoteInfo,
  readSetConfig,
} from "../../src/lib/set-marker.mjs";
import {
  readSet,
  readSetExclude,
  starterExclude,
} from "../../src/lib/sets.mjs";
import { reattach } from "../../src/commands/reattach.mjs";
import { setup } from "../../src/commands/setup.mjs";
import { takeover } from "../../src/commands/takeover.mjs";
import { useTempHome } from "../helpers/temp-home.mjs";
import { bucket, cleanupSetMarker } from "../helpers/integration.mjs";

// setup's create/collision behaviour, reattach's read-only attach and takeover's
// claim against a real bucket (ADR-0108). Each uses a unique set name so the
// shared bucket stays isolated, and deletes its marker and config on teardown.
// The gate/harness lives in the shared integration helper.

const mkTmpDir = async () => mkdtempDisposable(join("test", ".tmp"));

/** This user on this machine, built here rather than by the helper under test. */
const me = `${userInfo().username}@${hostname()}`;

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
    // Enrolled in a *non-canonical* spelling of the same directory, because
    // `dirs.txt` is hand-edited and a typed `d:\photos` is ordinary input. What
    // gets stored must be the OS's canonical form (`resolveDirectories`), or the
    // set is keyed on a string the walk will never yield — every path-keyed
    // lookup downstream compares strings, not inodes. On win32 the drive letter
    // is the available difference; elsewhere the input is already canonical and
    // this is simply the same assertion as before. `realpathSync.native` is the
    // only canonicalizer that fixes the case — plain `realpathSync` returns the
    // drive letter as given (measured 2026-08-18).
    const enrolled =
      process.platform === "win32"
        ? content.charAt(0).toLowerCase() + content.slice(1)
        : content;

    try {
      const set = await setup([enrolled], { set: name, bucket });
      assert.equal(set?.name, name);
      assert.equal(set?.bucket, bucket);
      assert.deepEqual(set?.dirs, [realpathSync.native(content)]);

      // The remote marker is claimed (owner = this user@machine), this machine
      // keeps the pair it claimed with, and the config is published.
      const info = await readRemoteInfo(bucket, name);
      assert.equal(info?.owner, me);
      assert.equal(info?.claimed, info?.created);
      const { held } = await holding(bucket, name, readSet(name).claimPath);
      assert.equal(held, true);
      // A full UTC instant (ADR-0072), not the naive local minute this used to
      // write — it is a record, never typed and never sorted, so qualifying it
      // costs nothing. `collisionError` renders it down to a date for humans.
      assert.match(
        String(info?.created),
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
      );
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
        (error) =>
          error instanceof Error &&
          /already exists[\s\S]*reattach/.test(error.message) &&
          // The marker stores a full UTC instant, but the message shows a bare
          // date (ADR-0072/0030): "roughly when" is all this line needs, and a
          // millisecond timestamp mid-sentence is the jargon 0030 keeps out.
          /created \d{4}-\d{2}-\d{2}[,)]/.test(error.message),
      );
    } finally {
      await cleanupSetMarker(name);
    }
  });

  it("reattach attaches the set read-only, leaving the marker alone", async () => {
    await using dir = await mkTmpDir();
    const name = `st-reattach-${Date.now()}`;
    const content = resolve(dir.path, "content");
    mkdirSync(content, { recursive: true });

    try {
      // Machine A creates it.
      useTempHome(join(dir.path, "a"));
      await setup([content], { set: name, bucket });
      const before = await readRemoteInfo(bucket, name);

      // Machine B attaches it: no config pulled, no claim.
      useTempHome(join(dir.path, "b"));
      const warn = mock.method(console, "warn", () => {});
      const reattached = await reattach(name, [], { bucket });
      warn.mock.restore();
      assert.equal(reattached.bucket, bucket);
      assert.equal(reattached.held, false);
      assert.equal(reattached.holder, me);
      assert.deepEqual(readSet(name).dirs, []);
      assert.deepEqual(await readRemoteInfo(bucket, name), before);
    } finally {
      await cleanupSetMarker(name);
    }
  });

  it("takeover claims the set, pulling its config and keeping CREATED", async () => {
    await using dir = await mkTmpDir();
    const name = `st-takeover-${Date.now()}`;
    const content = resolve(dir.path, "content");
    mkdirSync(content, { recursive: true });

    try {
      // Machine A creates it.
      useTempHome(join(dir.path, "a"));
      await setup([content], { set: name, bucket });
      const claimA = readSet(name).claimPath;
      const before = await readRemoteInfo(bucket, name);
      // Both "machines" are this user on this host, so the takeover's OWNER is
      // A's too; only CLAIMED tells them apart, and it has whole seconds.
      await sleep(1_100);

      // Machine B takes it over.
      useTempHome(join(dir.path, "b"));
      /** @type {string[]} */
      const warnings = [];
      const warn = mock.method(console, "warn", (/** @type {string} */ m) =>
        warnings.push(m),
      );
      const taken = await takeover(name, [], { bucket });
      warn.mock.restore();
      assert.deepEqual(taken.dirs, [realpathSync.native(content)]);
      assert.equal(readSetExclude(name), starterExclude);
      // A literal containment check, not a built RegExp: a user or hostname may
      // legally contain `.` and `-`, and an FQDN's dots would silently become wildcards.
      assert.ok(
        warnings.join("\n").includes(`directory list came from ${me}`),
        "the nudge names the previous holder, read from the live marker",
      );

      const after = await readRemoteInfo(bucket, name);
      assert.equal(after?.owner, me);
      assert.equal(after?.created, before?.created);
      assert.notEqual(after?.claimed, before?.claimed);
      const { held: heldByB } = await holding(bucket, name, taken.claimPath);
      assert.equal(heldByB, true);

      // Machine A no longer holds it.
      useTempHome(join(dir.path, "a"));
      const { held: heldByA } = await holding(bucket, name, claimA);
      assert.equal(heldByA, false);
    } finally {
      await cleanupSetMarker(name);
    }
  });
});
