import assert from "node:assert/strict";
import * as realFs from "node:fs";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { mkdtempDisposable } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import { useTempHome } from "../../test/helpers/temp-home.mjs";

/** @import { TestContext } from "node:test" */

// A snapshot over a volume where **reading a file moves its own change time** —
// what the Windows Cloud Files filter driver does when it services a read
// (OneDrive Files On-Demand, and the same shape in Dropbox and Google Drive).
// That is the one condition under which the ctime cross-check (ADR-0085) can
// never settle: the pass hashes a file, the read pushes its ctime past the pass's
// own completion instant, and the next run distrusts it again. For ever.
//
// Its own file (ADR-0049's dotted aspect) because the behaviour is a property of
// the *filesystem*, so it has to be faked by mocking `node:fs` before the engine
// loads — which the sibling `snapshot.test.mjs` cannot do around its static
// imports. What is mocked is the filesystem, not any function of ours: the stat
// a registered path reports simply has a later `ctimeMs` every time it is asked.

/** @type {Set<string>} Paths whose change time moves on every look — the sync-filtered ones */
const movesOnRead = new Set();
/** @type {Map<string, number>} Paths whose change time moved once and then held still */
const movedOnce = new Map();

/** Advanced per look, so two stats a fraction of a millisecond apart still differ. */
let tick = 0;

const passthrough = Object.fromEntries(
  Object.entries(realFs).filter(([name]) => name !== "constants"),
);

mock.module("node:fs", {
  exports: {
    ...passthrough,
    /**
     * The real stat with `ctimeMs` rewritten for a registered path — every other
     * field, `size` and `mtime` above all, stays the genuine article, so the
     * size+mtime reuse test still matches and only the ctime guard can veto.
     * @param {string} path
     */
    lstatSync: (path) => {
      const stat = realFs.lstatSync(path);
      const fixed = movedOnce.get(path);
      const ctimeMs = movesOnRead.has(path) ? Date.now() + ++tick : fixed;
      if (ctimeMs === undefined) {
        return stat;
      }
      return Object.create(stat, {
        ctimeMs: { value: ctimeMs, enumerable: true },
      });
    },
  },
});

const { snapshot } = await import("./snapshot.mjs");
const { writeSet } = await import("../lib/sets.mjs");

const mkTmpDir = async () => mkdtempDisposable(join("test", ".tmp"));

/** @type {NodeJS.ProcessEnv} */
let savedEnv;
/** @type {string[]} */
let warnings = [];
/** @type {typeof console.warn} */
let realWarn;

beforeEach(() => {
  savedEnv = { ...process.env };
  warnings = [];
  realWarn = console.warn;
  console.warn = (/** @type {unknown[]} */ ...args) => {
    warnings.push(args.join(" "));
  };
});
afterEach(() => {
  console.warn = realWarn;
  movesOnRead.clear();
  movedOnce.clear();
  for (const key of Object.keys(process.env)) {
    if (!(key in savedEnv)) {
      delete process.env[key];
    }
  }
  Object.assign(process.env, savedEnv);
});

/**
 * A two-file set in its own home, and the canonical paths of its files.
 * @param {string} root - A disposable directory to build the set and its home in
 * @returns {{ home: string, files: string[] }}
 */
function twoFileSet(root) {
  const data = join(root, "data");
  mkdirSync(data, { recursive: true });
  writeFileSync(join(data, "a.txt"), "hello");
  writeFileSync(join(data, "b.txt"), "world");
  const home = useTempHome(root);
  writeSet("photos", { dirs: [realpathSync.native(data)], bucket: "b" });
  return {
    home,
    files: ["a.txt", "b.txt"].map((name) =>
      realpathSync.native(join(data, name)),
    ),
  };
}

/** The one warning that names the escape hatch, or undefined. */
const churnWarning = () =>
  warnings.find((line) => line.includes("S3CAB_SKIP_CHANGE_TIME_CHECK"));

/**
 * Pin the snapshot clock, and hand back the tick that advances it — two
 * snapshots in one minute are refused by design (a re-run must not overwrite
 * one), and these tests take two.
 * @param {TestContext} t
 * @param {string} isoDateTime
 * @returns {(next: string) => void}
 */
function mockClock(t, isoDateTime) {
  let clock = isoDateTime;
  t.mock.method(Temporal.Now, "zonedDateTimeISO", () =>
    Temporal.PlainDateTime.from(clock).toZonedDateTime("Europe/London"),
  );
  return (next) => (clock = next);
}

describe("snapshot on a volume where reading moves the change time", () => {
  it("says the reads are doing it, and where to turn the check off", async (t) => {
    const tock = mockClock(t, "2026-03-01T09:00:00");
    await using dir = await mkTmpDir();
    const { home, files } = twoFileSet(dir.path);

    // A first pass, on an ordinary volume: nothing to distrust, nothing to say.
    await snapshot("photos", { rehash: true });
    assert.equal(
      churnWarning(),
      undefined,
      "a pass that reused nothing has nothing to report",
    );

    // Now the sync client is servicing the reads.
    for (const file of files) {
      movesOnRead.add(file);
    }
    tock("2026-03-01T09:01:00");
    await snapshot("photos", {});

    const said = churnWarning();
    assert.ok(said, `expected the churn warning, got:\n${warnings.join("\n")}`);
    // The count is of the files re-read for nothing, not of the whole set.
    assert.match(said, /Read 2 files again that had not changed/);
    // It states the cause rather than hedging — it measured it, one `lstat` per
    // distrusted file — and every backup of this set will do the same again.
    assert.match(said, /reading them moves it again/);
    assert.match(said, /every backup of 'photos' will re-read them/);
    // ADR-0030's constructive fix: the exact line, and the file to put it in.
    assert.match(said, / {2}S3CAB_SKIP_CHANGE_TIME_CHECK=1$/m);
    assert.ok(
      said.includes(join(home, ".s3cab", "sets", "photos", "env")),
      `the fix must name this set's own env file, got:\n${said}`,
    );
    // And what it costs, because turning a safety guard off is a trade.
    assert.match(said, /modification time put back afterwards/);
  });

  it("stays quiet when a change time moved for a reason of its own", async (t) => {
    // The guard working. A file really was touched since the baseline, so it is
    // read again — and re-reading it leaves the change time alone, which is what
    // separates a one-off from a volume that can never settle. One re-hash and
    // the file is trusted again, so there is nothing to advise the user about.
    const tock = mockClock(t, "2026-03-01T10:00:00");
    await using dir = await mkTmpDir();
    const { files } = twoFileSet(dir.path);

    await snapshot("photos", { rehash: true });

    const touched = Date.now() + 60_000;
    for (const file of files) {
      movedOnce.set(file, touched);
    }
    tock("2026-03-01T10:01:00");
    await snapshot("photos", {});

    assert.equal(
      churnWarning(),
      undefined,
      `a one-off ctime move must not advise turning the guard off, got:\n${warnings.join("\n")}`,
    );
  });
});
