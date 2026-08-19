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

      // The remote marker is claimed (owner = this machine) and the config is
      // published.
      const info = await readRemoteInfo(bucket, name);
      assert.equal(info?.owner, hostname());
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
          /already set up[\s\S]*reattach/.test(error.message) &&
          // The marker stores a full UTC instant, but the message shows a bare
          // date (ADR-0072/0030): "roughly when" is all this line needs, and a
          // millisecond timestamp mid-sentence is the jargon 0030 keeps out.
          /created \d{4}-\d{2}-\d{2}[,)]/.test(error.message),
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
      // creating machine and may need editing before a backup (ADR-0054) —
      // naming it from the marker's outgoing OWNER, read here against the live
      // provider rather than a mock.
      // A literal containment check, not a built RegExp: a hostname may legally
      // contain `.` and `-`, and an FQDN's dots would silently become wildcards.
      assert.ok(
        warnings
          .join("\n")
          .includes(`directory list came from '${hostname()}'`),
        "the nudge names this machine, read from the live marker's OWNER",
      );
      // The co-existence warning stays silent: both "machines" are temp homes on
      // this one host, so the marker's owner is us. Proving the suppression on
      // the real marker matters more than it looks — it is what keeps the
      // documented delete-then-reattach flow from warning about yourself.
      assert.doesNotMatch(warnings.join("\n"), /Reattaching doesn't stop/);

      // CREATED is preserved across the reattach (only OWNER is re-stamped).
      const after = await readRemoteInfo(bucket, name);
      assert.equal(after?.created, before?.created);
    } finally {
      await cleanupSetMarker(name);
    }
  });
});
