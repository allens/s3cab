import assert from "node:assert/strict";
import {
  mkdirSync,
  realpathSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { mkdtempDisposable, readFile } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, it } from "node:test";
import { MINUTE_MS, VirtualClock, clockHolder } from "./harness/clock.mjs";
import { FakeS3, backendHolder } from "./harness/fake-s3.mjs";
import { checkStore } from "./harness/invariants.mjs";
import { RepoModel, sha256 } from "./harness/model.mjs";
import {
  backup,
  cleanup,
  forget,
  parseCompressedSnapshotStream,
  restore,
  snapshot,
  verify,
  writeSet,
} from "./harness/seam.mjs";

// The prior audits' findings (proposals/bugs.md, the 2026-08-12 durability
// audit; proposals/concurrency-and-locking.md §1) encoded as deterministic
// Tier 1 tests — this suite is how those hypotheses get sorted into real bugs
// and ruled-out worries. Each test names its source entry and asserts the
// behaviour observed **today**, with a TODO stating what the assertion flips
// to when the bug is fixed; a fix then fails here loudly and gets a
// deliberate decision.
//
// Not here: the C1 mid-transfer mutation and the backup-exit-0 entries live
// in model.hostile.test.mjs (they are hostile-tree cases); the
// versioning-never-checked entry (engine-robustness.md) needs a real
// versioned bucket and belongs to Tier 2 (see CAPABILITIES.md, "versioning").

const BUCKET = "model-bucket";
const DAY_MS = 24 * 60 * 60 * 1000;

/** @type {NodeJS.ProcessEnv} */
let savedEnv;
/** @type {number} */
let savedExitCode;
beforeEach(() => {
  savedEnv = { ...process.env };
  savedExitCode = /** @type {number} */ (process.exitCode ?? 0);
  clockHolder.current = new VirtualClock(Date.UTC(2026, 0, 5));
  backendHolder.current = new FakeS3();
});
afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in savedEnv)) {
      delete process.env[key];
    }
  }
  Object.assign(process.env, savedEnv);
  process.exitCode = savedExitCode;
});

/**
 * Point s3cab at a machine's own home under the test root.
 * @param {string} root
 * @param {string} machine - e.g. "mA"
 */
const useHome = (root, machine) => {
  process.env.S3CAB_HOME = join(root, machine, ".s3cab");
};

/**
 * A data directory with one file, registered as a set on the current home.
 * @param {string} root
 * @param {string} set
 * @param {string} dirName
 * @returns {string} the data directory (canonical)
 */
const makeSet = (root, set, dirName) => {
  mkdirSync(join(root, dirName), { recursive: true });
  const dir = realpathSync.native(join(root, dirName));
  writeSet(set, { dirs: [dir], bucket: BUCKET });
  return dir;
};

describe("prior-audit findings, encoded", () => {
  it("another machine's same-name snapshot vouches for a never-uploaded baseline (bugs.md: baseline HEAD by name — current behaviour)", async () => {
    await using dir = await mkdtempDisposable(join("test", ".tmp"));
    const root = dir.path;

    // Machine A snapshots offline at the shared minute — local only, nothing
    // uploaded, nothing records that it wasn't.
    useHome(root, "mA");
    const dataA = makeSet(root, "col", "dataA");
    writeFileSync(join(dataA, "a.txt"), "machine A content, never uploaded");
    await snapshot("col");

    // Machine B publishes a remote snapshot for the same set at the same
    // minute — same name, different document.
    useHome(root, "mB");
    const dataB = makeSet(root, "col", "dataB");
    writeFileSync(join(dataB, "b.txt"), "machine B content");
    await backup("col");

    // A's next backup: its own local snapshot is the baseline, the HEAD finds
    // B's remote snapshot by name, and A trusts its never-uploaded hashes as
    // stored.
    clockHolder.current.advance(MINUTE_MS);
    useHome(root, "mA");
    process.exitCode = 0;
    const result = await backup("col");

    // The backup claims clean success and uploads nothing…
    assert.equal(result.errors, 0);
    assert.equal(result.uploaded, 0, "the trusted baseline skips every object");
    assert.equal(process.exitCode, 0);

    // …but the manifest it published references objects that were never
    // uploaded. TODO(known bug, proposals/bugs.md: baseline HEAD matches on
    // name only): when the HEAD compares more than the name, this backup must
    // fall back to a store LIST and upload — flip to `deepEqual([])`.
    const model = new RepoModel(BUCKET, backendHolder.current);
    const violations = await checkStore(model);
    assert.ok(
      violations.some((v) => v.startsWith("dangling reference: col/")),
      `expected dangling references, got: ${violations.join("\n")}`,
    );

    // verify does catch it after the fact — silently-incomplete, not
    // silently-corrupt — but the backup above already said it succeeded.
    process.exitCode = 0;
    await verify(BUCKET);
    assert.equal(process.exitCode, 1);
  });

  it("a manifest PUT whose lost response is retried reports a false failure (bugs.md: self-412 — current behaviour)", async () => {
    await using dir = await mkdtempDisposable(join("test", ".tmp"));
    const root = dir.path;
    useHome(root, "mA");
    const data = makeSet(root, "lost", "data");
    writeFileSync(join(data, "f.txt"), "safely stored bytes");

    // The retry relay lives below the seam, so model its lost-response shape
    // at the seam: the manifest PUT lands, the re-sent request harvests a 412
    // from its own success, and the caller is told "already present".
    const fake = backendHolder.current;
    const realPutFile = fake.putFile.bind(fake);
    fake.putFile = async (path, uri, options) => {
      const wrote = await realPutFile(path, uri, options);
      return uri.includes("/snapshots/") ? false : wrote;
    };

    // TODO(known bug, proposals/bugs.md: retried manifest PUT): backup throws
    // the immutability error even though the backup is complete and correct.
    // A fix (e.g. distinguishing own-write from foreign snapshot) flips this
    // to `doesNotReject`.
    await assert.rejects(backup("lost"), /already backed up/);

    // The failure is false: the store holds a complete, consistent repository
    // and the snapshot restores byte-identically.
    const model = new RepoModel(BUCKET, backendHolder.current);
    assert.deepEqual(await checkStore(model), []);
    const out = join(root, "out");
    mkdirSync(out, { recursive: true });
    process.exitCode = 0;
    await restore([], { set: "lost", output: out });
    assert.equal(process.exitCode, 0);
    const restored = await readFile(join(out, "data", "f.txt"), "utf8");
    assert.equal(restored, "safely stored bytes");
  });

  it("a same-size rewrite preserving mtime escapes the staleness guards (bugs.md: suspected → confirmed — current behaviour)", async () => {
    await using dir = await mkdtempDisposable(join("test", ".tmp"));
    const root = dir.path;
    useHome(root, "mA");
    const data = makeSet(root, "stale", "data");
    const file = join(data, "f.txt");
    writeFileSync(file, "old bytes!!");
    await backup("stale");

    // The `touch -r` shape: rewrite with same-size content, put the mtime
    // back. (Coarse-timestamp filesystems — FAT32's 2 s — produce the same
    // collision without anyone asking for it.)
    const before = statSync(file);
    writeFileSync(file, "new bytes!!");
    utimesSync(file, before.atime, before.mtime);
    const after = statSync(file);
    assert.equal(
      after.mtime.toISOString(),
      before.mtime.toISOString(),
      "precondition: the filesystem must reproduce the mtime exactly",
    );

    clockHolder.current.advance(MINUTE_MS);
    process.exitCode = 0;
    const result = await backup("stale");
    assert.equal(process.exitCode, 0);

    // TODO(known bug, proposals/bugs.md: mtime-precision staleness escape —
    // the "suspected" entry, confirmed here on NTFS): the baseline reuse
    // check sees size+mtime unchanged, records the old hash against the new
    // bytes, and uploads nothing. Restore then "succeeds" with the wrong
    // content. `--rehash` is the documented escape hatch.
    assert.equal(
      result.uploaded,
      0,
      "nothing uploaded — the rewrite is invisible",
    );
    const out = join(root, "out");
    mkdirSync(out, { recursive: true });
    process.exitCode = 0;
    await restore([], {
      set: "stale",
      snapshot: "2026-01-05T0001",
      output: out,
    });
    assert.equal(process.exitCode, 0);
    const restored = await readFile(join(out, "data", "f.txt"), "utf8");
    assert.equal(restored, "old bytes!!", "the new bytes were never backed up");
  });

  it("a truncated stored manifest parses as a valid empty snapshot (format-spec audit — current behaviour)", async () => {
    await using dir = await mkdtempDisposable(join("test", ".tmp"));
    const root = dir.path;
    useHome(root, "mA");
    const data = makeSet(root, "trunc", "data");
    for (let i = 0; i < 3; i++) {
      writeFileSync(join(data, `f${i}.txt`), `file number ${i}\n`.repeat(10));
    }
    await backup("trunc");

    const fake = backendHolder.current;
    const key = "snapshots/trunc/2026-01-05T0000.tsv.zst";
    const full = /** @type {Buffer} */ (await fake.getBytes(BUCKET, key));

    // The untruncated manifest must parse, or the loop below proves nothing:
    // every one of its lengths is allowed to reject, so a parser that threw
    // unconditionally would sail through it and through both downstream
    // assertions.
    const whole = await parseCompressedSnapshotStream(Readable.from([full]));
    assert.equal(whole.entries.size, 3, "the complete manifest must parse");
    assert.equal(whole.dirs.length, 1);

    // ADR-0082: the #END trailer makes truncation loud. Zstd still decompresses
    // a cut-short stream to a byte prefix without error, so the invariant is:
    // every truncation either *rejects* (the trailer or a whole row is gone) or
    // parses the complete manifest (the cut only shaved compression framing
    // after the last content byte — nothing was lost). What no truncation may
    // do any more is parse as a valid smaller-or-empty snapshot.
    for (let length = 0; length < full.length; length++) {
      /** @type {Awaited<ReturnType<typeof parseCompressedSnapshotStream>>} */
      let parsed;
      try {
        parsed = await parseCompressedSnapshotStream(
          Readable.from([full.subarray(0, length)]),
        );
      } catch {
        continue; // loud — exactly what a lossy truncation must be
      }
      assert.equal(
        parsed.entries.size,
        3,
        `a cut at byte ${length} of ${full.length} parsed silently with entries missing`,
      );
      assert.equal(
        parsed.dirs.length,
        1,
        `a cut at byte ${length} of ${full.length} parsed silently with the #DIR header missing`,
      );
    }

    // Downstream, the parse error is a *finding*, not a crash: verify records
    // the snapshot as unreadable and exits 1 (isCorruptSnapshotError routes
    // the AssertionError into the unreadable channel), and restore refuses for
    // the true reason — the manifest is truncated.
    await fake.putBytes(
      BUCKET,
      key,
      full.subarray(0, Math.floor(full.length / 2)),
    );
    process.exitCode = 0;
    const report = await verify(BUCKET);
    assert.equal(
      process.exitCode,
      1,
      "verify must flag the destroyed snapshot, not vouch for it",
    );
    assert.deepEqual(
      report.sets.map((s) => [
        s.set,
        s.unreadableSnapshots.map((u) => u.snapshot),
      ]),
      [["trunc", ["2026-01-05T0000"]]],
      "the truncated snapshot is reported unreadable under its set",
    );
    const out = join(root, "out");
    mkdirSync(out, { recursive: true });
    await assert.rejects(
      restore([], { set: "trunc", output: out }),
      /Truncated snapshot/,
    );
  });

  it("cleanup sweeps an old object a running backup just skipped (concurrency-and-locking §1 residual hole — current behaviour)", async () => {
    await using dir = await mkdtempDisposable(join("test", ".tmp"));
    const root = dir.path;
    useHome(root, "mA");
    const data = makeSet(root, "race", "data");
    const content = Buffer.from("crash orphan from weeks back");
    writeFileSync(join(data, "f.txt"), content);

    // The object is already stored — a crash orphan: uploaded, never
    // referenced, and old enough that the grace window no longer protects it.
    const fake = backendHolder.current;
    await fake.putBytes(BUCKET, `objects/${sha256(content)}`, content);
    clockHolder.current.advance(8 * DAY_MS);

    // Interleave: the backup's store LIST sees the object and skips
    // uploading it; cleanup runs in the gap between that skip and the
    // manifest PUT and deletes it as an orphan.
    const realPutFile = fake.putFile.bind(fake);
    fake.putFile = async (path, uri, options) => {
      if (uri.includes("/snapshots/")) {
        await cleanup(BUCKET, { force: true });
      }
      return realPutFile(path, uri, options);
    };
    process.exitCode = 0;
    const result = await backup("race");

    // The backup claims clean success…
    assert.equal(result.errors, 0);
    assert.equal(process.exitCode, 0);

    // …and its published snapshot references a deleted object. This is the
    // documented residual hole (docs/design/backup.md accepts it as "don't
    // run cleanup during a backup"); the test pins it as real, deterministic,
    // and unexplained by any deletion record. If a lock or a pre-delete
    // re-check ever closes it, flip to `deepEqual([])`.
    const model = new RepoModel(BUCKET, backendHolder.current);
    const violations = await checkStore(model);
    assert.ok(
      violations.some((v) => v.startsWith("dangling reference: race/")),
      `expected dangling references, got: ${violations.join("\n")}`,
    );
    process.exitCode = 0;
    await verify(BUCKET);
    assert.equal(
      process.exitCode,
      1,
      "verify reports the loss, after the fact",
    );
  });

  it("forget + cleanup mid-backup delete the baseline's objects before the manifest lands (concurrency-and-locking §1 — current behaviour)", async () => {
    await using dir = await mkdtempDisposable(join("test", ".tmp"));
    const root = dir.path;
    useHome(root, "mA");
    const data = makeSet(root, "interleave", "data");
    writeFileSync(join(data, "f.txt"), "vouched for by the baseline");
    await backup("interleave");
    clockHolder.current.advance(8 * DAY_MS);

    // The second backup passes its baseline HEAD and is skipping every object
    // the baseline vouches for. Mid-run, the baseline is forgotten and
    // cleanup follows: those objects — old, now unreferenced — go before the
    // new manifest lands. (The 2026-07-19 baseline-trust fix re-checks at the
    // *start* of a backup; it cannot help the one already in flight.)
    const fake = backendHolder.current;
    const realPutFile = fake.putFile.bind(fake);
    fake.putFile = async (path, uri, options) => {
      if (uri.includes("/snapshots/")) {
        await forget(["2026-01-05T0000"], { set: "interleave", force: true });
        await cleanup(BUCKET, { force: true });
      }
      return realPutFile(path, uri, options);
    };
    process.exitCode = 0;
    const result = await backup("interleave");

    assert.equal(result.errors, 0);
    assert.equal(result.uploaded, 0, "every object was baseline-skipped");
    assert.equal(process.exitCode, 0);

    // The new snapshot references objects forget+cleanup just removed.
    const model = new RepoModel(BUCKET, backendHolder.current);
    const violations = await checkStore(model);
    assert.ok(
      violations.some((v) => v.startsWith("dangling reference: interleave/")),
      `expected dangling references, got: ${violations.join("\n")}`,
    );
    process.exitCode = 0;
    await verify(BUCKET);
    assert.equal(process.exitCode, 1);
  });
});
