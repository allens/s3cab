import assert from "node:assert/strict";
import { readlinkSync } from "node:fs";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import { s3Seam } from "../../test/helpers/s3-seam.mjs";

// The bucket locks (ADR-0112) over an in-memory bucket at the s3.mjs seam —
// a keyed text store whose no-overwrite PUT really refuses a taken key — so
// every rule here is proved by the requests the bucket sees, in order: write
// first, look second; the own lock removed before a refusal; a dead run's
// lock from this machine swept on the way in, judged by `process.kill(pid, 0)`
// at a mocked `process.kill`. Mocks first, then a dynamic import
// (objects.test.mjs rule).

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
/** How many GETs were in flight at once, at most. */
let getsInFlight = 0;
let mostGetsInFlight = 0;

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
      getsInFlight++;
      mostGetsInFlight = Math.max(mostGetsInFlight, getsInFlight);
      await new Promise((resolve) => setImmediate(resolve));
      getsInFlight--;
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
// The wait between looks is a real half minute; here each such sleep parks
// until the test wakes it, so a test steps the wait loop by hand. A retry's
// millisecond really passes: the fresh lock id is the clock's next instant,
// and waking at once would mint the same id again.
mock.module("node:timers/promises", {
  exports: {
    setTimeout: (/** @type {number} */ ms) =>
      new Promise((resolve) => {
        const wake = () => resolve(undefined);
        sleeps.push({ ms, wake });
        if (ms < 1000) {
          setTimeout(wake, ms);
        }
      }),
  },
});
/** Let the run reach its next sleep, or finish. */
const settle = () =>
  new Promise((resolve) => setTimeout(resolve, 0)).then(
    () => new Promise((resolve) => setImmediate(resolve)),
  );

const {
  WAIT_MS,
  describeLock,
  holdDeleteLock,
  holdUploadLock,
  listLocks,
  removeLock,
  writeLock,
} = await import("./locks.mjs");

/** Pids `process.kill(pid, 0)` reports gone. @type {Set<number>} */
let deadPids = new Set();

/** This process's pid namespace, as a lock written here carries it: Linux only. */
const HERE_PIDNS =
  process.platform === "linux" ? readlinkSync("/proc/self/ns/pid") : undefined;
const PIDNS_LINE = HERE_PIDNS === undefined ? "" : `PIDNS=${HERE_PIDNS}\n`;

/** A lock another run holds, planted straight into the bucket. */
const plant = (
  /** @type {string} */ id,
  /** @type {string} */ command,
  /** @type {string | undefined} */ set = undefined,
  /** @type {{ by?: string, os?: string, pidns?: string, pid?: number }} */ {
    by,
    os,
    pidns,
    pid,
  } = {},
) =>
  store.set(
    `locks/${id}`,
    `COMMAND=${command}\n${set ? `SET=${set}\n` : ""}BY=${by ?? "other@LAPTOP"}\n` +
      `OS=${os ?? process.platform}\n` +
      (pidns === undefined ? PIDNS_LINE : `PIDNS=${pidns}\n`) +
      `PID=${pid ?? 4242}\nSTARTED=2026-10-27T14:02:05.123Z\n`,
  );

const lockKeys = () => [...store.keys()].filter((k) => k.startsWith("locks/"));

/** @type {string[]} */
let warnings = [];
/** @type {ReturnType<typeof mock.method>} */
let warn;
/** @type {ReturnType<typeof mock.method>} */
let kill;
beforeEach(() => {
  store = new Map();
  requests = [];
  beforePut = () => {};
  firstPutLandsUnseen = false;
  vanishOnGet = false;
  deleteError = undefined;
  listError = undefined;
  getsInFlight = 0;
  mostGetsInFlight = 0;
  sleeps = [];
  deadPids = new Set();
  warnings = [];
  warn = mock.method(console, "warn", (/** @type {string} */ m) =>
    warnings.push(m),
  );
  kill = mock.method(
    process,
    "kill",
    (/** @type {number} */ pid, /** @type {string | number} */ signal) => {
      assert.equal(signal, 0, "liveness is asked with signal 0, never sent");
      if (deadPids.has(pid)) {
        throw Object.assign(new Error("kill ESRCH"), { code: "ESRCH" });
      }
      return true;
    },
  );
});
afterEach(() => {
  warn.mock.restore();
  kill.mock.restore();
});

describe("writeLock", () => {
  it("writes locks/<kind>-<instant> with the run's command, set, machine, pid and start", async () => {
    const lock = await writeLock("b", {
      kind: "upload",
      command: "backup",
      set: "photos",
    });

    assert.match(lock.id, /^upload-\d{8}T\d{6}\.\d{3}Z$/);
    assert.deepEqual(lockKeys(), [`locks/${lock.id}`]);
    assert.equal(
      store.get(`locks/${lock.id}`),
      `COMMAND=backup\nSET=photos\nBY=allen@DESKTOP\nOS=${process.platform}\n${PIDNS_LINE}PID=${process.pid}\nSTARTED=${lock.started}\n`,
    );
    assert.equal(lock.os, process.platform);
    assert.equal(lock.pid, process.pid);
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

  it("mints a fresh instant, a millisecond on, when the 412 was someone else's lock", async () => {
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
    assert.deepEqual(
      sleeps.map(({ ms }) => ms),
      [1],
      "it waited for the clock to move, not for a derived id",
    );
  });
});

describe("listLocks, removeLock, describeLock", () => {
  it("lists every lock oldest first whatever its kind, parsed, skipping keys of neither kind", async () => {
    plant("upload-20261027T140205.123Z", "backup", "photos");
    plant("delete-20261027T140900.000Z", "cleanup");
    plant("upload-20261027T140100.000Z", "upload");
    store.set("locks/", ""); // a console-made folder marker
    store.set("locks/README", "not a lock");

    const locks = await listLocks("b");

    assert.deepEqual(
      locks.map(({ id }) => id),
      [
        "upload-20261027T140100.000Z",
        "upload-20261027T140205.123Z",
        "delete-20261027T140900.000Z",
      ],
      "by instant, not by kind-then-instant",
    );
    assert.deepEqual(locks[1], {
      id: "upload-20261027T140205.123Z",
      kind: "upload",
      command: "backup",
      set: "photos",
      by: "other@LAPTOP",
      os: process.platform,
      pidns: HERE_PIDNS,
      pid: 4242,
      started: "2026-10-27T14:02:05.123Z",
    });
    assert.equal(mostGetsInFlight, 3, "the bodies are fetched at once");
  });

  it("reads a lock with no PID line, or a bad one, as a lock with no pid", async () => {
    store.set(
      "locks/upload-20261027T140205.123Z",
      "COMMAND=backup\nBY=other@LAPTOP\nSTARTED=2026-10-27T14:02:05.123Z\n",
    );
    store.set(
      "locks/upload-20261027T140300.000Z",
      "COMMAND=backup\nBY=other@LAPTOP\nPID=soon\nSTARTED=2026-10-27T14:03:00.000Z\n",
    );

    const locks = await listLocks("b");

    assert.deepEqual(
      locks.map(({ pid }) => pid),
      [undefined, undefined],
    );
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
      /^backup of set 'photos' by other@LAPTOP \(pid 4242\), started 2026-10-27T14:02:05\.123Z \(.+ ago\) — upload-20261027T140205\.123Z$/,
    );
  });
});

describe("holdUploadLock", () => {
  it("writes its lock before it looks, keeps it through the work, removes it after", async () => {
    /** @type {string[]} */
    let duringWork = [];

    const result = await holdUploadLock(
      { bucket: "b", command: "backup", set: "photos" },
      async () => {
        duringWork = lockKeys();
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
    assert.deepEqual(lockKeys(), []);
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
    plant("delete-20261027T140100.000Z", "cleanup");
    let ran = false;

    await assert.rejects(
      holdUploadLock(
        { bucket: "b", command: "backup", set: "photos" },
        async () => {
          ran = true;
        },
      ),
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
    await assert.rejects(
      holdUploadLock(
        { bucket: "b", command: "backup", set: "photos" },
        async () => {
          throw new Error("connection reset");
        },
      ),
      /connection reset/,
    );

    assert.deepEqual(lockKeys(), []);
  });

  it("removes its lock when the LIST fails", async () => {
    listError = new Error("denied");

    await assert.rejects(
      holdUploadLock({ bucket: "b", command: "upload" }, async () => undefined),
      /denied/,
    );

    assert.deepEqual(lockKeys(), []);
  });

  it("when its removal fails after the work, says so with the unlock command and still returns the result", async () => {
    deleteError = new Error("denied");

    const result = await holdUploadLock(
      { bucket: "b", command: "backup", set: "photos" },
      async () => "done",
    );

    assert.equal(result, "done", "the work's result still comes back");
    assert.equal(lockKeys().length, 1, "the lock is still in the bucket");
    const id = String(lockKeys()[0]).slice("locks/".length);
    assert.match(
      warnings.at(-1) ?? "",
      new RegExp(
        `Couldn't remove this run's lock from bucket 'b' \\(denied\\)\\. Until it goes, every cleanup and delete of the bucket is refused\\. The next backup, upload, cleanup or delete on this same system should remove it, once it can tell this run has stopped; to remove it yourself:\\n {2}s3cab unlock --bucket b ${id}`,
      ),
    );
  });

  describe("a leftover from this machine", () => {
    it("is removed on the way in when its process is gone, and said so", async () => {
      plant("delete-20261027T140100.000Z", "cleanup", undefined, {
        by: "allen@DESKTOP",
        pid: 31337,
      });
      deadPids.add(31337);
      let ran = false;

      await holdUploadLock({ bucket: "b", command: "backup" }, async () => {
        ran = true;
      });

      assert.equal(ran, true, "the dead delete lock no longer refuses");
      assert.deepEqual(lockKeys(), []);
      assert.equal(warnings.length, 1);
      assert.match(
        warnings[0] ?? "",
        /^Removed the lock a stopped run left in bucket 'b': cleanup by allen@DESKTOP \(pid 31337\), started 2026-10-27T14:02:05\.123Z \(.+ ago\) — delete-20261027T140100\.000Z$/,
      );
    });

    it("is kept when its process is alive — the run is still going", async () => {
      plant("delete-20261027T140100.000Z", "cleanup", undefined, {
        by: "allen@DESKTOP",
        pid: 31337,
      });

      await assert.rejects(
        holdUploadLock(
          { bucket: "b", command: "backup" },
          async () => undefined,
        ),
        /a cleanup or delete is running/,
      );

      assert.deepEqual(lockKeys(), ["locks/delete-20261027T140100.000Z"]);
      assert.deepEqual(warnings, []);
    });

    it("is kept when another user's process holds it (EPERM is alive)", async () => {
      plant("delete-20261027T140100.000Z", "cleanup", undefined, {
        by: "allen@DESKTOP",
        pid: 31337,
      });
      kill.mock.mockImplementation(() => {
        throw Object.assign(new Error("kill EPERM"), { code: "EPERM" });
      });

      await assert.rejects(
        holdUploadLock(
          { bucket: "b", command: "backup" },
          async () => undefined,
        ),
        /a cleanup or delete is running/,
      );

      assert.deepEqual(lockKeys(), ["locks/delete-20261027T140100.000Z"]);
    });

    it("from another OS is kept: WSL shares the machine's name, not its process table", async () => {
      plant("delete-20261027T140100.000Z", "cleanup", undefined, {
        by: "allen@DESKTOP",
        os: process.platform === "linux" ? "win32" : "linux",
        pid: 31337,
      });
      deadPids.add(31337);

      await assert.rejects(
        holdUploadLock(
          { bucket: "b", command: "backup" },
          async () => undefined,
        ),
        /a cleanup or delete is running/,
      );

      assert.deepEqual(lockKeys(), ["locks/delete-20261027T140100.000Z"]);
      assert.ok(
        kill.mock.calls.every(({ arguments: [pid] }) => pid !== 31337),
        "the OS was never asked about it",
      );
    });

    it("from another pid namespace is kept: a second WSL distro or a container, same name and OS", async () => {
      plant("delete-20261027T140100.000Z", "cleanup", undefined, {
        by: "allen@DESKTOP",
        pidns: "pid:[1]",
        pid: 31337,
      });
      deadPids.add(31337);

      await assert.rejects(
        holdUploadLock(
          { bucket: "b", command: "backup" },
          async () => undefined,
        ),
        /a cleanup or delete is running/,
      );

      assert.deepEqual(lockKeys(), ["locks/delete-20261027T140100.000Z"]);
      assert.ok(
        kill.mock.calls.every(({ arguments: [pid] }) => pid !== 31337),
        "the OS was never asked about it",
      );
    });

    it("with no OS is kept: a lock that can't say whose process table it means is never judged", async () => {
      store.set(
        "locks/delete-20261027T140100.000Z",
        "COMMAND=cleanup\nBY=allen@DESKTOP\nPID=31337\nSTARTED=2026-10-27T14:02:05.123Z\n",
      );
      deadPids.add(31337);

      await assert.rejects(
        holdUploadLock(
          { bucket: "b", command: "backup" },
          async () => undefined,
        ),
        /a cleanup or delete is running/,
      );

      assert.deepEqual(lockKeys(), ["locks/delete-20261027T140100.000Z"]);
    });

    it("with no pid is kept: a hand-made lock is a person's to remove", async () => {
      store.set(
        "locks/delete-20261027T140100.000Z",
        `COMMAND=cleanup\nBY=allen@DESKTOP\nOS=${process.platform}\n${PIDNS_LINE}STARTED=2026-10-27T14:02:05.123Z\n`,
      );

      await assert.rejects(
        holdUploadLock(
          { bucket: "b", command: "backup" },
          async () => undefined,
        ),
        /a cleanup or delete is running/,
      );

      assert.deepEqual(lockKeys(), ["locks/delete-20261027T140100.000Z"]);
    });
  });

  it("another machine's lock is never judged, whatever its pid says here", async () => {
    plant("delete-20261027T140100.000Z", "cleanup", undefined, {
      by: "other@LAPTOP",
      pid: 31337,
    });
    deadPids.add(31337);

    await assert.rejects(
      holdUploadLock({ bucket: "b", command: "backup" }, async () => undefined),
      /a cleanup or delete is running/,
    );

    assert.deepEqual(lockKeys(), ["locks/delete-20261027T140100.000Z"]);
    assert.ok(
      kill.mock.calls.every(({ arguments: [pid] }) => pid !== 31337),
      "the OS was never asked about it",
    );
  });

  it("takes no interrupt handler: Ctrl+C mid-work must not remove the lock under requests in flight", async () => {
    const before = process.listenerCount("SIGINT");

    await holdUploadLock({ bucket: "b", command: "upload" }, async () => {
      assert.equal(process.listenerCount("SIGINT"), before);
    });
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
        assert.match(
          error.message,
          /run the same command again with --wait to let this run wait for it/,
        );
        assert.match(error.message, /s3cab unlock --bucket b/);
        return true;
      },
    );

    assert.equal(ran, false);
    assert.deepEqual(lockKeys(), ["locks/upload-20261027T140205.123Z"]);
  });

  it("frames delete's refusal by its own goal", async () => {
    plant("upload-20261027T140205.123Z", "upload");

    await assert.rejects(
      holdDeleteLock({ bucket: "b", command: "delete" }, async () => undefined),
      /Can't delete right now — a backup or upload is running on bucket 'b', and deleting while it runs/,
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

  it("sweeps a dead upload lock from this machine instead of refusing on it", async () => {
    plant("upload-20261027T140205.123Z", "backup", "photos", {
      by: "allen@DESKTOP",
      pid: 31337,
    });
    deadPids.add(31337);
    let ran = false;

    await holdDeleteLock({ bucket: "b", command: "cleanup" }, async () => {
      ran = true;
    });

    assert.equal(ran, true);
    assert.deepEqual(lockKeys(), []);
    assert.match(
      warnings[0] ?? "",
      /^Removed the lock a stopped run left in bucket 'b': backup of set 'photos' by allen@DESKTOP/,
    );
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

  it("when its removal fails after the work, says so and still returns the result", async () => {
    deleteError = new Error("denied");

    const result = await holdDeleteLock(
      { bucket: "b", command: "cleanup" },
      async () => "done",
    );

    assert.equal(result, "done");
    assert.match(
      warnings.at(-1) ?? "",
      /Couldn't remove this run's lock from bucket 'b' \(denied\)[\s\S]*every backup and upload of the bucket is refused[\s\S]*s3cab unlock --bucket b delete-/,
    );
  });
});
