import assert from "node:assert/strict";
import { mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { mkdtempDisposable } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { holdSet } from "../helpers/hold-set.mjs";
import { MINUTE_MS, VirtualClock, clockHolder } from "./harness/clock.mjs";
import { FakeS3, backendHolder } from "./harness/fake-s3.mjs";
import { checkStore } from "./harness/invariants.mjs";
import { RepoModel, sha256 } from "./harness/model.mjs";
import {
  backup,
  cleanup,
  deleteHashes,
  forget,
  restore,
  verify,
  writeSet,
} from "./harness/seam.mjs";

// The 2026-11-05 durability audits' defects (proposals/bugs.md rolls them up;
// ADR-0117, ADR-0112 and ADR-0064 hold the decisions), each pinned by the
// behaviour the audit says is right. Deterministic Tier 1 encodings, in the
// shape of model.findings.test.mjs.

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
 * @param {string} machine
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

describe("2026-11-05 durability audit", () => {
  it("verify does not report a bucket in which it checked no snapshot as verified (defect 1)", async () => {
    await using dir = await mkdtempDisposable(join("test", ".tmp"));
    const root = dir.path;
    useHome(root, "mA");
    const data = await makeSet(root, "photos", "data");
    writeFileSync(join(data, "a.txt"), "alpha");
    await backup("photos");

    // Every snapshot is gone — a console mis-delete, a lifecycle rule, a
    // ransomware wipe of `snapshots/` — while the marker and the objects
    // remain. Nothing is restorable, and that is the one thing a health
    // check exists to say.
    const fake = backendHolder.current;
    for (const { key } of await fake.listAll(BUCKET)) {
      if (key.startsWith("snapshots/photos/")) {
        await fake.deleteKey(BUCKET, key);
      }
    }
    process.exitCode = 0;
    const report = await verify(BUCKET);
    assert.notEqual(
      process.exitCode,
      0,
      "a run that could check nothing must not exit 0 — `verify || alert` would stay silent",
    );
    assert.ok(
      report.sets.some((set) => set.set === "photos"),
      "the set whose marker says it exists is reported, not omitted",
    );
  });

  it("verify reports an object in an archive storage class, which a plain GET can't read (defect 2)", async () => {
    await using dir = await mkdtempDisposable(join("test", ".tmp"));
    const root = dir.path;
    useHome(root, "mA");
    const data = await makeSet(root, "cold", "data");
    writeFileSync(join(data, "a.txt"), "alpha");
    await backup("cold");

    // A lifecycle rule has moved `objects/` to GLACIER: the LIST says so in
    // every entry's `StorageClass`, and every GET fails `InvalidObjectState`
    // until a restore request has been made and waited for.
    const fake = backendHolder.current;
    const realList = fake.listObjects.bind(fake);
    fake.listObjects = async function* (uri) {
      for await (const object of realList(uri)) {
        yield object.Key?.startsWith("objects/")
          ? { ...object, StorageClass: "GLACIER" }
          : object;
      }
    };
    const realGet = fake.getStream.bind(fake);
    fake.getStream = async (uri) => {
      if (uri.includes("/objects/")) {
        throw Object.assign(
          new Error(
            "The operation is not valid for the object's storage class",
          ),
          { name: "InvalidObjectState" },
        );
      }
      return realGet(uri);
    };

    const out = join(root, "out");
    mkdirSync(out, { recursive: true });
    await assert.rejects(
      restore([], { all: true, set: "cold", output: out }),
      /storage class/,
      "nothing restores",
    );
    process.exitCode = 0;
    const report = await verify(BUCKET);
    assert.equal(
      process.exitCode,
      1,
      "a store nothing can be read back from must not verify clean",
    );
    assert.ok(
      report.sets.some((set) => set.problems.length > 0),
      "the unreadable objects are findings",
    );
  });

  // An open limit of the deletion-record rule, kept runnable rather than fixed:
  // closing it is a format change (proposals/bugs.md, "fast deleting clock").
  it(
    "damage to content a snapshot stored after its deletion is a finding, whatever clock stamped the row (defect 3)",
    {
      todo: "a fast deleting clock masks damage to content re-stored within the skew — a format change, not a code fix",
    },
    async () => {
      await using dir = await mkdtempDisposable(join("test", ".tmp"));
      const root = dir.path;
      useHome(root, "mA");
      const data = await makeSet(root, "skew", "data");
      const content = Buffer.from("comes and goes");
      const hash = sha256(content);
      writeFileSync(join(data, "f.txt"), content);
      await backup("skew");

      // A machine whose clock runs ten minutes fast deletes the content; the
      // holder, on true time, backs the file up again five minutes later. The
      // row's instant is later than the new snapshot's START, so the row
      // "explains" an absence of content this snapshot stored.
      clockHolder.current.advance(10 * MINUTE_MS);
      await deleteHashes([hash], { bucket: BUCKET, force: true });
      clockHolder.current.advance(-5 * MINUTE_MS);
      const again = await backup("skew");
      assert.equal(again.uploaded, 1, "the content was stored again");

      // Then the object really is lost.
      const fake = backendHolder.current;
      await fake.deleteKey(BUCKET, `objects/${hash}`);
      process.exitCode = 0;
      const report = await verify(BUCKET);
      assert.equal(
        process.exitCode,
        1,
        "the newest snapshot's file can't be restored: that is damage, not an expected absence",
      );
      assert.ok(
        report.sets.some((set) =>
          set.problems.some(
            (problem) =>
              problem.problem === "missing" &&
              problem.snapshots.includes(again.snapshot),
          ),
        ),
        "the file is reported missing from the snapshot that stored it",
      );
    },
  );

  it("cleanup's top-up reads a snapshot re-published under a key its scan had read (defect 4)", async () => {
    await using dir = await mkdtempDisposable(join("test", ".tmp"));
    const root = dir.path;
    useHome(root, "mA");
    const data = await makeSet(root, "topup", "data");
    writeFileSync(join(data, "a.txt"), "alpha");
    await backup("topup");
    const fake = backendHolder.current;
    // An object already in the store that nothing references yet.
    const orphan = Buffer.from("orphan content");
    await fake.putBytes(BUCKET, `objects/${sha256(orphan)}`, orphan);
    const name = "20260105T0000";

    // Between cleanup's scan and its delete lock, the snapshot is forgotten
    // and re-published under the same key with different content — now
    // referencing the orphan, which the conditional PUT found stored. The
    // top-up compares keys, so it never reads the new document.
    const realPutText = fake.putText.bind(fake);
    let armed = true;
    fake.putText = async (uri, content, options) => {
      if (armed && uri.includes("/locks/delete-")) {
        armed = false;
        await forget([name], { set: "topup", force: true });
        rmSync(join(data, "a.txt"));
        writeFileSync(join(data, "o.bin"), orphan);
        const again = await backup("topup", { debug: true });
        assert.equal(again.snapshot, name, "same key, different bytes");
      }
      return realPutText(uri, content, options);
    };
    await cleanup(BUCKET, { force: true });

    // The published snapshot's references must all still be stored.
    const model = new RepoModel(BUCKET, backendHolder.current);
    assert.deepEqual(
      await checkStore(model),
      [],
      "cleanup deleted content a published snapshot references",
    );
  });
});
