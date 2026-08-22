import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtempDisposable } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { backup } from "../../src/commands/backup.mjs";
import { deleteHashes } from "../../src/commands/delete.mjs";
import { restore } from "../../src/commands/restore.mjs";
import { setup } from "../../src/commands/setup.mjs";
import { verify } from "../../src/commands/verify.mjs";
import {
  compactDeletionRecords,
  formatDeletionRecord,
  parseDeletionRecord,
  readDeletionRecords,
  writeDeletionRecord,
} from "../../src/lib/deletion-record.mjs";
import { remoteSnapshotsPrefix } from "../../src/lib/remote.mjs";
import {
  deleteObject,
  getText,
  listObjects,
  objectExists,
} from "../../src/lib/s3.mjs";
import { readSnapshot } from "../../src/lib/snapshot-file.mjs";
import { uploadSnapshot } from "../../src/lib/upload.mjs";
import { bucket, cleanupSetMarker } from "../helpers/integration.mjs";
import { useTempHome } from "../helpers/temp-home.mjs";
import { writeSnapshot } from "../helpers/write-snapshot.mjs";

// The hash-operand `delete` lifecycle against a real bucket (ADR-0089/0090):
// backup → delete by hash → the record in the bucket → verify's
// expected/unexplained partition → restore's graceful skip → backup's record
// subtraction re-uploading the content. The pure pieces are unit-tested
// exhaustively (lib/delete.test.mjs, lib/deletion-record.test.mjs); what only a
// real bucket proves is the record's write/read reality — the slot allocator's
// conditional PUT against the live provider, the record round-tripping through
// real LIST/GET, and the object deletions actually landing. The shared test
// bucket serves other suites concurrently, so assertions stay scoped to this
// run's set and objects — never to bucket-wide exit codes or counts, and never
// to a hard-coded record index (a crashed earlier run may have left one).

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
  it("removes the named objects, records them, and every consumer honours the record", async () => {
    await using dir = await mkTmpDir();
    useTempHome(dir.path);
    const setName = `dl${Date.now()}`;

    // Three fates: keep.txt stays (its hash isn't named); one.txt and two.txt
    // are deleted by hash; copy-of-keep.txt shares keep.txt's content, so
    // naming only the doomed hashes leaves it restorable — the dedup awareness
    // that `find` surfaces now lives in the operand list, not in a scan.
    const srcDir = join(dir.path, "Media");
    mkdirSync(join(srcDir, "raw"), { recursive: true });
    writeFileSync(join(srcDir, "keep.txt"), `keep ${setName}`);
    writeFileSync(join(srcDir, "raw", "one.txt"), `one ${setName}`);
    writeFileSync(join(srcDir, "raw", "two.txt"), `two ${setName}`);
    writeFileSync(join(srcDir, "raw", "copy-of-keep.txt"), `keep ${setName}`);

    const set = await setup([srcDir], { set: setName, bucket });
    assert.ok(set);
    const { snapshot: first } = await backup(setName);

    const { entries } = await readSnapshot(set.snapshotsDir, first);
    const paths = [...entries.keys()];
    const recorded = (/** @type {string} */ tail) => {
      const path = paths.find((p) => p.endsWith(tail));
      assert.ok(path, `snapshot recorded ${tail}`);
      return path;
    };
    const doomed = [join("raw", "one.txt"), join("raw", "two.txt")].map(
      (tail) => {
        const entry = entries.get(recorded(tail));
        assert.ok(entry);
        return { hash: entry.hash, size: entry.size };
      },
    );
    const doomedHashes = doomed.map(({ hash }) => hash);
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
      const result = await deleteHashes(doomedHashes, { bucket, force: true });
      assert.equal(result.deleted, true);
      assert.equal(result.deletedObjects, 2);
      assert.deepEqual(result.missing, [], "both hashes were stored");
      recordUri = result.record;
      assert.ok(recordUri, "a record was written");
      assert.match(
        recordUri,
        new RegExp(`^s3://${bucket}/objects\\.deleted-[1-9][0-9]*\\.tsv$`),
        "root-level indexed record (ADR-0090)",
      );
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

      // ── the record itself, through a real GET ───────────────────────────
      const text = await getText(uri);
      assert.ok(text, "the record is readable");
      assert.match(text, /^#DELETED\t\t/, "the header names the format");
      assert.ok(text.endsWith("#END\n"), "complete — the bare trailer");
      const rows = parseDeletionRecord(text);
      assert.deepEqual(
        rows
          .map(({ hash, size }) => ({ hash, size }))
          .sort((a, b) => (a.hash < b.hash ? -1 : 1)),
        [...doomed].sort((a, b) => (a.hash < b.hash ? -1 : 1)),
        "rows carry the hashes with the preflight's true sizes",
      );
      const instant = rows[0]?.instant;
      assert.ok(instant);
      for (const row of rows) {
        assert.equal(row.instant, instant, "one run, one instant");
        assert.match(row.by, /.+@.+/, "user@machine survives compaction");
      }

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
      for (const e of report.expectedMissing) {
        assert.equal(e.deletedOn, instant, "dated by the record's row");
      }

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
        assert.equal(deletedOn, instant, "skip cites the record's instant");
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

  it("concurrent writers never lose a record, and compaction merges them, against the live provider", async () => {
    // Both halves need a real provider (docs/design/s3-provider-compatibility.md):
    // that `IfNoneMatch: "*"` actually refuses a taken index — a mock can only
    // assert we asked — and that the loser's walk upward then lands, so
    // concurrent deletes are all recorded (ADR-0090). Three simultaneous
    // writers maximize the same-index race the allocator exists for; whatever
    // the interleaving, three distinct files with untouched bytes is the proof
    // no conditional PUT was silently ignored.
    const T = "2099-01-01T00:00:00.000Z";
    const hashes = ["a", "b", "c"].map((c) => c.repeat(64));
    const contents = hashes.map((hash, i) =>
      formatDeletionRecord(T, [
        { hash, size: i + 1, instant: T, by: "it@integration" },
      ]),
    );
    try {
      // Start from a clean slate so the counts below are exact: sweep any
      // record file a crashed earlier run left behind (only this suite writes
      // them, and a finished run removes its own).
      for await (const { Key } of listObjects(
        `s3://${bucket}/objects.deleted-`,
      )) {
        if (Key) {
          await deleteObject(`s3://${bucket}/${Key}`).catch(() => {});
        }
      }

      const written = await Promise.all(
        contents.map((content) => writeDeletionRecord(bucket, content)),
      );
      assert.equal(new Set(written).size, 3, "three distinct indexes");
      for (const [i, uri] of written.entries()) {
        assert.equal(
          await getText(uri),
          contents[i],
          "every writer's bytes intact — no overwrite won a race",
        );
      }

      // ── cleanup's compaction over those real files ──────────────────────
      // Keep only the first hash (a snapshot still references it, as far as
      // compaction is told); the merge must land before the absorbed files go,
      // and the survivors' union must read back exactly the referenced row.
      const compacted = await compactDeletionRecords(
        bucket,
        new Set([hashes[0] ?? ""]),
        { instant: "2099-01-02T00:00:00.000Z" },
      );
      assert.equal(compacted.files, 3, "all three absorbed");
      assert.equal(compacted.trimmed, 2, "the two unreferenced rows dropped");
      for (const uri of written) {
        assert.equal(await objectExists(uri), false, "absorbed files deleted");
      }
      const after = await readDeletionRecords(bucket);
      assert.deepEqual(after.get(hashes[0] ?? ""), { deletedOn: T });
      assert.equal(after.has(hashes[1] ?? ""), false);
      assert.equal(after.has(hashes[2] ?? ""), false);
    } finally {
      // Remove every record file this test's writes or its compaction left —
      // records are the one root-level key, and only this suite writes them.
      for await (const { Key } of listObjects(
        `s3://${bucket}/objects.deleted-`,
      )) {
        if (Key) {
          await deleteObject(`s3://${bucket}/${Key}`).catch(() => {});
        }
      }
    }
  });
});
