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
  statSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join, normalize, relative, resolve } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { zstdCompressSync, zstdDecompressSync } from "node:zlib";
import { writeSet } from "../lib/sets.mjs";
import {
  listSnapshotNames,
  readSnapshot,
  snapshotFileName,
} from "../lib/snapshot-file.mjs";
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

  // `dirs.txt` is hand-edited (ADR-0052), so a member directory can be spelled
  // in any casing Windows accepts, while the rows are canonical — the walk
  // realpaths each root. Recording the raw text gave a header that disagreed
  // with every row beneath it, and `restore --output` reads that disagreement as
  // "this file is under no backed-up directory". win32-only: a drive letter is
  // the component whose case the user can vary without naming another file.
  it(
    "canonicalizes the #DIR header, so it agrees with the rows beneath it",
    { skip: process.platform !== "win32" ? "win32-only behaviour" : false },
    async (t) => {
      const workDir = copyFixtureToWorkDir("before", t.fullName);
      const home = useTempHome(workDir());

      const canonical = realpathSync.native(workDir());
      const lowerDrive = canonical.charAt(0).toLowerCase() + canonical.slice(1);
      assert.notEqual(lowerDrive, canonical, "the fixture must differ in case");
      writeSet("photos", { dirs: [lowerDrive], bucket: "b" });

      await snapshot("photos", { rehash: true, debug: true });

      const decompressed = readFileSync(
        join(home, ".s3cab", "sets", "photos", "snapshots", ".snapshot.tsv"),
        "utf8",
      );
      const lines = decompressed.split("\n").filter(Boolean);
      const dirLine = lines.find((line) => line.startsWith("#DIR"));
      assert.ok(dirLine?.endsWith(canonical), `#DIR kept dirs.txt: ${dirLine}`);

      // The point of canonicalizing: every row now sits under that header, which
      // is exactly what `restore --output` needs to place them.
      const rows = lines.filter((line) => !line.startsWith("#"));
      assert.ok(rows.length, "expected the fixture to produce file rows");
      for (const row of rows) {
        const path = row.split("\t").at(-1) ?? "";
        assert.ok(
          path.startsWith(canonical),
          `row is not under the #DIR header: ${path}`,
        );
      }
    },
  );

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
 * Turn the set's newest snapshot into a parked lookup holding sentinel hashes,
 * removing the snapshot: the run that wrote it is now the interrupted one, and
 * whatever came before it is the previous snapshot (none, for the
 * interrupted-first-seed state).
 *
 * Only the hashes and the status are rewritten. The `#END` instant is kept as
 * the run minted it, because it is the trust boundary those rows are judged by
 * (ADR-0085) and the run's own clock is the honest source of it — a test that
 * needs the boundary somewhere in particular puts the *clock* there (`setUp`'s
 * `tick`) rather than re-stamping the file.
 * @param {string} snapshotsDir
 */
function parkSentinelHashes(snapshotsDir) {
  const name = listSnapshotNames(snapshotsDir).at(0);
  assert.ok(name, "expected the snapshot just taken");
  const path = join(snapshotsDir, snapshotFileName(name));
  const text = zstdDecompressSync(readFileSync(path)).toString("utf8");
  const parked = text
    .replace(/^[0-9a-f]{64}/gm, SENTINEL_HASH)
    .replace(/^(#END\s+)COMPLETE/m, "$1PARTIAL");
  writeFileSync(
    join(snapshotsDir, ".snapshot.lookup.tsv.zst"),
    zstdCompressSync(Buffer.from(parked, "utf8")),
  );
  unlinkSync(path);
}

/**
 * Rewrite the set's newest snapshot in place with sentinel hashes, leaving it as
 * the previous snapshot. The same trick as `parkSentinelHashes`, aimed at the
 * other hash source: a sentinel in the *next* snapshot can only have been reused
 * from this one, because it is nowhere on disk.
 * @param {string} snapshotsDir
 */
function plantSentinelSnapshot(snapshotsDir) {
  const name = listSnapshotNames(snapshotsDir).at(0);
  assert.ok(name, "expected the snapshot just taken");
  const path = join(snapshotsDir, snapshotFileName(name));
  const text = zstdDecompressSync(readFileSync(path)).toString("utf8");
  writeFileSync(
    path,
    zstdCompressSync(
      Buffer.from(text.replace(/^[0-9a-f]{64}/gm, SENTINEL_HASH), "utf8"),
    ),
  );
}

/**
 * Move every file's ctime to now, leaving its size and mtime exactly as they
 * are — what reading a file does on a volume behind the Windows Cloud Files
 * filter driver (OneDrive, Dropbox, Google Drive), and the reason the ctime
 * cross-check needed a boundary of its own (ADR-0085). `utimes` re-applying the
 * mtime a file already has is the portable way to touch only the change time;
 * the recorded mtime is millisecond-precision either way, so the size+mtime
 * match still stands and only the ctime guard can veto it.
 * @param {string} dir - A directory of files the snapshot covers
 */
function bumpCtimes(dir) {
  for (const entry of readdirSync(dir, {
    recursive: true,
    withFileTypes: true,
  })) {
    if (!entry.isFile()) {
      continue;
    }
    const path = join(entry.parentPath, entry.name);
    const { atime, mtime } = statSync(path);
    utimesSync(path, atime, mtime);
  }
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
   * A fixture set and a clock pinned *relative to real time*, in whole minutes.
   *
   * The ctimes these tests are about are real — the filesystem stamps them when
   * the fixture is copied and when `bumpCtimes` touches it — and a run's `#END`
   * trailer is the boundary they are judged against (ADR-0085). So the clock
   * has to be able to sit on either side of them: a run ticked to `-1` cannot
   * vouch for a file touched now, a run ticked to `+1` can. A minute of margin
   * either way keeps the two clocks involved (the kernel's, stamping ctimes,
   * and the process's) from ever being asked to agree to the millisecond,
   * which is the race a fixed 2025 pin plus a real-clock re-stamp used to run.
   * @param {TestContext} t
   */
  function setUp(t) {
    const origin = Temporal.Now.zonedDateTimeISO("Europe/London");
    let minutes = 0;
    t.mock.method(Temporal.Now, "zonedDateTimeISO", () =>
      origin.add({ minutes }),
    );
    const workDir = copyFixtureToWorkDir("before", t.fullName);
    const home = useTempHome(workDir());
    writeSet("photos", { dirs: [realpathSync.native(workDir())], bucket: "b" });
    return {
      snapshotsDir: join(home, ".s3cab", "sets", "photos", "snapshots"),
      workDir,
      /** @param {number} next - Minutes from real time the clock now reads */
      tick: (next) => (minutes = next),
    };
  }

  it("reuses them, then deletes the parked file once the snapshot lands", async (t) => {
    const { snapshotsDir, tick } = setUp(t);

    // Ahead of real time, so the parked trailer vouches for the fixture just
    // copied; the interrupted run read those files after they were written.
    tick(1);
    await snapshot("photos", { rehash: true });
    parkSentinelHashes(snapshotsDir);

    tick(2);
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

  it("keeps them when the interrupted run's own read moved every ctime", async (t) => {
    // The bug this whole boundary exists to fix, end to end. Run 1 finishes.
    // Run 2 reads the set — moving every ctime, as a synced volume does — and is
    // interrupted, parking those hashes. Run 3 must reuse them.
    //
    // Merged into one lookup there was a single instant to judge both sources
    // by, and it was run 1's: every parked row's ctime is *after* it, so the
    // resume threw away precisely the work the parking had saved. Each source
    // judged against its own completion instant, run 2's parking vouches for
    // rows run 2 hashed, and the sentinels survive.
    const { snapshotsDir, workDir, tick } = setUp(t);

    // Run 1 finishes before the ctimes move, so its trailer cannot vouch for
    // them — which is what makes the parked source the only thing that can.
    tick(-1);
    await snapshot("photos", { rehash: true });

    bumpCtimes(workDir());
    tick(1);
    await snapshot("photos", {});
    parkSentinelHashes(snapshotsDir);

    tick(2);
    await snapshot("photos", {});

    const hashes = await hashesIn(snapshotsDir);
    assert.ok(hashes.length, "expected file rows in the new snapshot");
    assert.deepEqual(
      [...new Set(hashes)],
      [SENTINEL_HASH],
      "the resume must reuse the parked hashes, not re-read the files",
    );
  });

  it("re-hashes when the previous snapshot is all there is to vouch for them", async (t) => {
    // The other half of the same fact, so the test above can't pass by the guard
    // simply being off: with *no* parked file, the same moved ctimes are judged
    // against run 1's completion instant — which cannot vouch for a file touched
    // after it — and every one is read again (ADR-0085).
    const { snapshotsDir, workDir, tick } = setUp(t);

    tick(-1);
    await snapshot("photos", { rehash: true });
    const before = await hashesIn(snapshotsDir);
    plantSentinelSnapshot(snapshotsDir);

    bumpCtimes(workDir());
    tick(1);
    await snapshot("photos", {});

    const hashes = await hashesIn(snapshotsDir);
    assert.deepEqual(
      [...new Set(hashes)].sort(),
      [...new Set(before)].sort(),
      "a touched file must be read again, not reuse the previous snapshot's hash",
    );
  });

  it("reuses them regardless under S3CAB_SKIP_CHANGE_TIME_CHECK", async (t) => {
    // The escape hatch, at the level a user meets it: the set's env file. On a
    // volume where reading a file moves its ctime the guard can never settle, so
    // the previous snapshot's hashes are trusted on size and mtime alone — what
    // the reuse test did before ADR-0085.
    const { snapshotsDir, workDir, tick } = setUp(t);

    tick(-1);
    await snapshot("photos", { rehash: true });
    plantSentinelSnapshot(snapshotsDir);

    bumpCtimes(workDir());
    tick(1);
    process.env.S3CAB_SKIP_CHANGE_TIME_CHECK = "1";
    await snapshot("photos", {});

    const hashes = await hashesIn(snapshotsDir);
    assert.ok(hashes.length, "expected file rows in the new snapshot");
    assert.deepEqual([...new Set(hashes)], [SENTINEL_HASH]);
  });

  it("ignores them under --rehash, which means re-hash everything", async (t) => {
    const { snapshotsDir, tick } = setUp(t);

    tick(1);
    await snapshot("photos", { rehash: true });
    parkSentinelHashes(snapshotsDir);

    tick(2);
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
