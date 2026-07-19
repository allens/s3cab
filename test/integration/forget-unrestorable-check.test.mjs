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
import { uploadSnapshot } from "../../src/lib/upload.mjs";
import { bucket, cleanupSetMarker } from "../helpers/integration.mjs";
import { useTempHome } from "../helpers/temp-home.mjs";
import { writeSnapshot } from "../helpers/write-snapshot.mjs";

// `forget`'s unrestorable check against a real bucket (docs/design/snapshot-deletion.md).
// The *computation* is unit-tested pure in src/lib/unrestorable.test.mjs; what needs a
// real bucket is the read path it sits on — the check reads and decompresses every
// snapshot in the bucket via `referencedObjects`, and CLAUDE.md is explicit that
// mocked S3 bodies can't exercise real stream teardown (a unit-green path that
// aborts a live GetObject is the failure mode this tier exists to catch, #171).
//
// So this drives the whole command: two seeded snapshots through the real upload
// path, then a real forget, asserting on both files it leaves behind — the
// transient preview and the kept audit record.

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
/** @type {boolean | undefined} */
let savedTTY;
const stdin = /** @type {{ isTTY?: boolean }} */ (process.stdin);
const realLog = console.log;
/** @type {string[]} */
let stdout = [];

beforeEach(() => {
  savedEnv = { ...process.env };
  savedTTY = stdin.isTTY;
  // Non-interactive: the check still runs and still writes its report, but no
  // prompt blocks the suite.
  stdin.isTTY = false;
  stdout = [];
  console.log = (/** @type {unknown[]} */ ...args) =>
    stdout.push(args.join(" "));
});
afterEach(() => {
  console.log = realLog;
  stdin.isTTY = savedTTY;
  for (const key of Object.keys(process.env)) {
    if (!(key in savedEnv)) {
      delete process.env[key];
    }
  }
  Object.assign(process.env, savedEnv);
});

describe("forget --set (unrestorable check, real bucket)", () => {
  it("reads every snapshot in the bucket and reports what the removal would lose", async () => {
    await using dir = await mkTmpDir();
    const home = useTempHome(dir.path);
    const set = `orph-${Date.now()}`;

    const content = resolve(dir.path, "content");
    mkdirSync(content, { recursive: true });
    // `keep.txt` lives in both snapshots; `drop.txt` only in the first. Deleting
    // the first must orphan `drop.txt` alone — `keep.txt` is still referenced.
    const keep = join(content, "keep.txt");
    const drop = join(content, "drop.txt");
    writeFileSync(keep, `keep ${set}`);
    writeFileSync(drop, `drop ${set}`);

    // Two snapshots with explicit names, seeded rather than taken by `backup`:
    // snapshot names are minute-granular and a second one in the same minute is
    // refused, so back-to-back real backups can't produce the two-snapshot
    // history this test needs. The upload path is still the real one.
    const firstName = "2025-05-01T0800";
    const secondName = "2025-05-01T0900";
    const snapshots = [firstName, secondName];
    /** @type {string[]} */
    const hashes = [];
    try {
      await setup([content], { set, bucket });
      const { snapshotsDir } = readSet(set);

      await writeSnapshot(snapshotsDir, firstName, [keep, drop]);
      await uploadSnapshot({
        bucket,
        set,
        snapshotDir: snapshotsDir,
        name: firstName,
      });
      await writeSnapshot(snapshotsDir, secondName, [keep]);
      await uploadSnapshot({
        bucket,
        set,
        snapshotDir: snapshotsDir,
        name: secondName,
      });

      hashes.push(...(await hashesOf(set, snapshots)));

      // The real run: reads and decompresses every snapshot in the bucket.
      const result = await forget([firstName], { set });
      assert.equal(result.forgotten, true);

      // The preview, in the s3cab root, overwritten each run.
      const preview = join(home, ".s3cab", "forget-unrestorable-preview.txt");
      const body = readFileSync(preview, "utf8");
      const rows = body.split("\n").filter((l) => l && !l.startsWith("#"));
      assert.equal(
        rows.length,
        1,
        `one unrestorable file, got: ${rows.join(" | ")}`,
      );
      assert.match(rows[0] ?? "", /drop\.txt$/);
      assert.doesNotMatch(body, /keep\.txt/);

      // The audit record, kept in the set's own directory now the removal landed.
      const { dir: setDir } = readSet(set);
      const records = readdirSync(setDir).filter((f) =>
        f.startsWith("forget-unrestorable-"),
      );
      assert.equal(records.length, 1, "one deletion, one record");
      assert.match(
        readFileSync(join(setDir, records[0] ?? ""), "utf8"),
        /drop\.txt/,
      );

      // The summary names the preview, on its own indented last line.
      const summary = stdout.join("\n");
      assert.match(summary, /Unrestorable preview/);
      assert.equal(summary.split("\n").at(-1), `  ${preview}`);
    } finally {
      for (const name of snapshots) {
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
