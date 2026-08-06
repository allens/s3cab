import assert from "node:assert/strict";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join, normalize, relative, resolve } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { zstdCompressSync, zstdDecompressSync } from "node:zlib";
import { writeSet } from "../lib/sets.mjs";
import { listSnapshotNames, readSnapshot } from "../lib/snapshot-file.mjs";
import { snapshot } from "./snapshot.mjs";
import { useTempHome } from "../../test/helpers/temp-home.mjs";

/** @import { TestContext } from "node:test" */

/**
 * @param {string} fixtureName
 * @param {string} testName
 */
function copyFixtureToWorkDir(fixtureName, testName) {
  const fixtureDir = resolve("./test/fixtures", fixtureName);
  if (!readdirSync(fixtureDir).length) {
    throw new Error(`Fixture "${fixtureName}" does not exist or is empty`);
  }
  const tmpDir = resolve("./test/.tmp", ...testName.split(" > "));
  rmSync(tmpDir, { recursive: true, force: true });
  mkdirSync(tmpDir, { recursive: true });
  cpSync(fixtureDir, tmpDir, {
    recursive: true,
    force: true,
    preserveTimestamps: true,
  });
  /** @param {string[]} parts */
  function inWorkDir(...parts) {
    return join(tmpDir, ...parts);
  }
  return inWorkDir;
}

// The set store derives its paths from s3cabDir(); point S3CAB_HOME at a temp
// dir (via the shared useTempHome) so a snapshot can't touch the real `~/.s3cab`,
// and restore the environment after each test.
/** @type {NodeJS.ProcessEnv} */
let savedEnv;
beforeEach(() => {
  savedEnv = { ...process.env };
});
afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in savedEnv)) {
      delete process.env[key];
    }
  }
  Object.assign(process.env, savedEnv);
});

describe("snapshot", () => {
  it("errors for a set whose directory no longer exists", async () => {
    const workDir = copyFixtureToWorkDir("before", "snapshot > missing-dir");
    useTempHome(workDir());
    mkdirSync(workDir("data"));
    writeFileSync(workDir("data", "x.txt"), "x");
    writeSet("photos", {
      dirs: [realpathSync.native(workDir("data"))],
      bucket: "b",
    });
    rmSync(workDir("data"), { recursive: true, force: true });

    await assert.rejects(snapshot("photos", { rehash: true }));
  });

  it("reports changes between snapshots", async (t) => {
    let mockIsoDateTime = "2025-01-15T10:30:00";

    // zonedDateTimeISO is the snapshot's single clock read: the name, the UTC
    // instant and the zone in the header all derive from it (ADR-0072), so
    // pinning it pins every spelling of the moment.
    t.mock.method(Temporal.Now, "zonedDateTimeISO", () =>
      Temporal.PlainDateTime.from(mockIsoDateTime).toZonedDateTime(
        "Europe/London",
      ),
    );

    const workDir = copyFixtureToWorkDir("before", t.fullName);
    useTempHome(workDir());
    writeSet("photos", { dirs: [realpathSync.native(workDir())], bucket: "b" });

    await snapshot("photos", { rehash: true });

    mockIsoDateTime = "2025-01-15T10:31:00";

    mkdirSync(workDir("dir"));

    // Delete
    unlinkSync(workDir("delete.txt"));

    // Modify
    writeFileSync(workDir("modify.txt"), `modified`);

    // Add
    writeFileSync(workDir("added.txt"), `added`);

    // Rename
    renameSync(workDir("rename.txt"), workDir("renamed.txt"));

    // Move
    renameSync(workDir("move.txt"), workDir("dir", "move.txt"));

    const { added, modified, deleted, moved } = await snapshot("photos", {
      rehash: false,
    });

    // `snapshot` returns the structured, absolute-path CompareResult now
    // (ADR-0043); project each entry back to a path relative to the member root
    // for readable assertions (the arrow/rename-vs-move wording is the
    // renderer's job — render.test.mjs).
    const rel = (/** @type {string} */ p) => relative(workDir(), p);

    assert.deepStrictEqual(
      added.map((a) => rel(a.path)),
      [normalize("added.txt")],
    );
    assert.deepStrictEqual(
      modified.map((m) => rel(m.path)),
      [normalize("modify.txt")],
    );
    assert.deepStrictEqual(
      deleted.map((d) => rel(d.path)),
      [normalize("delete.txt")],
    );
    assert.deepStrictEqual(
      moved.map((m) => `${rel(m.path)} → ${rel(m.to)}`),
      [
        `${normalize("move.txt")} → ${normalize("dir/move.txt")}`,
        `${normalize("rename.txt")} → ${normalize("renamed.txt")}`,
      ],
    );
  });

  it("writes the set identity and a #DIR line per member directory", async (t) => {
    t.mock.method(Temporal.Now, "zonedDateTimeISO", () =>
      Temporal.PlainDateTime.from("2025-02-01T09:00:00").toZonedDateTime(
        "Europe/London",
      ),
    );

    const workDir = copyFixtureToWorkDir("before", t.fullName);
    const home = useTempHome(workDir());
    writeSet("photos", { dirs: [realpathSync.native(workDir())], bucket: "b" });

    await snapshot("photos", { rehash: true, debug: true });

    // --debug leaves an uncompressed copy beside the snapshot; read its header.
    const decompressed = readFileSync(
      join(home, ".s3cab", "sets", "photos", "snapshots", ".snapshot.tsv"),
      "utf8",
    );
    const [snapshotLine, dirLine] = decompressed
      .split("\n")
      .filter((line) => line.startsWith("#"));
    assert.ok(snapshotLine && dirLine, "expected #SNAPSHOT and #DIR headers");

    // All four columns (ADR-0072): the set, the UTC instant of the moment the
    // snapshot started, then its own name and the zone that name was minted in.
    // February in Europe/London is GMT, so the instant matches the wall clock.
    assert.match(
      snapshotLine,
      /^#SNAPSHOT\s+photos\s+2025-02-01T09:00:00\.000Z\s+2025-02-01T0900 Europe\/London\s*$/,
    );
    assert.match(dirLine, /^#DIR\s/);
    assert.ok(dirLine.includes(realpathSync.native(workDir())));
  });

  it("refuses a same-minute snapshot unless overwriting under debug", async (t) => {
    t.mock.method(Temporal.Now, "zonedDateTimeISO", () =>
      Temporal.PlainDateTime.from("2025-03-01T12:00:00").toZonedDateTime(
        "Europe/London",
      ),
    );

    const workDir = copyFixtureToWorkDir("before", t.fullName);
    useTempHome(workDir());
    writeSet("photos", { dirs: [realpathSync.native(workDir())], bucket: "b" });

    await snapshot("photos", { rehash: true });

    // Same minute, same name → refused rather than silently overwriting.
    await assert.rejects(snapshot("photos", { rehash: true }), /same minute/);

    // …but debug mode (S3CAB_DEBUG) is allowed to overwrite while iterating.
    await snapshot("photos", { rehash: true, debug: true });
  });
});

// Hash reuse after an interrupted snapshot (ADR-0067). The parked lookup is
// planted by hand — structurally it *is* a snapshot TSV, so a real snapshot
// renamed to the parked name is exactly what an interrupted run leaves — with
// every hash replaced by a sentinel. A sentinel that survives into the new
// snapshot can only have come from the parked file: it is nowhere on disk.
const SENTINEL_HASH = "f".repeat(64);

/**
 * Turn the set's one snapshot into a parked lookup holding sentinel hashes, and
 * remove it — the interrupted-first-seed state: work parked, no snapshot yet.
 * @param {string} snapshotsDir
 */
function parkSentinelHashes(snapshotsDir) {
  const [name] = readdirSync(snapshotsDir);
  assert.ok(name, "expected the snapshot just taken");
  const text = zstdDecompressSync(
    readFileSync(join(snapshotsDir, name)),
  ).toString("utf8");
  writeFileSync(
    join(snapshotsDir, ".snapshot.lookup.tsv.zst"),
    zstdCompressSync(
      Buffer.from(text.replace(/^[0-9a-f]{64}/gm, SENTINEL_HASH), "utf8"),
    ),
  );
  unlinkSync(join(snapshotsDir, name));
}

/**
 * The hashes recorded in the set's newest snapshot.
 * @param {string} snapshotsDir
 */
async function hashesIn(snapshotsDir) {
  // Via the lister, as production does: it yields bare snapshot names (and
  // skips the dot-prefixed lookup file), which is what `readSnapshot` resolves.
  const name = listSnapshotNames(snapshotsDir).at(0);
  const { entries } = await readSnapshot(snapshotsDir, name ?? "");
  return [...entries.values()].map((props) => props.hash);
}

describe("snapshot (hashes parked by an interrupted run)", () => {
  /**
   * @param {TestContext} t
   * @param {string} isoDateTime
   */
  function setUp(t, isoDateTime) {
    let clock = isoDateTime;
    t.mock.method(Temporal.Now, "zonedDateTimeISO", () =>
      Temporal.PlainDateTime.from(clock).toZonedDateTime("Europe/London"),
    );
    const workDir = copyFixtureToWorkDir("before", t.fullName);
    const home = useTempHome(workDir());
    writeSet("photos", { dirs: [realpathSync.native(workDir())], bucket: "b" });
    return {
      snapshotsDir: join(home, ".s3cab", "sets", "photos", "snapshots"),
      /** @param {string} next */
      tick: (next) => (clock = next),
    };
  }

  it("reuses them, then deletes the parked file once the snapshot lands", async (t) => {
    const { snapshotsDir, tick } = setUp(t, "2025-04-01T09:00:00");

    await snapshot("photos", { rehash: true });
    parkSentinelHashes(snapshotsDir);

    tick("2025-04-01T09:01:00");
    await snapshot("photos", {});

    // Every unchanged file took its hash from the parked lookup rather than
    // being read again — the whole point of parking.
    const hashes = await hashesIn(snapshotsDir);
    assert.ok(hashes.length, "expected file rows in the new snapshot");
    assert.deepEqual([...new Set(hashes)], [SENTINEL_HASH]);

    // Consumed on success: the new snapshot re-records every parked row.
    assert.ok(
      !existsSync(join(snapshotsDir, ".snapshot.lookup.tsv.zst")),
      "a landed snapshot must delete the parked lookup",
    );
  });

  it("ignores them under --rehash, which means re-hash everything", async (t) => {
    const { snapshotsDir, tick } = setUp(t, "2025-05-01T09:00:00");

    await snapshot("photos", { rehash: true });
    parkSentinelHashes(snapshotsDir);

    tick("2025-05-01T09:01:00");
    await snapshot("photos", { rehash: true });

    const hashes = await hashesIn(snapshotsDir);
    assert.ok(hashes.length, "expected file rows in the new snapshot");
    assert.ok(
      !hashes.includes(SENTINEL_HASH),
      "--rehash must read every file from disk, parked hashes included",
    );
    assert.ok(
      !existsSync(join(snapshotsDir, ".snapshot.lookup.tsv.zst")),
      "a landed snapshot deletes the parked lookup however it was taken",
    );
  });
});

describe("clock-went-backwards warning (ADR-0072 check A)", () => {
  /**
   * @param {TestContext} t
   * @param {() => string} clock
   */
  const mockClock = (t, clock) =>
    t.mock.method(Temporal.Now, "zonedDateTimeISO", () =>
      Temporal.PlainDateTime.from(clock()).toZonedDateTime("Europe/London"),
    );

  it("warns when the next snapshot would sort before the previous one", async (t) => {
    let now = "2025-01-15T10:30:00";
    mockClock(t, () => now);
    const warn = t.mock.method(console, "warn", () => {});

    const workDir = copyFixtureToWorkDir("before", t.fullName);
    const home = useTempHome(workDir());
    writeSet("photos", { dirs: [realpathSync.native(workDir())], bucket: "b" });
    await snapshot("photos", { rehash: true });

    // The clock goes back an hour — the autumn fold, or a flight west. The name
    // is a minute earlier, so it will sort *before* the snapshot it follows.
    now = "2025-01-15T10:29:00";
    warn.mock.resetCalls();
    await snapshot("photos", { rehash: true });

    const said = warn.mock.calls
      .map((call) => String(call.arguments[0]))
      .join("\n");
    assert.match(said, /sorts before the one before it/);
    assert.match(said, /clock has gone back/);
    // Warns, never blocks: the snapshot itself is written.
    assert.equal(
      readdirSync(join(home, ".s3cab", "sets", "photos", "snapshots")).filter(
        (f) => f.endsWith(".tsv.zst"),
      ).length,
      2,
    );
  });

  it("says nothing when the clock runs forward, as it normally does", async (t) => {
    let now = "2025-01-15T10:30:00";
    mockClock(t, () => now);
    const warn = t.mock.method(console, "warn", () => {});

    const workDir = copyFixtureToWorkDir("before", t.fullName);
    useTempHome(workDir());
    writeSet("photos", { dirs: [realpathSync.native(workDir())], bucket: "b" });
    await snapshot("photos", { rehash: true });

    now = "2025-01-15T10:31:00";
    warn.mock.resetCalls();
    await snapshot("photos", { rehash: true });

    const said = warn.mock.calls
      .map((call) => String(call.arguments[0]))
      .join("\n");
    assert.doesNotMatch(said, /clock has gone back/);
  });
});
