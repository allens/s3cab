import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, mock } from "node:test";

/** @import { Lock } from "../lib/locks.mjs" */

// Offline tests for `unlock`'s command shell (ADR-0112): the gates (`--force`
// needs ids; no terminal needs `--force` or `-n`), the listing, the prompt,
// and that it removes exactly the locks it showed. The lock store is faked at
// the lib seam. Mocks first, then a dynamic import.

/** @type {Lock[]} what the bucket holds */
let locks = [];
/** @type {string[]} */
let removed = [];
let promptAnswer = false;
let promptCalls = 0;

const lock = (
  /** @type {string} */ id,
  /** @type {Partial<Lock>} */ rest = {},
) => ({
  id,
  kind: /** @type {Lock["kind"]} */ (
    id.startsWith("upload-") ? "upload" : "delete"
  ),
  command: "backup",
  by: "other@LAPTOP",
  started: "2026-10-27T14:02:05.123Z",
  ...rest,
});

mock.module("../lib/locks.mjs", {
  exports: {
    listLocks: async () => locks,
    removeLock: async (/** @type {string} */ _b, /** @type {string} */ id) => {
      removed.push(id);
    },
    describeLock: (/** @type {Lock} */ l) => `${l.command} — ${l.id}`,
  },
});
mock.module("../lib/prompt.mjs", {
  exports: {
    promptYesNo: async () => {
      promptCalls++;
      return promptAnswer;
    },
  },
});

const { unlock } = await import("./unlock.mjs");

/** @type {boolean | undefined} */
let savedTTY;
/** @type {number | string | null | undefined} */
let savedExitCode;
const stdin = /** @type {{ isTTY?: boolean }} */ (process.stdin);
/** @type {string[]} */
let warnings = [];
/** @type {string[]} */
let lines = [];
/** @type {ReturnType<typeof mock.method>} */
let warn;
/** @type {ReturnType<typeof mock.method>} */
let log;
beforeEach(() => {
  savedTTY = stdin.isTTY;
  savedExitCode = process.exitCode;
  stdin.isTTY = true;
  locks = [lock("upload-20261027T140205.123Z", { set: "photos" })];
  removed = [];
  promptAnswer = false;
  promptCalls = 0;
  warnings = [];
  lines = [];
  warn = mock.method(console, "warn", (/** @type {string} */ m) =>
    warnings.push(m),
  );
  log = mock.method(console, "log", (/** @type {string} */ m) => lines.push(m));
});
afterEach(() => {
  stdin.isTTY = savedTTY;
  process.exitCode = savedExitCode;
  warn.mock.restore();
  log.mock.restore();
});

describe("unlock", () => {
  it("requires --bucket", async () => {
    await assert.rejects(
      () => unlock([], {}),
      /Missing required argument: bucket/,
    );
  });

  it("--force without ids is refused — nothing removes a lock nobody looked at", async () => {
    await assert.rejects(
      () => unlock([], { bucket: "b", force: true }),
      /--force removes locks without showing them first[\s\S]*s3cab unlock --bucket b/,
    );
    assert.deepEqual(removed, []);
  });

  it("without a terminal it needs --force and ids, or -n", async () => {
    stdin.isTTY = false;

    await assert.rejects(
      () => unlock([], { bucket: "b" }),
      /no terminal to ask on[\s\S]*--dry-run[\s\S]*--force <id>/,
    );
    assert.deepEqual(removed, []);
  });

  it("lists every lock in plain words and removes them all once the user says yes", async () => {
    locks.push(lock("delete-20261027T140900.000Z", { command: "cleanup" }));
    promptAnswer = true;

    const result = await unlock([], { bucket: "b" });

    assert.deepEqual(lines, [
      "2 locks in bucket 'b':\n" +
        "  backup — upload-20261027T140205.123Z\n" +
        "  cleanup — delete-20261027T140900.000Z",
    ]);
    assert.equal(promptCalls, 1);
    assert.deepEqual(removed, [
      "upload-20261027T140205.123Z",
      "delete-20261027T140900.000Z",
    ]);
    assert.equal(result.removed, true);
    assert.equal(result.locks.length, 2);
  });

  it("removes nothing when the user declines", async () => {
    promptAnswer = false;

    const result = await unlock([], { bucket: "b" });

    assert.deepEqual(removed, []);
    assert.equal(result.removed, false);
    assert.ok(warnings.includes("Cancelled — nothing was removed."));
  });

  it("ids narrow the listing to the locks named", async () => {
    locks.push(lock("delete-20261027T140900.000Z", { command: "cleanup" }));
    promptAnswer = true;

    const result = await unlock(["delete-20261027T140900.000Z"], {
      bucket: "b",
    });

    assert.match(lines[0] ?? "", /^1 lock in bucket 'b':\n {2}cleanup/);
    assert.deepEqual(removed, ["delete-20261027T140900.000Z"]);
    assert.deepEqual(result.unknown, []);
  });

  it("-n shows the listing and removes nothing, with no prompt — and needs no terminal", async () => {
    stdin.isTTY = false;

    const result = await unlock([], { bucket: "b", "dry-run": true });

    assert.equal(lines.length, 1);
    assert.equal(promptCalls, 0);
    assert.deepEqual(removed, []);
    assert.equal(result.removed, false);
    assert.ok(warnings.includes("Dry run — nothing removed."));
  });

  it("--force with ids removes them without asking", async () => {
    stdin.isTTY = false;

    const result = await unlock(["upload-20261027T140205.123Z"], {
      bucket: "b",
      force: true,
    });

    assert.equal(promptCalls, 0);
    assert.deepEqual(removed, ["upload-20261027T140205.123Z"]);
    assert.equal(result.removed, true);
  });

  it("an id that names no lock is reported, the others are still removed, and the run exits 1", async () => {
    process.exitCode = 0;

    const result = await unlock(
      ["upload-20261027T140205.123Z", "delete-20990101T000000.000Z"],
      { bucket: "b", force: true },
    );

    assert.deepEqual(removed, ["upload-20261027T140205.123Z"]);
    assert.deepEqual(result.unknown, ["delete-20990101T000000.000Z"]);
    assert.match(
      warnings[0] ?? "",
      /No lock named this in bucket 'b' — already removed, or mistyped:\n {2}delete-20990101T000000\.000Z/,
    );
    assert.equal(process.exitCode, 1);
  });

  it("says so when the bucket holds no locks", async () => {
    locks = [];

    const result = await unlock([], { bucket: "b" });

    assert.ok(
      warnings.some((w) =>
        /No locks in bucket 'b' — nothing is running/.test(w),
      ),
    );
    assert.equal(promptCalls, 0);
    assert.deepEqual(result.locks, []);
  });
});
