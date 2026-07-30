import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it, mock } from "node:test";

/** @import { ReferencedResult } from "../lib/verify.mjs" */

// Offline tests for the `delete` *command shell* — the policy wrapped around
// the pure plan (which lib/delete.test.mjs pins): the non-interactive gate,
// the participating-set discovery, the unreadable-snapshot interlock, the
// no-match error, the preview file, the typed-bucket-name confirmation, and —
// most load-bearing — the record-FIRST-then-delete ordering. Every S3/prompt
// seam is faked at the lib boundary (docs/design/testing.md). Module-mock
// ordering (objects.test.mjs) applies: mocks first, dynamic import.

/** @type {Map<string, ReferencedResult>} */
let referencedBySet = new Map();
/** How many times the whole-bucket scan ran — the single-pass evidence. */
let scans = 0;
/** @type {{ name: string, bucket: string }[]} the machine's local sets */
let localSets = [];
/** @type {Set<string>} set names whose directory reads as corrupt */
let failingSets = new Set();
/** @type {string[]} every side-effect, in order: "record" then "delete:<hash>" */
let effects = [];
/** @type {string | undefined} what the prompt answers (undefined = no TTY expected) */
let promptAnswer;
let promptCalls = 0;

mock.module("../lib/remote.mjs", {
  exports: {
    referencedObjects: async () => {
      scans++;
      return referencedBySet;
    },
  },
});
mock.module("../lib/sets.mjs", {
  exports: {
    listSets: () => localSets.map((s) => s.name),
    readSet: (/** @type {string} */ name) => {
      if (failingSets.has(name)) {
        throw new Error(`corrupt set directory: ${name}`);
      }
      const set = localSets.find((s) => s.name === name);
      if (!set) {
        throw new Error(`Unknown backup set: ${name}`);
      }
      return set;
    },
    validateBucketName: () => {},
  },
});
mock.module("../lib/objects.mjs", {
  exports: {
    deleteStoredObject: async (
      /** @type {string} */ _bucket,
      /** @type {string} */ hash,
    ) => {
      effects.push(`delete:${hash}`);
    },
  },
});
mock.module("../lib/deletion-record.mjs", {
  exports: {
    deletionRecordMoment: () => ({
      name: "2026-07-19T1422",
      instant: "2026-07-19T13:22:04.881Z",
      zone: "Europe/London",
    }),
    formatDeletionRecord: (
      /** @type {{ bucket: string }} */ context,
      /** @type {{ hash: string, path: string }[]} */ rows,
    ) => `# record for ${context.bucket}: ${rows.length} row(s)\n`,
    writeDeletionRecord: async (
      /** @type {string} */ bucket,
      /** @type {string} */ name,
    ) => {
      effects.push("record");
      return `s3://${bucket}/deletions/${name}.tsv`;
    },
  },
});
mock.module("../lib/prompt.mjs", {
  exports: {
    promptLine: async () => {
      promptCalls++;
      assert.notEqual(promptAnswer, undefined, "unexpected prompt");
      return /** @type {string} */ (promptAnswer);
    },
  },
});

// The preview file needs a real, isolated home directory.
/** @type {string} */
let home;
mock.module("../lib/home.mjs", {
  exports: { s3cabDir: () => home },
});

const { deletePaths } = await import("./delete.mjs");

/**
 * A ReferencedResult from `{ hash: [path, ...] }`, every path at size 10.
 * @param {Record<string, string[]>} spec
 * @param {{ snapshot: string, reason: string }[]} [unreadable]
 * @returns {ReferencedResult}
 */
const ref = (spec, unreadable = []) => ({
  referenced: new Map(
    Object.entries(spec).map(([hash, paths]) => [
      hash,
      {
        paths: new Map(
          paths.map((path) => [
            path,
            { sizes: new Set([10]), snapshots: new Set(["s1"]) },
          ]),
        ),
      },
    ]),
  ),
  snapshotsChecked: 1,
  unreadable,
});

/** @type {boolean | undefined} */
let savedTTY;
const stdin = /** @type {{ isTTY?: boolean }} */ (process.stdin);
beforeEach(() => {
  savedTTY = stdin.isTTY;
  stdin.isTTY = false;
  referencedBySet = new Map();
  scans = 0;
  localSets = [{ name: "mine", bucket: "b" }];
  failingSets = new Set();
  effects = [];
  promptAnswer = undefined;
  promptCalls = 0;
  home = mkdtempSync(join(tmpdir(), "s3cab-delete-"));
});
afterEach(() => {
  stdin.isTTY = savedTTY;
  rmSync(home, { recursive: true, force: true });
});

describe("delete command", () => {
  it("requires a bucket and at least one path", async () => {
    await assert.rejects(
      () => deletePaths(["/data"]),
      /Missing required argument: bucket/,
    );
    await assert.rejects(
      () => deletePaths([], { bucket: "b" }),
      /Missing required argument: path/,
    );
  });

  it("refuses a non-interactive run without --force, before paying for the scan", async () => {
    await assert.rejects(
      () => deletePaths(["/data"], { bucket: "b" }),
      /no terminal to ask on[\s\S]*--dry-run[\s\S]*--force/,
    );
    assert.equal(scans, 0); // fails in milliseconds, not minutes in
  });

  it("errors when no set on this machine uses the bucket", async () => {
    localSets = [{ name: "other", bucket: "elsewhere" }];
    await assert.rejects(
      () => deletePaths(["/data"], { bucket: "b", force: true }),
      /No backup sets on this machine use bucket 'b'[\s\S]*s3cab reattach/,
    );
    assert.equal(scans, 0);
  });

  it("skips an unreadable local set directory — scope narrows, never widens", async () => {
    localSets = [
      { name: "mine", bucket: "b" },
      { name: "broken", bucket: "b" },
    ];
    failingSets = new Set(["broken"]);
    referencedBySet.set("mine", ref({ aaa: ["/data/x.txt"] }));
    // The broken set drops OUT of scope, so its reference — even under the
    // named path — turns into an outside protector: less gets deleted, never
    // more (the fail-safe direction).
    referencedBySet.set("broken", ref({ aaa: ["/data/x.txt"] }));
    const result = await deletePaths(["/data"], { bucket: "b", force: true });
    assert.deepEqual(result.sets, ["mine"]);
    assert.equal(result.deleted, false); // the broken set's reference protected it
    assert.equal(result.survivors, 1);
    assert.deepEqual(effects, []);
  });

  it("aborts an acting run on an unreadable snapshot — --force does not lift the interlock", async () => {
    referencedBySet.set(
      "mine",
      ref({ aaa: ["/data/x.txt"] }, [{ snapshot: "s0", reason: "zstd" }]),
    );
    await assert.rejects(
      () => deletePaths(["/data"], { bucket: "b", force: true }),
      /Can't delete safely[\s\S]*mine\/s0[\s\S]*s3cab verify b/,
    );
    assert.deepEqual(effects, []);
  });

  it("lets a dry run proceed past unreadable snapshots (preview only, caveated)", async () => {
    referencedBySet.set(
      "mine",
      ref({ aaa: ["/data/x.txt"] }, [{ snapshot: "s0", reason: "zstd" }]),
    );
    const result = await deletePaths(["/data"], {
      bucket: "b",
      "dry-run": true,
    });
    assert.equal(result.deleted, false);
    assert.deepEqual(effects, []);
  });

  it("errors loudly when a named path matches nothing backed up", async () => {
    referencedBySet.set("mine", ref({ aaa: ["/data/x.txt"] }));
    await assert.rejects(
      () =>
        deletePaths(["/data", "2026-07-19T1422"], { bucket: "b", force: true }),
      /matches\s+no backed-up file in set 'mine'[\s\S]*2026-07-19T1422[\s\S]*s3cab tree/,
    );
    assert.deepEqual(effects, []);
  });

  it("dry run writes the preview file and record/deletes nothing", async () => {
    referencedBySet.set("mine", ref({ aaa: ["/data/x.txt"] }));
    const result = await deletePaths(["/data"], {
      bucket: "b",
      "dry-run": true,
    });
    assert.equal(result.deleted, false);
    assert.equal(result.deletedObjects, 1); // what WOULD go
    assert.deepEqual(effects, []);
    const preview = readFileSync(join(home, "delete-preview.txt"), "utf8");
    assert.match(preview, /^# PREVIEW — nothing has been deleted/);
    assert.match(preview, /# record for b: 1 row\(s\)/);
  });

  it("on a TTY, only the exact bucket name typed back proceeds", async () => {
    stdin.isTTY = true;
    referencedBySet.set("mine", ref({ aaa: ["/data/x.txt"] }));
    promptAnswer = "B"; // close is not correct
    const declined = await deletePaths(["/data"], { bucket: "b" });
    assert.equal(declined.deleted, false);
    assert.equal(promptCalls, 1);
    assert.deepEqual(effects, []);

    promptAnswer = "b";
    const confirmed = await deletePaths(["/data"], { bucket: "b" });
    assert.equal(confirmed.deleted, true);
    assert.equal(confirmed.record, "s3://b/deletions/2026-07-19T1422.tsv");
  });

  it("writes the record BEFORE deleting any object, and deletes the whole plan", async () => {
    referencedBySet.set(
      "mine",
      ref({ aaa: ["/data/x.txt"], bbb: ["/data/y.txt"] }),
    );
    const result = await deletePaths(["/data"], { bucket: "b", force: true });
    assert.equal(result.deleted, true);
    // Record-first is the crash-safety invariant: a run that dies mid-delete
    // must leave every missing object explained.
    assert.deepEqual(effects, ["record", "delete:aaa", "delete:bbb"]);
    assert.equal(scans, 1); // single-pass: one scan covered preview + act
  });

  it("--force on a TTY skips the prompt but not the scan or the record", async () => {
    stdin.isTTY = true;
    referencedBySet.set("mine", ref({ aaa: ["/data/x.txt"] }));
    const result = await deletePaths(["/data"], { bucket: "b", force: true });
    assert.equal(result.deleted, true);
    assert.equal(promptCalls, 0);
    assert.deepEqual(effects, ["record", "delete:aaa"]);
  });

  it("does not prompt or write a record when nothing is deletable", async () => {
    stdin.isTTY = true;
    referencedBySet.set("mine", ref({ aaa: ["/data/x.txt"] }));
    referencedBySet.set("theirs", ref({ aaa: ["/other/copy.txt"] }));
    const result = await deletePaths(["/data"], { bucket: "b" });
    assert.equal(result.deleted, false);
    assert.equal(result.survivors, 1);
    assert.equal(promptCalls, 0);
    assert.deepEqual(effects, []);
  });

  it("--everywhere deletes past outside references and reports them", async () => {
    referencedBySet.set("mine", ref({ aaa: ["/data/secret.env"] }));
    referencedBySet.set("theirs", ref({ aaa: ["/other/copy.env"] }));
    const result = await deletePaths(["/data"], {
      bucket: "b",
      force: true,
      everywhere: true,
    });
    assert.equal(result.deleted, true);
    assert.equal(result.everywhere, true);
    assert.deepEqual(effects, ["record", "delete:aaa"]);
  });
});
