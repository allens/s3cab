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

import { useTempHome } from "../../test/helpers/temp-home.mjs";

/** @import { ReferencedResult } from "../lib/referenced.mjs" */

// Offline tests for `forget`: the S3 reads/writes (listRemoteSnapshots,
// deleteRemoteSnapshot, referencedObjects), the set resolver (loadSet), and the
// prompt are faked at the lib seam, and the TTY gate is driven via
// process.stdin.isTTY — so the required-arg guards, the existence check, the
// unrestorable check's wiring, the non-interactive `--force` gate, and the
// confirm/skip logic are locked down without a bucket or a terminal. The orphan
// *computation* is tested pure in lib/unrestorable.test.mjs; what's asserted here
// is the command's part — that the check runs, the report lands on disk, and
// --force skips both halves (ADR-0064's destructive-command pattern). The real
// removal is covered by test/integration/remote.test.mjs's gated round-trip.
// Mocks first, then a dynamic import.

/** @type {{ name: string, bucket: string, dir: string }} */
let fakeSet = { name: "photos", bucket: "b1", dir: "" };
/** @type {string[]} */
let remoteSnapshots = [];
/** @type {[string, string, string][]} */
let deleteCalls = [];
/** @type {boolean} */
let promptAnswer = false;
/** @type {number} */
let promptCalls = 0;
/** @type {number} */
let referencedCalls = 0;
/** @type {Map<string, ReferencedResult>} */
let referenced = new Map();

/**
 * One set holding two files: `a.jpg` only in the older snapshot, `b.jpg` in both
 * — so deleting the older alone orphans `a.jpg`, and deleting both adds `b.jpg`
 * as *shared*. Rebuilt per test (the maps are mutable), and swappable by any test
 * that needs a different bucket: `mock.module` can only be called once per
 * specifier, so the *data* is the seam, not a second mock.
 * @returns {Map<string, ReferencedResult>}
 */
const fakeReferenced = () =>
  new Map([
    [
      "photos",
      {
        referenced: new Map([
          [
            "h1",
            {
              paths: new Map([
                [
                  "a.jpg",
                  {
                    sizes: new Set([500]),
                    snapshots: new Set(["2026-06-11T0915"]),
                  },
                ],
              ]),
            },
          ],
          [
            "h2",
            {
              paths: new Map([
                [
                  "b.jpg",
                  {
                    sizes: new Set([300]),
                    snapshots: new Set(["2026-06-11T0915", "2026-06-12T0915"]),
                  },
                ],
              ]),
            },
          ],
        ]),
        snapshotsChecked: 2,
        unreadable: [],
      },
    ],
  ]);

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
    },
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
  remoteSnapshots = ["2026-06-12T0915", "2026-06-11T0915"];
  deleteCalls = [];
  promptAnswer = false;
  promptCalls = 0;
  referencedCalls = 0;
  referenced = fakeReferenced();
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
      () => forget(["2026-06-12T0915"], {}),
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
    const result = await forget(["2026-06-12T0915", "2026-06-11T0915"], {
      set: "photos",
    });

    assert.equal(promptCalls, 1);
    assert.deepEqual(deleteCalls, [
      ["b1", "photos", "2026-06-12T0915"],
      ["b1", "photos", "2026-06-11T0915"],
    ]);
    assert.deepEqual(result, {
      set: "photos",
      snapshots: ["2026-06-12T0915", "2026-06-11T0915"],
      forgotten: true,
    });
  });

  it("validates every name before deleting any, so a typo late in the list costs nothing", async () => {
    // The whole selection is checked up front: a bad third name must not leave
    // the first two already deleted (the deletions are not undoable). A terminal,
    // so the run is past the non-interactive gate and reaches the existence check.
    stdin.isTTY = true;
    await assert.rejects(
      () =>
        forget(["2026-06-12T0915", "2099-01-01T0000"], {
          set: "photos",
        }),
      /Snapshot '2099-01-01T0000' is not backed up for set 'photos'/,
    );
    assert.equal(deleteCalls.length, 0);
  });

  it("errors helpfully when the snapshot isn't backed up", async () => {
    stdin.isTTY = true;
    await assert.rejects(
      () => forget(["2099-01-01T0000"], { set: "photos" }),
      /not backed up for set 'photos'[\s\S]*s3cab list photos --remote/,
    );
    assert.equal(deleteCalls.length, 0);
  });

  it("refuses a non-interactive run without --force", async () => {
    // The destructive-command pattern (ADR-0064): with no terminal to confirm
    // on, the intent must be explicit. The refusal is up front — no scan, no
    // delete — and names the exact --force invocation.
    stdin.isTTY = false;
    await assert.rejects(
      () => forget(["2026-06-12T0915"], { set: "photos" }),
      /no terminal to ask on[\s\S]*forget --set photos 2026-06-12T0915 --force/,
    );
    assert.equal(referencedCalls, 0);
    assert.deepEqual(deleteCalls, []);
  });

  it("deletes on a TTY when the user confirms", async () => {
    stdin.isTTY = true;
    promptAnswer = true;
    const result = await forget(["2026-06-12T0915"], {
      set: "photos",
    });

    assert.equal(promptCalls, 1);
    assert.deepEqual(deleteCalls, [["b1", "photos", "2026-06-12T0915"]]);
    assert.equal(result.forgotten, true);
  });

  it("deletes nothing on a TTY when the user declines", async () => {
    stdin.isTTY = true;
    promptAnswer = false;
    const result = await forget(["2026-06-12T0915"], {
      set: "photos",
    });

    assert.equal(promptCalls, 1);
    assert.deepEqual(deleteCalls, []);
    assert.equal(result.forgotten, false);
  });

  describe("the unrestorable check", () => {
    it("writes the preview and summarises it on stdout before the prompt", async () => {
      stdin.isTTY = true;
      promptAnswer = true;
      await forget(["2026-06-11T0915"], { set: "photos" });

      // a.jpg loses its last reference; b.jpg survives in 2026-06-12T0915.
      const preview = readFileSync(previewPath(), "utf8");
      const rows = preview.split("\n").filter((l) => l && !l.startsWith("#"));
      assert.deepEqual(rows, ["2026-06-11T0915\ta.jpg"]);
      // The trustworthy total is the header's, files and objects apart.
      assert.match(preview, /# 1 file, holding 500B across 1 stored object\./);

      const summary = stdout.join("\n");
      assert.match(summary, /^ {2}total unrestorable +1 file +500B$/m);
      // The preview's absolute path lands last, on its own indented line.
      assert.equal(summary.split("\n").at(-1), `  ${previewPath()}`);
    });

    it("is bucket-wide, so another set's reference keeps content off the list", async () => {
      // Not a re-test of planUnrestorable — this asserts the *command* hands it the
      // whole bucket rather than the target set's own snapshots (ADR-0013). A
      // second set references a.jpg's content, so deleting the only photos
      // snapshot that holds it orphans nothing.
      referenced.set("docs", {
        referenced: new Map([
          [
            "h1",
            {
              paths: new Map([
                [
                  "copy.jpg",
                  { sizes: new Set([500]), snapshots: new Set(["d1"]) },
                ],
              ]),
            },
          ],
        ]),
        snapshotsChecked: 1,
        unreadable: [],
      });

      stdin.isTTY = true;
      promptAnswer = true;
      await forget(["2026-06-11T0915"], { set: "photos" });

      const rows = readFileSync(previewPath(), "utf8")
        .split("\n")
        .filter((l) => l && !l.startsWith("#"));
      assert.deepEqual(rows, [], "a.jpg is still referenced by set 'docs'");
      assert.match(stdout.join("\n"), /nothing would become unrestorable/);
    });

    it("computes over the whole selection, so shared content shows as shared", async () => {
      stdin.isTTY = true;
      promptAnswer = true;
      await forget(["2026-06-11T0915", "2026-06-12T0915"], {
        set: "photos",
      });

      const summary = stdout.join("\n");
      // b.jpg is orphaned only because both snapshots go — the shared line.
      assert.match(summary, /shared across 2 snapshots\s+1 file\s+300B/);
      assert.match(summary, /total unrestorable\s+2 files\s+800B/);
      // Both snapshots are the set's whole remote history.
      assert.match(summary, /last remote snapshot of set 'photos'/);
    });
  });

  describe("the audit trail", () => {
    it("keeps a record in the set's directory once the deletion happens", async () => {
      stdin.isTTY = true;
      promptAnswer = true;
      await forget(["2026-06-11T0915"], { set: "photos" });

      const records = auditRecords();
      assert.equal(records.length, 1);
      // Second precision, so two runs a minute apart can't overwrite one another.
      assert.match(
        records[0] ?? "",
        /forget-unrestorable-\d{4}-\d{2}-\d{2}T\d{6}\.txt$/,
      );
      // It holds the same list as the preview did.
      assert.match(readFileSync(records[0] ?? "", "utf8"), /a\.jpg/);
    });

    it("keeps no record when the user declines — but the preview survives", async () => {
      // Declining still leaves the list to read and re-run against, without
      // paying for a second scan.
      stdin.isTTY = true;
      promptAnswer = false;
      const result = await forget(["2026-06-11T0915"], {
        set: "photos",
      });

      assert.equal(result.forgotten, false);
      assert.deepEqual(auditRecords(), [], "nothing was removed, so no record");
      assert.match(readFileSync(previewPath(), "utf8"), /a\.jpg/);
    });

    it("records a non-interactive --force run (the scripted path), which skipped the check", async () => {
      // --force is the only non-interactive door; it skips the whole-bucket scan
      // and files the "check skipped" stub record.
      stdin.isTTY = false;
      await forget(["2026-06-11T0915"], { set: "photos", force: true });

      assert.equal(referencedCalls, 0, "no whole-bucket scan");
      assert.deepEqual(deleteCalls, [["b1", "photos", "2026-06-11T0915"]]);
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
      const result = await forget(["2026-06-11T0915"], {
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
      assert.equal(result.forgotten, true);
      assert.deepEqual(deleteCalls, [["b1", "photos", "2026-06-11T0915"]]);

      const records = auditRecords();
      assert.equal(records.length, 1);
      const record = readFileSync(records[0] ?? "", "utf8");
      assert.match(record, /no unrestorable check \(--force\)/);
      assert.match(record, /never computed/);
    });
  });
});
