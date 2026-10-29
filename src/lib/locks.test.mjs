import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtempDisposable } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import { s3Seam } from "../../test/helpers/s3-seam.mjs";

// The bucket locks (ADR-0112) over an in-memory bucket at the s3.mjs seam —
// a keyed text store whose no-overwrite PUT really refuses a taken key — so
// every rule here is proved by the requests the bucket sees, in order: write
// first, look second; the own lock removed before a refusal; the local file
// holding the id for as long as the bucket lock exists. Mocks first, then a
// dynamic import (objects.test.mjs rule).

/** @type {Map<string, string>} the bucket: key → body */
let store = new Map();
/** @type {string[]} every request, in order: `put:<key>`, `get:<key>`, `list:<prefix>`, `delete:<key>` */
let requests = [];
/** @type {(key: string) => void} runs before each no-overwrite PUT (to make it lose) */
let beforePut = () => {};
/** The first PUT lands but its response is lost: stored, yet reported refused. */
let firstPutLandsUnseen = false;
/** Every key read vanishes just before the read — a run that just ended. */
let vanishOnGet = false;
/** @type {Error | undefined} let every DELETE fail */
let deleteError;
/** @type {Error | undefined} let the LIST fail */
let listError;

const keyOf = (/** @type {string} */ uri) => uri.replace(/^s3:\/\/[^/]+\//, "");

mock.module("./s3.mjs", {
  exports: s3Seam({
    putText: async (
      /** @type {string} */ uri,
      /** @type {string} */ body,
      /** @type {{ noClobber?: boolean } | undefined} */ options,
    ) => {
      const key = keyOf(uri);
      beforePut(key);
      requests.push(`put:${key}`);
      if (firstPutLandsUnseen) {
        firstPutLandsUnseen = false;
        store.set(key, body);
        return false;
      }
      if (options?.noClobber && store.has(key)) {
        return false;
      }
      store.set(key, body);
      return true;
    },
    getText: async (/** @type {string} */ uri) => {
      const key = keyOf(uri);
      requests.push(`get:${key}`);
      if (vanishOnGet) {
        store.delete(key);
      }
      return store.get(key);
    },
    listObjects: async function* (/** @type {string} */ uri) {
      const prefix = keyOf(uri);
      requests.push(`list:${prefix}`);
      if (listError) {
        throw listError;
      }
      for (const key of [...store.keys()].sort()) {
        if (key.startsWith(prefix)) {
          yield { Key: key };
        }
      }
    },
    deleteObject: async (/** @type {string} */ uri) => {
      const key = keyOf(uri);
      requests.push(`delete:${key}`);
      if (deleteError) {
        throw deleteError;
      }
      store.delete(key);
    },
  }),
});
mock.module("./user-at-machine.mjs", {
  exports: { userAtMachine: () => "allen@DESKTOP" },
});
/** @type {{ ms: number, wake: () => void }[]} every `--wait` sleep, to be woken by the test */
let sleeps = [];
// The wait between looks is a real half minute; here each sleep parks until
// the test wakes it, so a test steps the wait loop by hand.
mock.module("node:timers/promises", {
  exports: {
    setTimeout: (/** @type {number} */ ms) =>
      new Promise((resolve) => {
        sleeps.push({ ms, wake: () => resolve(undefined) });
      }),
  },
});
/** Let the run reach its next sleep, or finish. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

const {
  WAIT_MS,
  describeLock,
  holdDeleteLock,
  holdUploadLock,
  listLocks,
  removeLock,
  writeLock,
} = await import("./locks.mjs");

const mkTmpDir = async () => mkdtempDisposable(join("test", ".tmp"));

/** @param {string} dirPath */
const setIn = (dirPath) => ({
  name: "photos",
  uploadLockPath: join(dirPath, ".upload.lock"),
  uploadUnlockPath: join(dirPath, ".upload.unlock"),
});

/** A lock another run holds, planted straight into the bucket. */
const plant = (
  /** @type {string} */ id,
  /** @type {string} */ command,
  /** @type {string | undefined} */ set = undefined,
) =>
  store.set(
    `locks/${id}`,
    `COMMAND=${command}\n${set ? `SET=${set}\n` : ""}BY=other@LAPTOP\nSTARTED=2026-10-27T14:02:05.123Z\n`,
  );

const lockKeys = () => [...store.keys()].filter((k) => k.startsWith("locks/"));

/** @type {string[]} */
let warnings = [];
/** @type {ReturnType<typeof mock.method>} */
let warn;
beforeEach(() => {
  store = new Map();
  requests = [];
  beforePut = () => {};
  firstPutLandsUnseen = false;
  vanishOnGet = false;
  deleteError = undefined;
  listError = undefined;
  sleeps = [];
  warnings = [];
  warn = mock.method(console, "warn", (/** @type {string} */ m) =>
    warnings.push(m),
  );
});
afterEach(() => {
  warn.mock.restore();
});

describe("writeLock", () => {
  it("writes locks/<kind>-<instant> with the run's command, set, machine and start", async () => {
    const lock = await writeLock("b", {
      kind: "upload",
      command: "backup",
      set: "photos",
    });

    assert.match(lock.id, /^upload-\d{8}T\d{6}\.\d{3}Z$/);
    assert.deepEqual(lockKeys(), [`locks/${lock.id}`]);
    assert.equal(
      store.get(`locks/${lock.id}`),
      `COMMAND=backup\nSET=photos\nBY=allen@DESKTOP\nSTARTED=${lock.started}\n`,
    );
    // The key's instant is the STARTED line in the basic form.
    assert.equal(
      lock.id,
      `upload-${lock.started.replaceAll("-", "").replaceAll(":", "")}`,
    );
  });

  it("writes no SET line for a run with no set", async () => {
    const lock = await writeLock("b", { kind: "delete", command: "cleanup" });

    assert.equal(lock.set, undefined);
    assert.doesNotMatch(String(store.get(`locks/${lock.id}`)), /SET=/);
  });

  it("takes a 412 over its own bytes as its own lock — a retried PUT whose first try landed", async () => {
    // The PUT lands, the response is lost, the SDK retries, the retry 412s:
    // from here that is one refused PUT whose read-back is the run's own body.
    firstPutLandsUnseen = true;

    const lock = await writeLock("b", { kind: "upload", command: "backup" });

    assert.deepEqual(requests, [
      `put:locks/${lock.id}`,
      `get:locks/${lock.id}`,
    ]);
    assert.deepEqual(lockKeys(), [`locks/${lock.id}`]);
  });

  it("mints a fresh instant when the 412 was someone else's lock", async () => {
    let first = true;
    beforePut = (key) => {
      if (first) {
        first = false;
        store.set(key, "COMMAND=backup\nBY=other@LAPTOP\n"); // theirs
      }
    };

    const lock = await writeLock("b", { kind: "upload", command: "backup" });

    const puts = requests.filter((r) => r.startsWith("put:"));
    assert.equal(puts.length, 2, "one refused PUT, one that landed");
    assert.notEqual(puts[0], puts[1], "never the id that just lost");
    assert.equal(puts[1], `put:locks/${lock.id}`);
    assert.equal(lockKeys().length, 2, "theirs stays, ours is the second");
  });
});

describe("listLocks, removeLock, describeLock", () => {
  it("lists every lock oldest first, parsed, skipping keys of neither kind", async () => {
    plant("upload-20261027T140205.123Z", "backup", "photos");
    plant("delete-20261027T140100.000Z", "cleanup");
    store.set("locks/", ""); // a console-made folder marker
    store.set("locks/README", "not a lock");

    const locks = await listLocks("b");

    assert.deepEqual(locks, [
      {
        id: "delete-20261027T140100.000Z",
        kind: "delete",
        command: "cleanup",
        set: undefined,
        by: "other@LAPTOP",
        started: "2026-10-27T14:02:05.123Z",
      },
      {
        id: "upload-20261027T140205.123Z",
        kind: "upload",
        command: "backup",
        set: "photos",
        by: "other@LAPTOP",
        started: "2026-10-27T14:02:05.123Z",
      },
    ]);
  });

  it("skips a lock that vanished between the LIST and its read — a run that just ended", async () => {
    plant("upload-20261027T140205.123Z", "backup", "photos");
    vanishOnGet = true;

    assert.deepEqual(await listLocks("b"), []);
  });

  it("removes a lock, and one already gone is not an error", async () => {
    plant("upload-20261027T140205.123Z", "backup");

    await removeLock("b", "upload-20261027T140205.123Z");
    await removeLock("b", "upload-20261027T140205.123Z");

    assert.deepEqual(lockKeys(), []);
  });

  it("describes a lock in plain words, with its id to name it by", async () => {
    plant("upload-20261027T140205.123Z", "backup", "photos");
    const [lock] = await listLocks("b");
    assert.ok(lock);

    const text = describeLock(lock);

    assert.match(
      text,
      /^backup of set 'photos' by other@LAPTOP, started 2026-10-27T14:02:05\.123Z \(.+ ago\) — upload-20261027T140205\.123Z$/,
    );
  });
});

describe("holdUploadLock", () => {
  it("writes its lock before it looks, keeps it through the work, removes it after — with the local file alongside", async () => {
    await using dir = await mkTmpDir();
    const set = setIn(dir.path);
    /** @type {string[]} */
    let duringWork = [];
    let fileDuringWork = "";

    const result = await holdUploadLock(
      { bucket: "b", command: "backup", set },
      async () => {
        duringWork = lockKeys();
        fileDuringWork = readFileSync(set.uploadLockPath, "utf8");
        return "done";
      },
    );

    assert.equal(result, "done");
    assert.equal(duringWork.length, 1, "the lock was held during the work");
    const id = String(duringWork[0]).slice("locks/".length);
    // Write first, look second: the PUT precedes the LIST.
    assert.deepEqual(requests, [
      `put:locks/${id}`,
      "list:locks/",
      `get:locks/${id}`,
      `delete:locks/${id}`,
    ]);
    // The local file held the bucket lock's id, and is gone with it.
    assert.equal(fileDuringWork, `${id}\n`);
    assert.deepEqual(lockKeys(), []);
    assert.ok(!existsSync(set.uploadLockPath));
  });

  it("writes no SET line for an upload with no set", async () => {
    let body = "";

    await holdUploadLock({ bucket: "b", command: "upload" }, async () => {
      body = String(store.get(String(lockKeys()[0])));
    });

    assert.match(body, /^COMMAND=upload\nBY=/);
    assert.deepEqual(lockKeys(), []);
  });

  it("refuses when a delete lock is in the bucket, removing its own lock first and never running the work", async () => {
    await using dir = await mkTmpDir();
    const set = setIn(dir.path);
    plant("delete-20261027T140100.000Z", "cleanup");
    let ran = false;

    await assert.rejects(
      holdUploadLock({ bucket: "b", command: "backup", set }, async () => {
        ran = true;
      }),
      (/** @type {Error} */ error) => {
        assert.match(
          error.message,
          /Can't back up right now — a cleanup or delete is running on bucket 'b'/,
        );
        assert.match(error.message, /cleanup by other@LAPTOP/);
        assert.match(error.message, /s3cab unlock --bucket b/);
        return true;
      },
    );

    assert.equal(ran, false);
    assert.deepEqual(lockKeys(), ["locks/delete-20261027T140100.000Z"]);
    assert.ok(!existsSync(set.uploadLockPath), "the local file went with it");
  });

  it("other upload locks are no obstacle — uploads don't exclude each other", async () => {
    plant("upload-20261027T140205.123Z", "backup", "docs");
    let ran = false;

    await holdUploadLock({ bucket: "b", command: "upload" }, async () => {
      ran = true;
    });

    assert.equal(ran, true);
  });

  it("removes its lock when the work fails, and the failure is the run's", async () => {
    await using dir = await mkTmpDir();
    const set = setIn(dir.path);

    await assert.rejects(
      holdUploadLock({ bucket: "b", command: "backup", set }, async () => {
        throw new Error("connection reset");
      }),
      /connection reset/,
    );

    assert.deepEqual(lockKeys(), []);
    assert.ok(!existsSync(set.uploadLockPath));
  });

  it("removes its lock when the LIST fails", async () => {
    listError = new Error("denied");

    await assert.rejects(
      holdUploadLock({ bucket: "b", command: "upload" }, async () => undefined),
      /denied/,
    );

    assert.deepEqual(lockKeys(), []);
  });

  it("when the lock's PUT fails, leaves the id it tried as the removal owed — the PUT may have landed", async () => {
    await using dir = await mkTmpDir();
    const set = setIn(dir.path);
    beforePut = () => {
      throw new Error("socket hang up");
    };

    await assert.rejects(
      holdUploadLock(
        { bucket: "b", command: "backup", set },
        async () => undefined,
      ),
      /socket hang up/,
    );

    assert.ok(!existsSync(set.uploadLockPath));
    assert.match(readFileSync(set.uploadUnlockPath, "utf8"), /^upload-\S+\n$/);
  });

  it("refuses a set whose .upload.lock exists — a run is live, or was killed — and says --resume", async () => {
    await using dir = await mkTmpDir();
    const set = setIn(dir.path);
    writeFileSync(set.uploadLockPath, "upload-20261027T140205.123Z\n");

    await assert.rejects(
      holdUploadLock(
        { bucket: "b", command: "backup", set },
        async () => undefined,
      ),
      /A backup or upload of set 'photos' is already running on this computer[\s\S]*--resume/,
    );

    assert.deepEqual(requests, [], "nothing touched the bucket");
    assert.ok(existsSync(set.uploadLockPath), "the file is never auto-broken");
  });

  it("--resume takes a leftover .upload.lock over: the bucket lock it names goes first", async () => {
    await using dir = await mkTmpDir();
    const set = setIn(dir.path);
    plant("upload-20261027T140205.123Z", "backup", "photos"); // the killed run's
    writeFileSync(set.uploadLockPath, "upload-20261027T140205.123Z\n");

    await holdUploadLock(
      { bucket: "b", command: "backup", set, resume: true },
      async () => undefined,
    );

    assert.equal(requests[0], "delete:locks/upload-20261027T140205.123Z");
    assert.deepEqual(lockKeys(), []);
    assert.ok(!existsSync(set.uploadLockPath));
  });

  it("pays the removal an earlier run left owed (.upload.unlock) before taking its own", async () => {
    await using dir = await mkTmpDir();
    const set = setIn(dir.path);
    plant("upload-20261027T140205.123Z", "backup", "photos"); // its removal failed
    writeFileSync(set.uploadUnlockPath, "upload-20261027T140205.123Z\n");

    await holdUploadLock(
      { bucket: "b", command: "backup", set },
      async () => undefined,
    );

    assert.equal(requests[0], "delete:locks/upload-20261027T140205.123Z");
    assert.deepEqual(lockKeys(), []);
    assert.ok(!existsSync(set.uploadUnlockPath));
  });

  it("leaves the owed removal for the next run when it fails again, and carries on", async () => {
    await using dir = await mkTmpDir();
    const set = setIn(dir.path);
    writeFileSync(set.uploadUnlockPath, "upload-20261027T140205.123Z\n");
    deleteError = new Error("denied");
    let ran = false;

    await holdUploadLock({ bucket: "b", command: "backup", set }, async () => {
      ran = true;
    });

    assert.equal(ran, true);
    assert.ok(existsSync(set.uploadUnlockPath), "still owed");
    assert.match(
      warnings[0] ?? "",
      /Couldn't remove the lock 'upload-20261027T140205.123Z' an earlier upload left/,
    );
  });

  it("when its own removal fails for a set, renames the file to .upload.unlock and says so", async () => {
    await using dir = await mkTmpDir();
    const set = setIn(dir.path);
    deleteError = new Error("denied");

    const result = await holdUploadLock(
      { bucket: "b", command: "backup", set },
      async () => "done",
    );

    assert.equal(result, "done", "the work's result still comes back");
    assert.equal(lockKeys().length, 1, "the lock is still in the bucket");
    const id = String(lockKeys()[0]).slice("locks/".length);
    assert.ok(!existsSync(set.uploadLockPath));
    assert.equal(readFileSync(set.uploadUnlockPath, "utf8"), `${id}\n`);
    assert.match(
      warnings.at(-1) ?? "",
      new RegExp(
        `The next backup or upload of set 'photos' will remove it[\\s\\S]*s3cab unlock --bucket b ${id}`,
      ),
    );
  });

  it("when its own removal fails with no set, the run fails naming the lock — nothing will clear it later", async () => {
    deleteError = new Error("denied");

    await assert.rejects(
      holdUploadLock({ bucket: "b", command: "upload" }, async () => "done"),
      (/** @type {Error} */ error) => {
        const id = String(lockKeys()[0]).slice("locks/".length);
        assert.match(
          error.message,
          /Finished, but couldn't remove this run's lock/,
        );
        assert.match(
          error.message,
          /every cleanup and delete of this bucket is refused/,
        );
        assert.match(
          error.message,
          new RegExp(`s3cab unlock --bucket b ${id}`),
        );
        return true;
      },
    );
  });

  it("never removes or renames a local file another run has since written", async () => {
    // The user deleted a live run's file and started a second upload; the
    // first run's end must not take the second's file with it.
    await using dir = await mkTmpDir();
    const set = setIn(dir.path);

    await holdUploadLock({ bucket: "b", command: "backup", set }, async () => {
      writeFileSync(set.uploadLockPath, "upload-SOMEONE-ELSES\n");
    });

    assert.equal(
      readFileSync(set.uploadLockPath, "utf8"),
      "upload-SOMEONE-ELSES\n",
    );
  });
});

describe("holdDeleteLock", () => {
  it("writes its lock before it looks, holds it through the work, removes it after", async () => {
    /** @type {string[]} */
    let duringWork = [];

    const result = await holdDeleteLock(
      { bucket: "b", command: "cleanup" },
      async () => {
        duringWork = lockKeys();
        return "done";
      },
    );

    assert.equal(result, "done");
    assert.equal(duringWork.length, 1);
    const id = String(duringWork[0]).slice("locks/".length);
    assert.match(id, /^delete-/);
    assert.deepEqual(requests, [
      `put:locks/${id}`,
      "list:locks/",
      `get:locks/${id}`,
      `delete:locks/${id}`,
    ]);
    assert.deepEqual(lockKeys(), []);
  });

  it("refuses when an upload lock is in the bucket, removing its own first, offering --wait", async () => {
    plant("upload-20261027T140205.123Z", "backup", "photos");
    let ran = false;

    await assert.rejects(
      holdDeleteLock({ bucket: "b", command: "cleanup" }, async () => {
        ran = true;
      }),
      (/** @type {Error} */ error) => {
        assert.match(
          error.message,
          /Can't clean up right now — a backup or upload is running on bucket 'b'/,
        );
        assert.match(error.message, /backup of set 'photos' by other@LAPTOP/);
        assert.match(error.message, /s3cab cleanup b --wait/);
        assert.match(error.message, /s3cab unlock --bucket b/);
        return true;
      },
    );

    assert.equal(ran, false);
    assert.deepEqual(lockKeys(), ["locks/upload-20261027T140205.123Z"]);
  });

  it("names delete's own --wait form", async () => {
    plant("upload-20261027T140205.123Z", "upload");

    await assert.rejects(
      holdDeleteLock({ bucket: "b", command: "delete" }, async () => undefined),
      /s3cab delete --bucket b --wait <hash>\.\.\./,
    );
  });

  it("other delete locks are no obstacle — deletes don't exclude each other", async () => {
    plant("delete-20261027T140100.000Z", "delete");
    let ran = false;

    await holdDeleteLock({ bucket: "b", command: "cleanup" }, async () => {
      ran = true;
    });

    assert.equal(ran, true);
  });

  it("--wait: holds no lock while waiting, says which uploads once, and goes once they are gone", async () => {
    plant("upload-20261027T140205.123Z", "backup", "photos");
    let ran = false;

    const held = holdDeleteLock(
      { bucket: "b", command: "cleanup", wait: true },
      async () => {
        ran = true;
      },
    );
    // The first look, its refusal, and the first sleep.
    await settle();
    assert.equal(ran, false);
    assert.deepEqual(
      lockKeys(),
      ["locks/upload-20261027T140205.123Z"],
      "its own lock is not held while it waits",
    );
    assert.equal(sleeps.length, 1);
    assert.equal(sleeps[0]?.ms, WAIT_MS);
    assert.equal(warnings.length, 1);
    assert.match(
      warnings[0] ?? "",
      /Waiting for 1 running upload to finish before cleaning up:\n {2}backup of set 'photos'/,
    );

    // Still there after a wait: no second message.
    sleeps[0]?.wake();
    await settle();
    assert.equal(sleeps.length, 2);
    assert.equal(warnings.length, 1);

    // The upload finishes; the next look goes through.
    store.delete("locks/upload-20261027T140205.123Z");
    sleeps[1]?.wake();
    await held;

    assert.equal(ran, true);
    assert.deepEqual(lockKeys(), []);
  });

  it("--wait says so again when the set of uploads changes", async () => {
    plant("upload-20261027T140205.123Z", "backup", "photos");

    const held = holdDeleteLock(
      { bucket: "b", command: "cleanup", wait: true },
      async () => undefined,
    );
    await settle();
    plant("upload-20261027T140900.000Z", "upload", "docs");
    sleeps[0]?.wake();
    await settle();
    assert.equal(warnings.length, 2);
    assert.match(warnings[1] ?? "", /2 running uploads/);

    store.delete("locks/upload-20261027T140205.123Z");
    store.delete("locks/upload-20261027T140900.000Z");
    sleeps[1]?.wake();
    await held;
  });

  it("removes its lock when the work fails", async () => {
    await assert.rejects(
      holdDeleteLock({ bucket: "b", command: "delete" }, async () => {
        throw new Error("boom");
      }),
      /boom/,
    );
    assert.deepEqual(lockKeys(), []);
  });

  it("fails naming the lock when its removal fails after the work — nothing will clear it later", async () => {
    deleteError = new Error("denied");

    await assert.rejects(
      holdDeleteLock({ bucket: "b", command: "cleanup" }, async () => "done"),
      /Finished, but couldn't remove this run's lock[\s\S]*every backup and upload of this bucket is refused[\s\S]*s3cab unlock --bucket b delete-/,
    );
  });
});
