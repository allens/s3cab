import assert from "node:assert/strict";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
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
 * @param {TestContext} t
 */
function copyFixtureToWorkDir(fixtureName, t) {
  const fixtureDir = resolve("./test/fixtures", fixtureName);
  if (!readdirSync(fixtureDir).length) {
    throw new Error(`Fixture "${fixtureName}" does not exist or is empty`);
  }
  // Not a folder named after the test: those nest past Windows' 260-char
  // MAX_PATH, and `git worktree remove` then fails with "Filename too long".
  const tmpDir = resolve(mkdtempSync(join("test", ".tmp")));
  t.after(() => rmSync(tmpDir, { recursive: true, force: true }));
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
  it("errors for a set whose directory no longer exists", async (t) => {
    const workDir = copyFixtureToWorkDir("before", t);
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

    const workDir = copyFixtureToWorkDir("before", t);
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

    const workDir = copyFixtureToWorkDir("before", t);
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
      const workDir = copyFixtureToWorkDir("before", t);
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

    const workDir = copyFixtureToWorkDir("before", t);
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
 * Only the hashes and the status are rewritten. The `#SNAPSHOT` instant is kept
 * as the run minted it, because with no previous snapshot it is the
 * change-time boundary those rows are judged by (ADR-0094) — a test that needs
 * the boundary somewhere in particular puts the *clock* there (`setUp`'s
 * `tick`) rather than re-stamping the file.
 * @param {string} snapshotsDir
 * @param {object} [options]
 * @param {boolean} [options.dropLastRow] - Leave the last file row out, as a run stopped before it got there would
 */
function parkSentinelHashes(snapshotsDir, { dropLastRow } = {}) {
  const name = listSnapshotNames(snapshotsDir).at(0);
  assert.ok(name, "expected the snapshot just taken");
  const path = join(snapshotsDir, snapshotFileName(name));
  const text = zstdDecompressSync(readFileSync(path)).toString("utf8");
  const lines = text
    .replace(/^[0-9a-f]{64}/gm, SENTINEL_HASH)
    .replace(/^(#END\s+)COMPLETE/m, "$1PARTIAL")
    .split("\n");
  if (dropLastRow) {
    lines.splice(
      lines.findLastIndex((line) => line.startsWith(SENTINEL_HASH)),
      1,
    );
  }
  writeFileSync(
    join(snapshotsDir, ".snapshot.lookup.tsv.zst"),
    zstdCompressSync(Buffer.from(lines.join("\n"), "utf8")),
  );
  unlinkSync(path);
}

/**
 * Turn the set's newest snapshot into the *work file* a killed run leaves
 * (ADR-0092) — `parkSentinelHashes`'s violent twin, and the difference is the
 * whole point of `--resume`. A parked file was renamed aside on the way out by a
 * run that got to say goodbye; this one is still sitting at the lock name,
 * because nothing ran on the way out. So the trailer is cut off rather than
 * restamped `PARTIAL`, and the last line is left a prefix of a row: the process
 * died between the compressor's last flushed block and the end of the row it was
 * writing.
 * @param {string} snapshotsDir
 */
function killSentinelRun(snapshotsDir) {
  const name = listSnapshotNames(snapshotsDir).at(0);
  assert.ok(name, "expected the snapshot just taken");
  const path = join(snapshotsDir, snapshotFileName(name));
  const text = zstdDecompressSync(readFileSync(path)).toString("utf8");
  const rows = text
    .replace(/^[0-9a-f]{64}/gm, SENTINEL_HASH)
    .replace(/^#END.*\n?/m, "");
  writeFileSync(
    join(snapshotsDir, ".snapshot.tsv.zst"),
    zstdCompressSync(Buffer.from(`${rows}${SENTINEL_HASH}\t12`, "utf8")),
  );
  unlinkSync(path);
}

/**
 * Rewrite the set's newest snapshot in place with sentinel hashes, leaving it as
 * the previous snapshot. The same trick as `parkSentinelHashes`, aimed at the
 * other hash source: a sentinel in the *next* snapshot can only have been reused
 * from this one, because it is nowhere on disk.
 * @param {string} snapshotsDir
 * @param {object} [options]
 * @param {string} [options.hash] - The sentinel to plant, when a test needs to tell this source from the parked one
 * @param {string} [options.finished] - An instant to restamp the `#END` trailer with
 */
function plantSentinelSnapshot(
  snapshotsDir,
  { hash = SENTINEL_HASH, finished } = {},
) {
  const name = listSnapshotNames(snapshotsDir).at(0);
  assert.ok(name, "expected the snapshot just taken");
  const path = join(snapshotsDir, snapshotFileName(name));
  let text = zstdDecompressSync(readFileSync(path))
    .toString("utf8")
    .replace(/^[0-9a-f]{64}/gm, hash);
  if (finished) {
    text = text.replace(/^(#END[^\t]*\t[^\t]*\t)[^\t]*/m, `$1${finished}`);
  }
  writeFileSync(path, zstdCompressSync(Buffer.from(text, "utf8")));
}

/**
 * Move every file's ctime to now, leaving its size and mtime exactly as they
 * are — what reading a file does on a volume behind the Windows Cloud Files
 * filter driver (OneDrive, Dropbox, Google Drive), and the reason the
 * change-time check is opt-in (ADR-0094). `utimes` re-applying the
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

describe("snapshot (hashes an interrupted run left behind)", () => {
  /**
   * A fixture set and a clock pinned *relative to real time*, in whole minutes.
   *
   * The ctimes these tests are about are real — the filesystem stamps them when
   * the fixture is copied and when `bumpCtimes` touches it — and a run's start
   * is the boundary they are judged against (ADR-0094). So the clock
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
    const workDir = copyFixtureToWorkDir("before", t);
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

  it("trusts size and mtime alone by default, however the ctimes moved", async (t) => {
    // What reading does to every file on a synced volume, and the reason the
    // change-time check is opt-in (ADR-0094): left on, it would re-read them all.
    const { snapshotsDir, workDir, tick } = setUp(t);

    tick(-1);
    await snapshot("photos", { rehash: true });
    plantSentinelSnapshot(snapshotsDir);

    bumpCtimes(workDir());
    tick(1);
    await snapshot("photos", {});

    const hashes = await hashesIn(snapshotsDir);
    assert.ok(hashes.length, "expected file rows in the new snapshot");
    assert.deepEqual([...new Set(hashes)], [SENTINEL_HASH]);
  });

  it("re-hashes a file touched since the previous run started, under S3CAB_CHECK_CHANGE_TIME", async (t) => {
    // The opt-in at the level a user meets it: a line in the set's env file
    // (or the shell). A file whose ctime is after the previous run's start
    // cannot reuse that run's hash, whatever its size and mtime say.
    const { snapshotsDir, workDir, tick } = setUp(t);

    tick(-1);
    await snapshot("photos", { rehash: true });
    const before = await hashesIn(snapshotsDir);
    plantSentinelSnapshot(snapshotsDir);

    bumpCtimes(workDir());
    tick(1);
    process.env.S3CAB_CHECK_CHANGE_TIME = "1";
    await snapshot("photos", {});

    const hashes = await hashesIn(snapshotsDir);
    assert.deepEqual(
      [...new Set(hashes)].sort(),
      [...new Set(before)].sort(),
      "a touched file must be read again, not reuse the previous snapshot's hash",
    );
  });

  it("judges parked hashes by the stopped run's start when there is no previous snapshot", async (t) => {
    // An interrupted first seed: nothing earlier to take a boundary from, so the
    // parked file's own `#SNAPSHOT` instant is it. Ticked ahead of the fixture's
    // ctimes, it vouches for them; behind, it would veto every one — the half
    // below that proves the check is really on.
    const { snapshotsDir, tick } = setUp(t);
    process.env.S3CAB_CHECK_CHANGE_TIME = "1";

    tick(1);
    await snapshot("photos", { rehash: true });
    parkSentinelHashes(snapshotsDir);

    tick(2);
    await snapshot("photos", {});

    const hashes = await hashesIn(snapshotsDir);
    assert.ok(hashes.length, "expected file rows in the new snapshot");
    assert.deepEqual([...new Set(hashes)], [SENTINEL_HASH]);
  });

  it("re-hashes parked rows a run that started before the touch can't vouch for", async (t) => {
    const { snapshotsDir, workDir, tick } = setUp(t);
    process.env.S3CAB_CHECK_CHANGE_TIME = "1";

    tick(-1);
    await snapshot("photos", { rehash: true });
    const before = await hashesIn(snapshotsDir);
    parkSentinelHashes(snapshotsDir);

    bumpCtimes(workDir());
    tick(1);
    await snapshot("photos", {});

    const hashes = await hashesIn(snapshotsDir);
    assert.deepEqual([...new Set(hashes)].sort(), [...new Set(before)].sort());
  });

  it("judges by when the previous run started, not when it finished", async (t) => {
    // A file edited mid-run, after it was hashed: its ctime falls between the
    // run's `#SNAPSHOT` and `#END`, and only the start can veto it.
    const { snapshotsDir, workDir, tick } = setUp(t);
    process.env.S3CAB_CHECK_CHANGE_TIME = "1";

    tick(-1);
    await snapshot("photos", { rehash: true });
    const before = await hashesIn(snapshotsDir);
    const finished = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    plantSentinelSnapshot(snapshotsDir, { finished });

    bumpCtimes(workDir());
    tick(1);
    await snapshot("photos", {});

    const hashes = await hashesIn(snapshotsDir);
    assert.deepEqual([...new Set(hashes)].sort(), [...new Set(before)].sort());
  });

  describe("with a previous snapshot as well", () => {
    const PREVIOUS_HASH = "e".repeat(64);

    /**
     * Two runs: a finished one, then a later one stopped one row short of the
     * end. The previous snapshot carries one sentinel and the parked file
     * another, so every reused row names the source it came from.
     * @param {TestContext} t
     */
    async function setUpBoth(t) {
      const fixture = setUp(t);
      fixture.tick(-1);
      await snapshot("photos", { rehash: true });
      fixture.tick(1);
      await snapshot("photos", { rehash: true });
      const before = await hashesIn(fixture.snapshotsDir);
      parkSentinelHashes(fixture.snapshotsDir, { dropLastRow: true });
      plantSentinelSnapshot(fixture.snapshotsDir, { hash: PREVIOUS_HASH });
      fixture.tick(2);
      return { ...fixture, before };
    }

    it("lays parked rows over the previous snapshot's, keeping the rows only it has", async (t) => {
      const { snapshotsDir } = await setUpBoth(t);

      await snapshot("photos", {});

      const hashes = await hashesIn(snapshotsDir);
      assert.equal(
        hashes.filter((hash) => hash === PREVIOUS_HASH).length,
        1,
        "the row the stopped run never reached comes from the previous snapshot",
      );
      assert.ok(
        hashes.length > 1 &&
          hashes.every(
            (hash) => hash === PREVIOUS_HASH || hash === SENTINEL_HASH,
          ),
        "every other row comes from the parked file, the newer of the two",
      );
    });

    it("judges both by the previous snapshot's start, the older of the two", async (t) => {
      // The ctimes sit between the two starts: the parked run alone would vouch
      // for them, but the previous snapshot's rows are in the same lookup.
      const { snapshotsDir, workDir, before } = await setUpBoth(t);
      bumpCtimes(workDir());
      process.env.S3CAB_CHECK_CHANGE_TIME = "1";

      await snapshot("photos", {});

      const hashes = await hashesIn(snapshotsDir);
      assert.deepEqual(
        [...new Set(hashes)].sort(),
        [...new Set(before)].sort(),
      );
    });

    it("ignores a parked file older than the previous snapshot", async (t) => {
      // What a landed snapshot's best-effort delete leaves when it fails: its
      // rows would undo a `--rehash` that ran after them.
      const { snapshotsDir, tick } = setUp(t);
      const parkedPath = join(snapshotsDir, ".snapshot.lookup.tsv.zst");

      tick(1);
      await snapshot("photos", { rehash: true });
      parkSentinelHashes(snapshotsDir);
      const leftover = readFileSync(parkedPath);
      tick(2);
      await snapshot("photos", { rehash: true });
      writeFileSync(parkedPath, leftover);

      tick(3);
      await snapshot("photos", {});

      const hashes = await hashesIn(snapshotsDir);
      assert.ok(hashes.length, "expected file rows in the new snapshot");
      assert.ok(
        !hashes.includes(SENTINEL_HASH),
        "rows from before the previous snapshot must not be reused",
      );
    });
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

  // The `--resume` plumbing end to end (ADR-0092). The lib tests pin what
  // `recoverWorkFile` does to the files; this pins that the flag reaches it from
  // the command, and that the adopted hashes are really reused by the pass that
  // follows. Both halves in one test on purpose — the refusal is the whole reason
  // the flag exists, and split apart either could pass while the pair was broken.
  it("won't touch a killed run's work file, but --resume takes it over", async (t) => {
    const { snapshotsDir, tick } = setUp(t);

    tick(1);
    await snapshot("photos", { rehash: true });
    killSentinelRun(snapshotsDir);

    // From the outside that file is exactly a run still going, so the next
    // snapshot must refuse: ADR-0048 never breaks the lock on its own guess.
    // And refuse before the pass starts — for `backup` the same step runs ahead
    // of a store LIST and a walk that cost a minute on a large set.
    tick(2);
    const warn = t.mock.method(console, "warn", () => {});
    await assert.rejects(
      snapshot("photos", {}),
      /already in progress[\s\S]*same command again with --resume/,
    );
    assert.ok(
      !warn.mock.calls.some((call) =>
        String(call.arguments[0]).startsWith("Snapshotting"),
      ),
      "the refusal must come before the pass announces itself",
    );

    await snapshot("photos", { resume: true });

    // Every row came from the work file rather than being read again — and the
    // sentinel is nowhere on disk, so it can have come from nothing else.
    const hashes = await hashesIn(snapshotsDir);
    assert.ok(hashes.length, "expected file rows in the new snapshot");
    assert.deepEqual([...new Set(hashes)], [SENTINEL_HASH]);

    // Adopted, then consumed like any other parked lookup: neither name is left
    // behind to block the run after this one.
    assert.ok(
      !existsSync(join(snapshotsDir, ".snapshot.tsv.zst")),
      "the work file must not survive the run that adopted it",
    );
    assert.ok(
      !existsSync(join(snapshotsDir, ".snapshot.lookup.tsv.zst")),
      "a landed snapshot deletes the lookup it was adopted into",
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

    const workDir = copyFixtureToWorkDir("before", t);
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

    const workDir = copyFixtureToWorkDir("before", t);
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
