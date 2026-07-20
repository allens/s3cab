import assert from "node:assert/strict";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { mkdtempDisposable } from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { backup } from "../../src/commands/backup.mjs";
import { forget } from "../../src/commands/forget.mjs";
import { setup } from "../../src/commands/setup.mjs";
import { deleteObject } from "../../src/lib/s3.mjs";
import { remoteSnapshotsPrefix } from "../../src/lib/remote.mjs";
import { readSet } from "../../src/lib/sets.mjs";
import { readSnapshot } from "../../src/lib/snapshot-file.mjs";
import { bucket, cleanupSetMarker } from "../helpers/integration.mjs";
import { useTempHome } from "../helpers/temp-home.mjs";

// `forget --force` against a real bucket (docs/design/snapshot-deletion.md): the
// destructive path a headless run takes, deleting the snapshot and filing the
// "check skipped" audit record.
//
// The unrestorable *check* is deliberately NOT integration-tested through `forget`:
// under ADR-0064's destructive-command pattern the only check-running path is
// interactive (a non-interactive run needs `--force`, which skips the check and the
// scan together — they travel), so there is no headless way to drive it here. The
// coverage that would have justified a real bucket is not lost: the check's pure
// computation is unit-tested in src/lib/unrestorable.test.mjs, and its real read
// path — `referencedObjects` reading and decompressing every snapshot, the live
// stream-teardown the #171 class of bug lives in — is exercised against the bucket
// by `delete`'s integration test, whose `--force` skips only the prompt and keeps
// the scan (unlike forget's).

const mkTmpDir = async () => mkdtempDisposable(join("test", ".tmp"));

/**
 * The hashes this test's own snapshots reference, read from the set's *local*
 * snapshot files — deliberately not a `s3://<bucket>/objects/` LIST. The test
 * bucket is shared with concurrent runs, so a bucket-wide list would sweep other
 * suites' objects into this one's teardown and delete them.
 * @param {string} set - The set name
 * @param {string[]} names - Its snapshot names
 * @returns {Promise<string[]>}
 */
async function hashesOf(set, names) {
  const { snapshotsDir } = readSet(set);
  /** @type {Set<string>} */
  const hashes = new Set();
  for (const name of names) {
    const { entries } = await readSnapshot(snapshotsDir, name);
    for (const { hash } of entries.values()) {
      hashes.add(hash);
    }
  }
  return [...hashes];
}

/** @type {NodeJS.ProcessEnv} */
let savedEnv;
const realLog = console.log;
/** @type {string[]} */
let stdout = [];

beforeEach(() => {
  savedEnv = { ...process.env };
  stdout = [];
  console.log = (/** @type {unknown[]} */ ...args) =>
    stdout.push(args.join(" "));
});
afterEach(() => {
  console.log = realLog;
  for (const key of Object.keys(process.env)) {
    if (!(key in savedEnv)) {
      delete process.env[key];
    }
  }
  Object.assign(process.env, savedEnv);
});

describe("forget --set (real bucket)", () => {
  it("--force deletes without scanning, but still files a record", async () => {
    await using dir = await mkTmpDir();
    const home = useTempHome(dir.path);
    const set = `orph-f-${Date.now()}`;

    const content = resolve(dir.path, "content");
    mkdirSync(content, { recursive: true });
    writeFileSync(join(content, "a.txt"), `force ${set}`);

    /** @type {string[]} */
    const hashes = [];
    /** @type {string | undefined} */
    let name;
    try {
      await setup([content], { set, bucket });
      const done = await backup(set);
      name = done.snapshot;

      hashes.push(...(await hashesOf(set, [name])));

      const { dir: setDir } = readSet(set);
      const result = await forget([name], { set, force: true });

      assert.equal(result.forgotten, true);
      assert.deepEqual(stdout, [], "--force prints no preview");
      assert.throws(
        () =>
          readFileSync(
            join(home, ".s3cab", "forget-unrestorable-preview.txt"),
            "utf8",
          ),
        "--force writes no preview",
      );

      // The record still lands, and is honest that the analysis is missing.
      const records = readdirSync(setDir).filter((f) =>
        f.startsWith("forget-unrestorable-"),
      );
      assert.equal(records.length, 1);
      assert.match(
        readFileSync(join(setDir, records[0] ?? ""), "utf8"),
        /no unrestorable check \(--force\)/,
      );
      name = undefined; // already deleted; nothing to clean up
    } finally {
      if (name) {
        await deleteObject(
          `s3://${bucket}/${remoteSnapshotsPrefix(set)}${name}.tsv.zst`,
        );
      }
      for (const hash of hashes) {
        await deleteObject(`s3://${bucket}/objects/${hash}`);
      }
      await cleanupSetMarker(set);
    }
  });
});
