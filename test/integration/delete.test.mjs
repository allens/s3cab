import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtempDisposable } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { backup } from "../../src/commands/backup.mjs";
import { deletePaths } from "../../src/commands/delete.mjs";
import { restore } from "../../src/commands/restore.mjs";
import { setup } from "../../src/commands/setup.mjs";
import { verify } from "../../src/commands/verify.mjs";
import { writeDeletionRecord } from "../../src/lib/deletion-record.mjs";
import { remoteSnapshotsPrefix } from "../../src/lib/remote.mjs";
import { deleteObject, getText, objectExists } from "../../src/lib/s3.mjs";
import { readSnapshot } from "../../src/lib/snapshot-file.mjs";
import { uploadSnapshot } from "../../src/lib/upload.mjs";
import { bucket, cleanupSetMarker } from "../helpers/integration.mjs";
import { useTempHome } from "../helpers/temp-home.mjs";
import { writeSnapshot } from "../helpers/write-snapshot.mjs";

// The path-scoped `delete` lifecycle against a real bucket (ADR-0064): backup →
// delete → the record in the bucket → verify's expected/unexplained partition →
// restore's graceful skip → backup's record subtraction re-uploading the
// content. The pure arithmetic is unit-tested exhaustively (lib/delete.test.mjs);
// what only a real bucket proves is the record's write/read reality — the
// conditional PUT against the live provider, the record round-tripping through
// real LIST/GET, and the object deletions actually landing. The shared test
// bucket serves other suites concurrently, so assertions stay scoped to this
// run's set and objects — never to bucket-wide exit codes or counts.

const mkTmpDir = async () => mkdtempDisposable(join("test", ".tmp"));

/** @type {NodeJS.ProcessEnv} */
let savedEnv;
/** @type {number | string | null | undefined} */
let savedExitCode;
beforeEach(() => {
  savedEnv = { ...process.env };
  savedExitCode = process.exitCode;
});
afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in savedEnv)) {
      delete process.env[key];
    }
  }
  Object.assign(process.env, savedEnv);
  process.exitCode = savedExitCode; // never leak a set exit code to the runner
});

describe("delete → record → verify/restore/backup (real bucket)", () => {
  it("removes exclusively-referenced content, records it, and every consumer honours the record", async () => {
    await using dir = await mkTmpDir();
    useTempHome(dir.path);
    const setName = `dl${Date.now()}`;

    // The fixture separates the three fates one delete can hand out:
    //  - keep.txt        — outside the named path: untouched
    //  - raw/one.txt,two.txt — exclusively under it: deleted
    //  - raw/copy-of-keep.txt — under it, but duplicating keep.txt's content:
    //    the object is shared with a path outside the selection → survives.
    const srcDir = join(dir.path, "Media");
    mkdirSync(join(srcDir, "raw"), { recursive: true });
    writeFileSync(join(srcDir, "keep.txt"), `keep ${setName}`);
    writeFileSync(join(srcDir, "raw", "one.txt"), `one ${setName}`);
    writeFileSync(join(srcDir, "raw", "two.txt"), `two ${setName}`);
    writeFileSync(join(srcDir, "raw", "copy-of-keep.txt"), `keep ${setName}`);

    const set = await setup([srcDir], { set: setName, bucket });
    assert.ok(set);
    const { snapshot: first } = await backup(setName);

    // Resolve paths as the snapshot recorded them (realpath may differ from the
    // joins above) — the operand handed to delete must be a recorded path.
    const { entries } = await readSnapshot(set.snapshotsDir, first);
    const paths = [...entries.keys()];
    const recorded = (/** @type {string} */ tail) => {
      const path = paths.find((p) => p.endsWith(tail));
      assert.ok(path, `snapshot recorded ${tail}`);
      return path;
    };
    const rawDir = dirname(recorded(join("raw", "one.txt")));
    const doomedHashes = [
      /** @type {string} */ (
        entries.get(recorded(join("raw", "one.txt")))?.hash
      ),
      /** @type {string} */ (
        entries.get(recorded(join("raw", "two.txt")))?.hash
      ),
    ];
    const keepHash = /** @type {string} */ (
      entries.get(recorded("keep.txt"))?.hash
    );
    const allHashes = [...new Set([...entries.values()].map((p) => p.hash))];
    /** @type {string[]} */
    const snapshots = [first];
    /** @type {string | undefined} */
    let recordUri;

    try {
      // ── delete ──────────────────────────────────────────────────────────
      const result = await deletePaths([rawDir], { bucket, force: true });
      assert.equal(result.deleted, true);
      assert.equal(result.deletedObjects, 2, "the two exclusive objects");
      assert.equal(result.survivors, 1, "the shared-content file survives");
      recordUri = result.record;
      assert.ok(recordUri, "a record was written");
      assert.ok(recordUri.includes("/deletions/"), "under the record prefix");
      const uri = recordUri; // narrowed for the closures below

      // The objects really left the bucket — and only the right ones.
      for (const hash of doomedHashes) {
        assert.equal(
          await objectExists(`s3://${bucket}/objects/${hash}`),
          false,
        );
      }
      assert.equal(
        await objectExists(`s3://${bucket}/objects/${keepHash}`),
        true,
      );

      // ── verify: expected, not damage ────────────────────────────────────
      const verified = await verify(bucket);
      const report = verified.sets.find((s) => s.set === setName);
      assert.ok(report, "verify reports our set");
      assert.deepEqual(report.problems, [], "no unexplained findings");
      assert.deepEqual(
        report.expectedMissing.map((e) => e.path).sort(),
        [
          recorded(join("raw", "one.txt")),
          recorded(join("raw", "two.txt")),
        ].sort(),
        "both deleted files reported as expected-missing",
      );

      // ── restore: graceful, dated skip ───────────────────────────────────
      process.exitCode = savedExitCode; // isolate restore's exit contribution
      const outDir = join(dir.path, "restored");
      const restored = await restore([], { set: setName, output: outDir });
      assert.deepEqual(
        restored.missing,
        [],
        "nothing is *unexplained* missing",
      );
      assert.equal(restored.deleted.length, 2, "the deleted pair is skipped");
      for (const { deletedOn } of restored.deleted) {
        assert.ok(uri.includes(deletedOn), "skip cites the record's date");
      }
      assert.equal(restored.restored.length, entries.size - 2);
      assert.equal(
        process.exitCode,
        savedExitCode,
        "deliberate ≠ fault: exit 0",
      );

      // ── backup: the record punches through the baseline ─────────────────
      // The doomed files still exist locally, and the first snapshot (a trusted
      // baseline — it still exists remotely) claims their objects are stored.
      // Without the subtraction the next backup would publish a snapshot
      // referencing missing objects; with it, exactly the deleted content
      // re-enters the plan. Driven through `uploadSnapshot` with a crafted
      // later snapshot name (a real `backup` here would collide with the
      // first's same-minute name), which is the same engine path `backup`
      // composes — and lets the assertion be exact: 2 candidates, not ≥.
      const second = "2099-01-01T0000";
      await writeSnapshot(set.snapshotsDir, second, [...entries.keys()]);
      snapshots.push(second);
      const uploaded = await uploadSnapshot({
        bucket,
        set: setName,
        snapshotDir: set.snapshotsDir,
        name: second,
        since: first,
      });
      assert.equal(
        uploaded.candidates,
        2,
        "exactly the deleted objects re-entered the plan",
      );
      for (const hash of doomedHashes) {
        assert.equal(
          await objectExists(`s3://${bucket}/objects/${hash}`),
          true,
          "deleted content re-uploaded on the next backup",
        );
      }
    } finally {
      for (const hash of allHashes) {
        await deleteObject(`s3://${bucket}/objects/${hash}`).catch(() => {});
      }
      for (const snapshot of snapshots) {
        await deleteObject(
          `s3://${bucket}/${remoteSnapshotsPrefix(setName)}${snapshot}.tsv.zst`,
        ).catch(() => {});
      }
      if (recordUri) {
        await deleteObject(recordUri).catch(() => {});
      }
      await cleanupSetMarker(setName);
    }
  });

  it("a same-minute record takes the next name against the live provider", async () => {
    // Both halves need a real provider (docs/design/s3-provider-compatibility.md):
    // that `IfNoneMatch: "*"` actually refuses the taken key — a mock can only
    // assert we asked — and that the retry then lands, so two deletes in one
    // minute are both recorded (ADR-0087). A fixed record name makes the
    // collision deterministic instead of racing the wall clock.
    const name = `0000-01-01T0000`;
    /** @type {string[]} */
    const written = [];
    try {
      written.push(await writeDeletionRecord(bucket, name, "# first\n"));
      written.push(await writeDeletionRecord(bucket, name, "# second\n"));
      written.push(await writeDeletionRecord(bucket, name, "# third\n"));
      assert.deepEqual(written, [
        `s3://${bucket}/deletions/${name}.tsv`,
        `s3://${bucket}/deletions/${name}-2.tsv`,
        `s3://${bucket}/deletions/${name}-3.tsv`,
      ]);

      // The conditional PUT is still what makes that true: the first record's
      // bytes are untouched, so no retry overwrote a record of a destructive act.
      const first = await getText(`s3://${bucket}/deletions/${name}.tsv`);
      assert.equal(first, "# first\n");
    } finally {
      for (const uri of written) {
        await deleteObject(uri).catch(() => {});
      }
    }
  });
});
