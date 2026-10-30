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
import { holdSet } from "../helpers/hold-set.mjs";
import { MINUTE_MS, VirtualClock, clockHolder } from "./harness/clock.mjs";
import { FakeS3, backendHolder } from "./harness/fake-s3.mjs";
import { checkStore } from "./harness/invariants.mjs";
import { RepoModel, restoredAt, sha256 } from "./harness/model.mjs";
import {
  backup,
  cleanup,
  deleteHashes,
  forget,
  parseCompressedSnapshotStream,
  restore,
  snapshot,
  verify,
  writeSet,
} from "./harness/seam.mjs";

// The prior audits' findings (proposals/bugs.md — the 2026-08-12 durability
// audit and the 2026-10-29 locks audit; proposals/concurrency-and-locking.md
// §1) encoded as deterministic Tier 1 tests — this suite is how those
// hypotheses get sorted into real bugs and ruled-out worries. Each test names
// its source entry. One for an open bug asserts the behaviour observed
// **today**, with a TODO stating what the assertion flips to when the bug is
// fixed, so a fix fails here loudly and gets a deliberate decision; one for a
// finding an ADR has since closed pins the correct behaviour, naming the ADR.
//
// Not here: the mid-transfer mutation and backup-exit-0 cases (both fixed,
// their tests flipped) live in model.hostile.test.mjs (hostile-tree cases); the
// versioning-never-checked entry (engine-robustness.md) needs a real
// versioned bucket and belongs to Tier 2 (see CAPABILITIES.md, "versioning").

const BUCKET = "model-bucket";

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
 * A data directory, registered as a set the current home holds.
 * @param {string} root
 * @param {string} set
 * @param {string} dirName
 * @returns {Promise<string>} the data directory (canonical)
 */
const makeSet = async (root, set, dirName) => {
  mkdirSync(join(root, dirName), { recursive: true });
  const dir = realpathSync.native(join(root, dirName));
  const { claimPath } = writeSet(set, { dirs: [dir], bucket: BUCKET });
  await holdSet(BUCKET, set, claimPath);
  return dir;
};

/**
 * Run `action` in the gap before a backup's manifest PUT — every object
 * stored or skipped, the snapshot not yet published, the upload lock held.
 * @param {FakeS3} fake
 * @param {() => Promise<void>} action
 */
const beforeManifestPut = (fake, action) => {
  const realPutFile = fake.putFile.bind(fake);
  fake.putFile = async (path, uri, options) => {
    if (uri.includes("/snapshots/")) {
      await action();
    }
    return realPutFile(path, uri, options);
  };
};

describe("prior-audit findings, encoded", () => {
  it("another machine's same-name snapshot no longer vouches for a never-uploaded baseline (bugs.md, fixed: byte-identity trust, ADR-0084)", async () => {
    await using dir = await mkdtempDisposable(join("test", ".tmp"));
    const root = dir.path;

    // Machine A snapshots offline at the shared minute — local only, nothing
    // uploaded, nothing records that it wasn't.
    useHome(root, "mA");
    const dataA = await makeSet(root, "col", "dataA");
    writeFileSync(join(dataA, "a.txt"), "machine A content, never uploaded");
    await snapshot("col");

    // Machine B publishes a remote snapshot for the same set at the same
    // minute — same name, different document.
    useHome(root, "mB");
    const dataB = await makeSet(root, "col", "dataB");
    writeFileSync(join(dataB, "b.txt"), "machine B content");
    await backup("col");

    // A's next backup: its own local snapshot is the baseline. A name-only
    // check would find B's snapshot and trust A's never-uploaded hashes as
    // stored; the byte-identity check (ADR-0084) sees a different document,
    // distrusts the baseline, LISTs the store and uploads A's objects.
    // A takes the set back: B's makeSet made B the holder.
    clockHolder.current.advance(MINUTE_MS);
    useHome(root, "mA");
    await holdSet(
      BUCKET,
      "col",
      join(root, "mA", ".s3cab", "sets", "col", "claim"),
    );
    process.exitCode = 0;
    const result = await backup("col");

    assert.deepEqual(result.errors, []);
    assert.equal(result.uploaded, 1, "A's object really goes up this time");
    assert.equal(process.exitCode, 0);

    // The store is complete: every manifest's references — A's and B's — are
    // backed by stored objects, and verify agrees.
    const model = new RepoModel(BUCKET, backendHolder.current);
    assert.deepEqual(await checkStore(model), []);
    process.exitCode = 0;
    await verify(BUCKET);
    assert.equal(process.exitCode, 0);
  });

  it("a manifest PUT whose lost response is retried succeeds quietly (bugs.md, fixed: byte-identical = own success, ADR-0084)", async () => {
    await using dir = await mkdtempDisposable(join("test", ".tmp"));
    const root = dir.path;
    useHome(root, "mA");
    const data = await makeSet(root, "lost", "data");
    writeFileSync(join(data, "f.txt"), "safely stored bytes");

    // The retry relay lives below the seam, so model its lost-response shape
    // at the seam: the manifest PUT lands, the re-sent request harvests a 412
    // from its own success, and the caller is told "already present". The fix
    // (ADR-0084): fetch the remote manifest, see it is byte-identical to the
    // one just sent, and treat the publish as the success it was.
    const fake = backendHolder.current;
    const realPutFile = fake.putFile.bind(fake);
    fake.putFile = async (path, uri, options) => {
      const wrote = await realPutFile(path, uri, options);
      return uri.includes("/snapshots/") ? false : wrote;
    };

    process.exitCode = 0;
    await backup("lost");
    assert.equal(process.exitCode, 0);

    // And it really was a success: the store holds a complete, consistent
    // repository and the snapshot restores byte-identically.
    const model = new RepoModel(BUCKET, backendHolder.current);
    assert.deepEqual(await checkStore(model), []);
    const out = join(root, "out");
    mkdirSync(out, { recursive: true });
    process.exitCode = 0;
    await restore([], { all: true, set: "lost", output: out });
    assert.equal(process.exitCode, 0);
    const restored = await readFile(
      join(restoredAt(out, data), "f.txt"),
      "utf8",
    );
    assert.equal(restored, "safely stored bytes");
  });

  /**
   * A set holding one backed-up file, then rewritten in the `touch -r` shape:
   * same-size content, mtime put back. (Coarse-timestamp filesystems — FAT32's
   * 2 s — produce the same collision without anyone asking for it.)
   * @param {string} root
   */
  const rewriteKeepingMtime = async (root) => {
    useHome(root, "mA");
    const data = await makeSet(root, "stale", "data");
    const file = join(data, "f.txt");
    writeFileSync(file, "old bytes!!");
    await backup("stale");

    const before = statSync(file);
    writeFileSync(file, "new bytes!!");
    utimesSync(file, before.atime, before.mtime);
    const after = statSync(file);
    assert.equal(
      after.mtime.toISOString(),
      before.mtime.toISOString(),
      "precondition: the filesystem must reproduce the mtime exactly",
    );
  };

  /**
   * What a restore of one of the `stale` set's snapshots hands back.
   * @param {string} root
   * @param {string} snapshot
   */
  const restoredFrom = async (root, snapshot) => {
    const out = join(root, `out-${snapshot}`);
    mkdirSync(out, { recursive: true });
    process.exitCode = 0;
    await restore([], { all: true, set: "stale", snapshot, output: out });
    assert.equal(process.exitCode, 0);
    const data = realpathSync.native(join(root, "data"));
    return readFile(join(restoredAt(out, data), "f.txt"), "utf8");
  };

  it("a same-size rewrite preserving mtime is missed by default, and `backup --rehash` sees it (ADR-0094)", async () => {
    await using dir = await mkdtempDisposable(join("test", ".tmp"));
    const root = dir.path;
    await rewriteKeepingMtime(root);

    // The documented limit of the size+mtime rule: the stored hash is reused.
    clockHolder.current.advance(MINUTE_MS);
    process.exitCode = 0;
    const routine = await backup("stale");
    assert.equal(process.exitCode, 0);
    assert.equal(routine.uploaded, 0);
    assert.equal(await restoredFrom(root, "20260105T0001"), "old bytes!!");

    // And the documented cure.
    clockHolder.current.advance(MINUTE_MS);
    process.exitCode = 0;
    const rehashed = await backup("stale", { rehash: true });
    assert.equal(process.exitCode, 0);
    assert.equal(rehashed.uploaded, 1, "the rewrite is seen and uploaded");
    assert.equal(await restoredFrom(root, "20260105T0002"), "new bytes!!");
  });

  it("a same-size rewrite preserving mtime is caught under S3CAB_CHECK_CHANGE_TIME (bugs.md, fixed: ADR-0085, opt-in since ADR-0094)", async () => {
    await using dir = await mkdtempDisposable(join("test", ".tmp"));
    const root = dir.path;
    await rewriteKeepingMtime(root);

    clockHolder.current.advance(MINUTE_MS);
    process.env.S3CAB_CHECK_CHANGE_TIME = "1";
    process.exitCode = 0;
    const result = await backup("stale");
    assert.equal(process.exitCode, 0);

    // The rewrite put the mtime back, but the write (and the utimes call
    // itself) bumped ctime past the baseline's start, so the reuse check
    // distrusts the size+mtime match and re-hashes. The exact older-vs-newer
    // ctime boundary is pinned in src/lib/file-props.test.mjs; this asserts the
    // end-to-end outcome: the new bytes are backed up.
    assert.equal(result.uploaded, 1, "the rewrite is seen and uploaded");
    assert.equal(await restoredFrom(root, "20260105T0001"), "new bytes!!");
  });

  it("a truncated stored manifest is a loud parse error — verify reports it, restore refuses (format-spec audit, fixed by ADR-0082)", async () => {
    await using dir = await mkdtempDisposable(join("test", ".tmp"));
    const root = dir.path;
    useHome(root, "mA");
    const data = await makeSet(root, "trunc", "data");
    for (let i = 0; i < 3; i++) {
      writeFileSync(join(data, `f${i}.txt`), `file number ${i}\n`.repeat(10));
    }
    await backup("trunc");

    const fake = backendHolder.current;
    const key = "snapshots/trunc/20260105T0000.tsv.gz";
    const full = /** @type {Buffer} */ (await fake.peekBytes(BUCKET, key));

    // The untruncated manifest must parse, or the loop below proves nothing:
    // every one of its lengths is allowed to reject, so a parser that threw
    // unconditionally would sail through it and through both downstream
    // assertions.
    const whole = await parseCompressedSnapshotStream(Readable.from([full]));
    assert.equal(whole.entries.size, 3, "the complete manifest must parse");
    assert.equal(whole.dirs.length, 1);

    // ADR-0082: the closing `.` makes truncation loud. The invariant is: every
    // truncation either *rejects* (the trailer or a whole row is gone, or
    // gunzip refuses the cut stream itself, as it does at every cut measured on
    // 26.11) or parses the complete manifest, which only a cut shaving
    // compression framing after the last content byte could ever do. What no truncation may do is parse as a
    // valid smaller-or-empty snapshot. The loop is written to allow both
    // outcomes because that is the invariant, not because a reject is expected
    // at some lengths and not others (amendment 3: at this floor they all do).
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
        `a cut at byte ${length} of ${full.length} parsed silently with the @SET DIR row missing`,
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
      [["trunc", ["20260105T0000"]]],
      "the truncated snapshot is reported unreadable under its set",
    );
    const out = join(root, "out");
    mkdirSync(out, { recursive: true });
    await assert.rejects(
      restore([], { all: true, set: "trunc", output: out }),
      /Damaged snapshot: .*cut short/,
    );
  });

  it("cleanup mid-backup is refused by the backup's upload lock, so the object the backup skipped survives (concurrency-and-locking §1, closed by ADR-0112)", async () => {
    await using dir = await mkdtempDisposable(join("test", ".tmp"));
    const root = dir.path;
    useHome(root, "mA");
    const data = await makeSet(root, "race", "data");
    const content = Buffer.from("crash orphan from weeks back");
    writeFileSync(join(data, "f.txt"), content);

    // The object is already stored — a crash orphan: uploaded, never
    // referenced. No grace window protects it: only the lock does.
    const fake = backendHolder.current;
    await fake.putBytes(BUCKET, `objects/${sha256(content)}`, content);

    // Interleave: the backup's store LIST sees the object and skips
    // uploading it; cleanup runs in the gap between that skip and the
    // manifest PUT, where it used to delete the object as an orphan.
    /** @type {unknown} */
    let cleanupOutcome;
    beforeManifestPut(fake, async () => {
      cleanupOutcome = await cleanup(BUCKET, { force: true }).catch(
        (error) => error,
      );
    });
    process.exitCode = 0;
    const result = await backup("race");

    assert.deepEqual(result.errors, []);
    assert.equal(process.exitCode, 0);
    assert.match(
      /** @type {Error} */ (cleanupOutcome).message,
      /a backup or upload is running on bucket 'model-bucket'/,
    );

    // The published snapshot references a stored object, and the refused
    // cleanup left no lock of its own; the backup removed its lock at the end.
    const model = new RepoModel(BUCKET, backendHolder.current);
    assert.deepEqual(await checkStore(model), []);
    const keys = (await fake.listAll(BUCKET)).map(({ key }) => key);
    assert.deepEqual(
      keys.filter((key) => key.startsWith("locks/")),
      [],
      "no lock survives either run",
    );
    process.exitCode = 0;
    await verify(BUCKET);
    assert.equal(process.exitCode, 0);
  });

  it("forget + cleanup mid-backup: forget goes ahead, cleanup is refused, so the baseline's objects the backup trusts survive (concurrency-and-locking §1, closed by ADR-0112)", async () => {
    await using dir = await mkdtempDisposable(join("test", ".tmp"));
    const root = dir.path;
    useHome(root, "mA");
    const data = await makeSet(root, "interleave", "data");
    writeFileSync(join(data, "f.txt"), "vouched for by the baseline");
    await backup("interleave");
    clockHolder.current.advance(MINUTE_MS);

    // The second backup passes its baseline identity check and is skipping
    // every object the baseline vouches for. Mid-run, the baseline is
    // forgotten (forget takes no lock: it deletes manifests, never objects)
    // and cleanup follows — and meets the backup's upload lock.
    const fake = backendHolder.current;
    /** @type {unknown} */
    let cleanupOutcome;
    beforeManifestPut(fake, async () => {
      await forget(["20260105T0000"], { set: "interleave", force: true });
      cleanupOutcome = await cleanup(BUCKET, { force: true }).catch(
        (error) => error,
      );
    });
    process.exitCode = 0;
    const result = await backup("interleave");

    assert.deepEqual(result.errors, []);
    assert.equal(result.uploaded, 0, "every object was baseline-skipped");
    assert.equal(process.exitCode, 0);
    assert.match(
      /** @type {Error} */ (cleanupOutcome).message,
      /a backup or upload is running/,
    );

    // The new snapshot's references are all still stored, and a cleanup now
    // — nothing running — goes ahead and finds nothing to reclaim.
    const model = new RepoModel(BUCKET, backendHolder.current);
    assert.deepEqual(await checkStore(model), []);
    await cleanup(BUCKET, { force: true });
    assert.deepEqual(await checkStore(model), []);
    process.exitCode = 0;
    await verify(BUCKET);
    assert.equal(process.exitCode, 0);
  });

  it("delete <hash> mid-backup is refused by the backup's upload lock, so the baseline-skipped object the new snapshot references survives (2026-10-29 locks audit, ADR-0112)", async () => {
    await using dir = await mkdtempDisposable(join("test", ".tmp"));
    const root = dir.path;
    useHome(root, "mA");
    const data = await makeSet(root, "unlink", "data");
    const content = Buffer.from("vouched for by the baseline");
    writeFileSync(join(data, "f.txt"), content);
    await backup("unlink");
    clockHolder.current.advance(MINUTE_MS);

    // The second backup trusts its baseline and skips the object. In the gap
    // before its manifest PUT, `delete` names that hash: its preflight HEAD
    // finds the object, and its delete lock then meets the upload lock. The
    // pin: a snapshot is published referencing only stored content.
    const fake = backendHolder.current;
    const hash = sha256(content);
    /** @type {unknown} */
    let deleteOutcome;
    beforeManifestPut(fake, async () => {
      deleteOutcome = await deleteHashes([hash], {
        bucket: BUCKET,
        force: true,
      }).catch((error) => error);
    });
    process.exitCode = 0;
    const from = fake.log.length;
    const result = await backup("unlink");

    assert.deepEqual(result.errors, []);
    assert.equal(result.uploaded, 0);
    assert.ok(
      !fake.log
        .slice(from)
        .some(({ op, uri }) => op === "LIST" && uri.includes("/objects/")),
      "the baseline was trusted: no store LIST, every object baseline-skipped",
    );
    assert.equal(process.exitCode, 0);
    assert.ok(deleteOutcome instanceof Error, "delete was refused");
    assert.match(
      deleteOutcome.message,
      /a backup or upload is running on bucket 'model-bucket'/,
    );

    // Nothing was deleted and nothing recorded as deleted; the refused delete
    // left no lock, and the backup removed its own at the end.
    const keys = (await fake.listAll(BUCKET)).map(({ key }) => key);
    assert.ok(keys.includes(`objects/${hash}`), "the object is still stored");
    assert.deepEqual(
      keys.filter((key) => /^objects\.deleted-|^locks\//.test(key)),
      [],
      "no deletion record, no lock",
    );
    const model = new RepoModel(BUCKET, backendHolder.current);
    assert.deepEqual(await checkStore(model), []);
    process.exitCode = 0;
    await verify(BUCKET);
    assert.equal(process.exitCode, 0);
  });

  it("a deletion record subtracts a hash from the trusted baseline only while its object is absent: re-uploaded once, then trusted again (2026-10-29 locks audit; presence wins, guide/format.md)", async () => {
    await using dir = await mkdtempDisposable(join("test", ".tmp"));
    const root = dir.path;
    useHome(root, "mA");
    const data = await makeSet(root, "presence", "data");
    const content = Buffer.from("deleted, then backed up again");
    writeFileSync(join(data, "f.txt"), content);
    const hash = sha256(content);
    await backup("presence");
    await deleteHashes([hash], { bucket: BUCKET, force: true });
    const fake = backendHolder.current;
    assert.equal(await fake.peekBytes(BUCKET, `objects/${hash}`), undefined);

    // Absent: the record is respected and the baseline-trusting backup
    // re-stores the object rather than publishing a reference to nothing.
    clockHolder.current.advance(MINUTE_MS);
    const reupload = await backup("presence");
    assert.deepEqual(reupload.errors, []);
    assert.equal(
      reupload.uploaded,
      1,
      "the recorded-deleted object is re-stored",
    );

    // Present again, row still in the record: the HEAD finds it, so the
    // baseline keeps vouching for it and nothing is re-uploaded. Only this
    // backup's own storage ops count — the delete's preflight and the
    // re-upload backup HEADed the same key, and a no-clobber PUT that found
    // the object present would also leave `uploaded` at 0.
    clockHolder.current.advance(MINUTE_MS);
    const from = fake.log.length;
    const trusted = await backup("presence");
    assert.deepEqual(trusted.errors, []);
    assert.equal(trusted.uploaded, 0, "presence wins over the record");
    const ops = fake.log
      .slice(from)
      .filter(({ uri }) => uri.endsWith(`objects/${hash}`))
      .map(({ op }) => op);
    assert.deepEqual(
      ops,
      ["HEAD"],
      "the recorded hash was HEADed once and never re-PUT",
    );

    const model = new RepoModel(BUCKET, backendHolder.current);
    assert.deepEqual(await checkStore(model), []);
    process.exitCode = 0;
    await verify(BUCKET);
    assert.equal(process.exitCode, 0);
  });
});
