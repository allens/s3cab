import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it, mock } from "node:test";

import { enumeration } from "../../test/helpers/enumeration.mjs";
import { useTempHome } from "../../test/helpers/temp-home.mjs";

/** @import { RecordedDeletion } from "../lib/deletion-record.mjs" */
/** @import { ReferencedResult } from "../lib/referenced.mjs" */

// Offline tests for `forget`: the S3 reads/writes (listRemoteSnapshots,
// deleteRemoteSnapshot, referencedObjects, readDeletionRecords, storedObjectSizes),
// the set resolver (loadSet), and the prompt are faked at the lib seam, and the
// TTY gate is driven via process.stdin.isTTY — so the required-arg guards, the
// existence check, the unrestorable check's wiring, the non-interactive `--force`
// gate, and the confirm/skip logic are locked down without a bucket or a
// terminal. The orphan *computation* is tested pure in lib/unrestorable.test.mjs;
// what's asserted here is the command's part — that the check runs, the report
// lands on disk, and --force skips both halves (ADR-0064's destructive-command
// pattern). The real removal is covered by test/integration/remote.test.mjs's
// gated round-trip. Mocks first, then a dynamic import.

/** @type {{ name: string, bucket: string, dir: string }} */
let fakeSet = { name: "photos", bucket: "b1", dir: "" };
/** @type {string[]} */
let remoteSnapshots = [];
/** @type {[string, string, string][]} */
let deleteCalls = [];
/** @type {[string, string][]} the sets taken out of the bucket */
let removedSets = [];
/** @type {string[]} the keys taking a set out leaves in its folder */
let strayKeys = [];
/** @type {string[]} what each prompt asked */
let prompts = [];
/** @type {boolean} */
let promptAnswer = false;
/** @type {number} */
let promptCalls = 0;
/** What happens in the bucket while the prompt waits for an answer. */
let whilePrompting = () => {};
/** @type {number} */
let referencedCalls = 0;
/** @type {Map<string, ReferencedResult>} */
let referenced = new Map();
/** @type {Map<string, RecordedDeletion>} */
let recorded = new Map();
/** @type {Set<string>} */
let stored = new Set();
/** @type {string[]} */
let headCalls = [];
/** @type {Error | undefined} what the HEADs fail with, if they do */
let headFailure;
/** @type {Error | undefined} what the holder check refuses with, if it does */
let notHeld;

/**
 * One set holding two files: `a.jpg` only in the older snapshot, `b.jpg` in both
 * — so deleting the older alone orphans `a.jpg`, and deleting both adds `b.jpg`
 * as *shared*. Rebuilt per test (the maps are mutable), and swappable by any test
 * that needs a different bucket: `mock.module` can only be called once per
 * specifier, so the *data* is the seam, not a second mock.
 * @returns {Map<string, ReferencedResult>}
 */
const fakeReferenced = () =>
  enumeration({
    photos: {
      "20260611T0915": { "a.jpg": ["h1", 500], "b.jpg": ["h2", 300] },
      "20260612T0915": { "b.jpg": ["h2", 300] },
    },
  });

mock.module("../lib/env.mjs", {
  exports: { loadSet: () => fakeSet },
});
mock.module("../lib/remote.mjs", {
  exports: {
    listRemoteSnapshots: async () => remoteSnapshots,
    referencedObjects: async () => {
      referencedCalls++;
      return referenced;
    },
    deleteRemoteSnapshot: async (
      /** @type {string} */ bucket,
      /** @type {string} */ set,
      /** @type {string} */ name,
    ) => {
      deleteCalls.push([bucket, set, name]);
      remoteSnapshots = remoteSnapshots.filter((other) => other !== name);
    },
  },
});
mock.module("../lib/deletion-record.mjs", {
  exports: {
    readDeletionRecords: async () => ({ deleted: recorded, invalid: [] }),
  },
});
mock.module("../lib/objects.mjs", {
  exports: {
    storedObjectSizes: async (
      /** @type {string} */ _bucket,
      /** @type {string[]} */ hashes,
    ) => {
      if (headFailure) {
        throw headFailure;
      }
      headCalls.push(...hashes);
      return new Map(
        hashes.map((hash) => [hash, stored.has(hash) ? 1 : undefined]),
      );
    },
  },
});
mock.module("../lib/prompt.mjs", {
  exports: {
    promptYesNo: async (/** @type {string} */ question) => {
      promptCalls++;
      prompts.push(question);
      whilePrompting();
      return promptAnswer;
    },
  },
});
mock.module("../lib/set-marker.mjs", {
  exports: {
    assertHeld: async () => {
      if (notHeld) {
        throw notHeld;
      }
    },
    removeRemoteSet: async (
      /** @type {string} */ bucket,
      /** @type {string} */ set,
    ) => {
      removedSets.push([bucket, set]);
      return strayKeys;
    },
  },
});

const { forget } = await import("./forget.mjs");

// isInteractive() reads .isTTY off the stream; poke it directly to drive the gate.
const stdin = /** @type {{ isTTY?: boolean }} */ (process.stdin);

/** @type {boolean | undefined} */
let savedTTY;
/** @type {string | undefined} */
let savedHome;
/** @type {string} */
let tmp;
/** @type {string} */
let home;
/** @type {string[]} */
let stdout = [];
const realLog = console.log;

beforeEach(() => {
  savedTTY = stdin.isTTY;
  stdin.isTTY = false; // non-interactive by default → a run needs --force
  savedHome = process.env.S3CAB_HOME;
  // The unrestorable check always writes its report, so every run needs a home to
  // write into — a temp one, so no test touches the real ~/.s3cab.
  tmp = mkdtempSync(join(tmpdir(), "s3cab-forget-"));
  home = useTempHome(tmp);
  fakeSet = {
    name: "photos",
    bucket: "b1",
    dir: join(home, ".s3cab", "sets", "photos"),
  };
  remoteSnapshots = ["20260612T0915", "20260611T0915"];
  deleteCalls = [];
  removedSets = [];
  strayKeys = [];
  prompts = [];
  promptAnswer = false;
  promptCalls = 0;
  whilePrompting = () => {};
  referencedCalls = 0;
  referenced = fakeReferenced();
  recorded = new Map();
  stored = new Set();
  headCalls = [];
  headFailure = undefined;
  notHeld = undefined;
  stdout = [];
  console.log = (/** @type {unknown[]} */ ...args) =>
    stdout.push(args.join(" "));
});
afterEach(() => {
  console.log = realLog;
  stdin.isTTY = savedTTY;
  if (savedHome === undefined) {
    delete process.env.S3CAB_HOME;
  } else {
    process.env.S3CAB_HOME = savedHome;
  }
  rmSync(tmp, { recursive: true, force: true });
});

/** The transient preview, overwritten every checked run. */
const previewPath = () =>
  join(home, ".s3cab", "forget-unrestorable-preview.txt");

/**
 * The audit records in the set's directory. Named with a timestamp minted inside
 * the command, so tests find them by listing rather than predicting the clock.
 * @returns {string[]} full paths, sorted
 */
const auditRecords = () =>
  (existsSync(fakeSet.dir) ? readdirSync(fakeSet.dir) : [])
    .filter((f) => f.startsWith("forget-unrestorable-"))
    .sort()
    .map((f) => join(fakeSet.dir, f));

describe("forget command", () => {
  it("requires --set", async () => {
    // The snapshot is the operand; the set is addressed by a flag (ADR-0062).
    await assert.rejects(
      () => forget(["20260612T0915"], {}),
      /Missing required argument: set/,
    );
  });

  it("requires a snapshot operand", async () => {
    await assert.rejects(
      () => forget([], { set: "photos" }),
      /Missing required argument: snapshot/,
    );
  });

  it("deletes several snapshots in one run, after a single prompt", async () => {
    // Snapshots are the bulk operand (ADR-0062): one run, one confirmation.
    stdin.isTTY = true;
    promptAnswer = true;
    const result = await forget(["20260612T0915", "20260611T0915"], {
      set: "photos",
    });

    assert.equal(promptCalls, 1);
    assert.deepEqual(deleteCalls, [
      ["b1", "photos", "20260612T0915"],
      ["b1", "photos", "20260611T0915"],
    ]);
    assert.deepEqual(result, {
      set: "photos",
      snapshots: ["20260612T0915", "20260611T0915"],
      forgotten: true,
    });
  });

  it("takes the set out of the bucket with its last snapshot, after saying so", async () => {
    // A set with nothing to restore from would otherwise fail verify and
    // block cleanup forever (ADR-0117).
    stdin.isTTY = true;
    promptAnswer = true;
    await forget(["20260612T0915", "20260611T0915"], { set: "photos" });

    assert.match(prompts[0] ?? "", /set leaves the bucket too[\s\S]*takeover/);
    assert.deepEqual(removedSets, [["b1", "photos"]]);
  });

  it("names a file s3cab didn't write that keeps a set it took out in the bucket", async () => {
    // Such a file still names the set, so verify and cleanup see it: "has left
    // the bucket" would be false, and the user needs the key to finish.
    strayKeys = ["snapshots/photos/notes.txt"];
    const warned = mock.method(console, "warn", () => {});
    stdin.isTTY = true;
    promptAnswer = true;
    await forget(["20260612T0915", "20260611T0915"], { set: "photos" });
    const said = warned.mock.calls
      .map(({ arguments: [text] }) => text)
      .join("\n");
    warned.mock.restore();

    assert.doesNotMatch(said, /has left the bucket/);
    assert.match(
      said,
      /This file in the set's folder[\s\S]*still names set 'photos'[\s\S]*\n {2}s3:\/\/b1\/snapshots\/photos\/notes\.txt\n/,
    );
  });

  it("leaves the set in the bucket while it has another snapshot", async () => {
    stdin.isTTY = true;
    promptAnswer = true;
    await forget(["20260611T0915"], { set: "photos" });

    assert.doesNotMatch(prompts[0] ?? "", /leaves the bucket/);
    assert.deepEqual(removedSets, []);
  });

  it("leaves the set in the bucket when a backup lands while the prompt is open", async () => {
    stdin.isTTY = true;
    promptAnswer = true;
    whilePrompting = () => {
      remoteSnapshots = [...remoteSnapshots, "20260613T0915"];
    };
    await forget(["20260612T0915", "20260611T0915"], { set: "photos" });

    assert.deepEqual(removedSets, []);
  });

  it("takes out a set with no snapshots left, which a stopped forget leaves, and records it", async () => {
    // Every snapshot went, and the run stopped before the set did: the names
    // it was given are gone, and taking the set out is what is left to do.
    remoteSnapshots = [];
    stdin.isTTY = true;
    promptAnswer = true;
    const result = await forget(["20260612T0915"], { set: "photos" });

    // The prompt warns what taking out a set whose snapshots were lost costs.
    assert.match(
      prompts[0] ?? "",
      /no snapshots in bucket b1[\s\S]*lost, answer no[\s\S]*cleanup[\s\S]*takeover/,
    );
    assert.deepEqual(removedSets, [["b1", "photos"]]);
    assert.deepEqual(deleteCalls, []);
    assert.equal(referencedCalls, 0);
    // Nothing was forgotten: the result is about the set, not the names given.
    assert.deepEqual(result, { set: "photos", retired: true, stray: [] });
    const records = auditRecords();
    assert.equal(records.length, 1);
    assert.match(readFileSync(records[0] ?? "", "utf8"), /set taken out/);
  });

  it("keeps a set with no snapshots left when the user declines", async () => {
    remoteSnapshots = [];
    stdin.isTTY = true;
    promptAnswer = false;
    const result = await forget(["20260612T0915"], { set: "photos" });

    assert.deepEqual(removedSets, []);
    assert.deepEqual(result, { set: "photos", retired: false, stray: [] });
    assert.deepEqual(auditRecords(), []);
  });

  it("reports the files that keep a set with no snapshots in the bucket once it is taken out", async () => {
    remoteSnapshots = [];
    strayKeys = ["snapshots/photos/old/20250101T0000.tsv.gz"];
    stdin.isTTY = true;
    promptAnswer = true;
    const result = await forget(["20260612T0915"], { set: "photos" });

    assert.deepEqual(result, {
      set: "photos",
      retired: true,
      stray: ["snapshots/photos/old/20250101T0000.tsv.gz"],
    });
  });

  it("keeps a set with no snapshots when a backup lands while the prompt is open", async () => {
    remoteSnapshots = [];
    stdin.isTTY = true;
    promptAnswer = true;
    whilePrompting = () => {
      remoteSnapshots = ["20260613T0915"];
    };
    const result = await forget(["20260612T0915"], { set: "photos" });

    assert.deepEqual(removedSets, []);
    assert.deepEqual(result, { set: "photos", retired: false, stray: [] });
  });

  it("won't take out a set with no snapshots under --force, which a lost set reads the same as", async () => {
    // Taken out unseen, a set whose snapshots were lost stops cleanup
    // refusing over it (ADR-0117 §5); only the prompt lets the user say which.
    remoteSnapshots = [];
    await assert.rejects(
      () => forget(["20260612T0915"], { set: "photos", force: true }),
      /not backed up for set 'photos'[\s\S]*no snapshots in bucket b1[\s\S]*without --force:\n {2}s3cab forget --set photos 20260612T0915$/,
    );
    assert.deepEqual(removedSets, []);
    assert.deepEqual(auditRecords(), []);
  });

  it("tells a run with no terminal to use one for a set with no snapshots, not --force", async () => {
    // --force would refuse it too, so suggesting it is a dead end.
    remoteSnapshots = [];
    await assert.rejects(
      () => forget(["20260612T0915"], { set: "photos" }),
      (/** @type {Error} */ error) => {
        assert.match(error.message, /no snapshots in bucket b1[\s\S]*terminal/);
        assert.doesNotMatch(error.message, /20260612T0915 --force/);
        return true;
      },
    );
    assert.equal(promptCalls, 0);
    assert.deepEqual(removedSets, []);
  });

  it("validates every name before deleting any, so a typo late in the list costs nothing", async () => {
    // The whole selection is checked up front: a bad third name must not leave
    // the first two already deleted (the deletions are not undoable). A terminal,
    // so the run is past the non-interactive gate and reaches the existence check.
    stdin.isTTY = true;
    await assert.rejects(
      () =>
        forget(["20260612T0915", "20990101T0000"], {
          set: "photos",
        }),
      /Snapshot '20990101T0000' is not backed up for set 'photos'/,
    );
    assert.equal(deleteCalls.length, 0);
  });

  it("errors helpfully when the snapshot isn't backed up", async () => {
    stdin.isTTY = true;
    await assert.rejects(
      () => forget(["20990101T0000"], { set: "photos" }),
      /not backed up for set 'photos'[\s\S]*s3cab list photos --remote/,
    );
    assert.equal(deleteCalls.length, 0);
  });

  it("refuses a set this machine doesn't hold, even with --force", async () => {
    // A machine that is only browsing the set must not delete the holder's
    // history (ADR-0108); --force skips the confirmation, not this.
    notHeld = new Error("not held");
    await assert.rejects(
      () => forget(["20260612T0915"], { set: "photos", force: true }),
      /not held/,
    );
    assert.equal(referencedCalls, 0);
    assert.deepEqual(deleteCalls, []);
  });

  it("refuses a non-interactive run without --force", async () => {
    // The destructive-command pattern (ADR-0064): with no terminal to confirm
    // on, the intent must be explicit. The refusal is up front — no scan, no
    // delete — and names the exact --force invocation.
    stdin.isTTY = false;
    await assert.rejects(
      () => forget(["20260612T0915"], { set: "photos" }),
      /no terminal to ask on[\s\S]*forget --set photos 20260612T0915 --force/,
    );
    assert.equal(referencedCalls, 0);
    assert.deepEqual(deleteCalls, []);
  });

  it("deletes on a TTY when the user confirms", async () => {
    stdin.isTTY = true;
    promptAnswer = true;
    const result = await forget(["20260612T0915"], {
      set: "photos",
    });

    assert.equal(promptCalls, 1);
    assert.deepEqual(deleteCalls, [["b1", "photos", "20260612T0915"]]);
    assert.deepEqual(result, {
      set: "photos",
      snapshots: ["20260612T0915"],
      forgotten: true,
    });
  });

  it("deletes nothing on a TTY when the user declines", async () => {
    stdin.isTTY = true;
    promptAnswer = false;
    const result = await forget(["20260612T0915"], {
      set: "photos",
    });

    assert.equal(promptCalls, 1);
    assert.deepEqual(deleteCalls, []);
    assert.deepEqual(result, {
      set: "photos",
      snapshots: ["20260612T0915"],
      forgotten: false,
    });
  });

  describe("the unrestorable check", () => {
    it("writes the preview and summarises it on stdout before the prompt", async () => {
      stdin.isTTY = true;
      promptAnswer = true;
      await forget(["20260611T0915"], { set: "photos" });

      // a.jpg loses its last reference; b.jpg survives in 20260612T0915.
      const preview = readFileSync(previewPath(), "utf8");
      const rows = preview.split("\n").filter((l) => l && !l.startsWith("#"));
      assert.deepEqual(rows, ["20260611T0915\ta.jpg"]);
      // The trustworthy total is the header's, files and objects apart.
      assert.match(preview, /# 1 file, holding 500B across 1 stored object\./);

      const summary = stdout.join("\n");
      assert.match(summary, /^ {2}total unrestorable +1 +500B$/m);
      // The preview's absolute path lands last, on its own indented line.
      assert.equal(summary.split("\n").at(-1), `  ${previewPath()}`);
    });

    it("is bucket-wide, so another set's reference keeps content off the list", async () => {
      // Not a re-test of planUnrestorable — this asserts the *command* hands it the
      // whole bucket rather than the target set's own snapshots (ADR-0013). A
      // second set references a.jpg's content, so deleting the only photos
      // snapshot that holds it orphans nothing.
      for (const [set, result] of enumeration({
        docs: { d1: { "copy.jpg": ["h1", 500] } },
      })) {
        referenced.set(set, result);
      }

      stdin.isTTY = true;
      promptAnswer = true;
      await forget(["20260611T0915"], { set: "photos" });

      const rows = readFileSync(previewPath(), "utf8")
        .split("\n")
        .filter((l) => l && !l.startsWith("#"));
      assert.deepEqual(rows, [], "a.jpg is still referenced by set 'docs'");
      assert.match(stdout.join("\n"), /nothing would become unrestorable/);
    });

    it("computes over the whole selection, so shared content shows as shared", async () => {
      stdin.isTTY = true;
      promptAnswer = true;
      await forget(["20260611T0915", "20260612T0915"], {
        set: "photos",
      });

      const summary = stdout.join("\n");
      // b.jpg is orphaned only because both snapshots go — the shared line.
      assert.match(summary, /shared across 2 snapshots\s+1\s+300B/);
      assert.match(summary, /total unrestorable\s+2\s+800B/);
      // Both snapshots are the set's whole remote history.
      assert.match(summary, /last remote snapshot of set 'photos'/);
    });

    it("leaves out content a delete already removed, checking only what this run would orphan", async () => {
      // h2 is recorded too, but b.jpg survives in 20260612T0915 — so only h1
      // is worth a HEAD.
      recorded = new Map([
        ["h1", { deletedOn: "2026-06-13T10:00:00.000Z" }],
        ["h2", { deletedOn: "2026-06-13T10:00:00.000Z" }],
      ]);

      stdin.isTTY = true;
      promptAnswer = true;
      await forget(["20260611T0915"], { set: "photos" });

      assert.deepEqual(headCalls, ["h1"]);
      const rows = readFileSync(previewPath(), "utf8")
        .split("\n")
        .filter((l) => l && !l.startsWith("#"));
      assert.deepEqual(rows, []);
      const summary = stdout.join("\n");
      assert.match(summary, /nothing would become unrestorable/);
      assert.match(summary, /1 file these snapshots list was already deleted/);
    });

    it("still counts recorded content a later backup stored again", async () => {
      // Deleting is never a ban: the row outlives the re-upload, so the record
      // alone would hide a real loss.
      recorded = new Map([["h1", { deletedOn: "2026-06-13T10:00:00.000Z" }]]);
      stored = new Set(["h1"]);

      stdin.isTTY = true;
      promptAnswer = true;
      await forget(["20260611T0915"], { set: "photos" });

      const summary = stdout.join("\n");
      assert.match(summary, /^ {2}total unrestorable +1 +500B$/m);
      assert.doesNotMatch(summary, /already deleted/);
    });

    it("stops before the prompt when checking for deleted content fails", async () => {
      // A preview that couldn't check would count deleted content as this run's
      // loss again, so the run fails rather than asking on a wrong figure.
      recorded = new Map([["h1", { deletedOn: "2026-06-13T10:00:00.000Z" }]]);
      headFailure = new Error("HEAD failed");

      stdin.isTTY = true;
      promptAnswer = true;
      await assert.rejects(
        () => forget(["20260611T0915"], { set: "photos" }),
        /HEAD failed/,
      );

      assert.equal(promptCalls, 0);
      assert.deepEqual(deleteCalls, []);
      assert.deepEqual(auditRecords(), []);
    });
  });

  describe("the audit trail", () => {
    it("keeps a record in the set's directory once the deletion happens", async () => {
      stdin.isTTY = true;
      promptAnswer = true;
      await forget(["20260611T0915"], { set: "photos" });

      const records = auditRecords();
      assert.equal(records.length, 1);
      // Second precision, so two runs a minute apart can't overwrite one another.
      assert.match(records[0] ?? "", /forget-unrestorable-\d{8}T\d{6}\.txt$/);
      // It holds the same list as the preview did.
      assert.match(readFileSync(records[0] ?? "", "utf8"), /a\.jpg/);
    });

    it("keeps no record when the user declines — but the preview survives", async () => {
      // Declining still leaves the list to read and re-run against, without
      // paying for a second scan.
      stdin.isTTY = true;
      promptAnswer = false;
      const result = await forget(["20260611T0915"], {
        set: "photos",
      });

      assert.deepEqual(result, {
        set: "photos",
        snapshots: ["20260611T0915"],
        forgotten: false,
      });
      assert.deepEqual(auditRecords(), [], "nothing was removed, so no record");
      assert.match(readFileSync(previewPath(), "utf8"), /a\.jpg/);
    });

    it("records a non-interactive --force run (the scripted path), which skipped the check", async () => {
      // --force is the only non-interactive door; it skips the whole-bucket scan
      // and files the "check skipped" stub record.
      stdin.isTTY = false;
      await forget(["20260611T0915"], { set: "photos", force: true });

      assert.equal(referencedCalls, 0, "no whole-bucket scan");
      assert.deepEqual(deleteCalls, [["b1", "photos", "20260611T0915"]]);
      const records = auditRecords();
      assert.equal(records.length, 1);
      assert.match(
        readFileSync(records[0] ?? "", "utf8"),
        /no unrestorable check \(--force\)/,
      );
    });

    it("--force skips the check and the confirmation together, but still files a record", async () => {
      // The two travel together: skipping the check leaves the prompt nothing
      // useful to say (docs/design/snapshot-deletion.md). The record is still
      // written — a trail that silently omits the runs which bypassed the safety
      // is worse than one that names the gap.
      stdin.isTTY = true;
      promptAnswer = false; // would cancel, if it were ever asked
      const result = await forget(["20260611T0915"], {
        set: "photos",
        force: true,
      });

      assert.equal(referencedCalls, 0, "no whole-bucket scan");
      assert.equal(promptCalls, 0, "no confirmation");
      assert.deepEqual(stdout, [], "no preview on stdout");
      assert.throws(
        () => readFileSync(previewPath(), "utf8"),
        "no preview file",
      );
      assert.deepEqual(result, {
        set: "photos",
        snapshots: ["20260611T0915"],
        forgotten: true,
      });
      assert.deepEqual(deleteCalls, [["b1", "photos", "20260611T0915"]]);

      const records = auditRecords();
      assert.equal(records.length, 1);
      const record = readFileSync(records[0] ?? "", "utf8");
      assert.match(record, /no unrestorable check \(--force\)/);
      assert.match(record, /never computed/);
    });
  });
});
