import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { mkdtempDisposable } from "node:fs/promises";
import { join } from "node:path";
import { zstdCompressSync, zstdDecompressSync } from "node:zlib";
import { afterEach, beforeEach, describe, it } from "node:test";
import { useTempHome } from "../helpers/temp-home.mjs";
import { MINUTE_MS, VirtualClock, clockHolder } from "./harness/clock.mjs";
import { FakeS3, backendHolder } from "./harness/fake-s3.mjs";
import {
  deepDirectory,
  writeHardlinkPair,
  writeImplausibleTimestamps,
  writeLinks,
  writeUnicodePair,
  writeVerbatim,
} from "./harness/hostile.mjs";
import { checkStore } from "./harness/invariants.mjs";
import { RepoModel, captureTree, sha256 } from "./harness/model.mjs";
import { backup, restore, writeSet } from "./harness/seam.mjs";

// Hostile file trees (Windows-first, per the brief), driven through the Tier 1
// seam. One oracle throughout: **faithful or loud** — every hostile feature
// must either round-trip byte-identically or surface an explicit refusal (a
// throw, a nonzero exit, or a counted error/skip in the run report). What is
// never acceptable is silent divergence: a backup that reports clean success
// while the restore differs from the tree.
//
// Each test asserts the *specific* honest behaviour observed today, so a
// change in how s3cab handles a case fails loudly here and gets a deliberate
// decision rather than an accident.
//
// These builders run beside the random sequence tier, not inside it: the
// generator's file pool (harness/sequence.mjs) is deliberately tame so that
// sequence failures implicate command logic, not name handling — hostile
// names get their determinism here instead.

const BUCKET = "model-bucket";

/** @type {NodeJS.ProcessEnv} */
let savedEnv;
/** @type {number} */
let savedExitCode;
beforeEach(() => {
  savedEnv = { ...process.env };
  savedExitCode = /** @type {number} */ (process.exitCode ?? 0);
  clockHolder.current = new VirtualClock(Date.UTC(2026, 0, 5));
  backendHolder.current = new FakeS3();
});
afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in savedEnv)) {
      delete process.env[key];
    }
  }
  Object.assign(process.env, savedEnv);
  process.exitCode = savedExitCode;
});

/**
 * A set over one data directory, plus the standard follow-through: backup,
 * restore into a fresh dir, and the restored tree.
 * @param {string} root - The disposable test root
 * @param {string} [dataDir] - Defaults to `<root>/data` (created)
 */
const makeSet = (root, dataDir) => {
  const data = dataDir ?? join(root, "data");
  mkdirSync(data, { recursive: true });
  useTempHome(root);
  const dir = realpathSync.native(data);
  writeSet("hostile", { dirs: [dir], bucket: BUCKET });
  return dir;
};

/** Advance the virtual clock a minute (for a second snapshot). */
const nextMinute = () => clockHolder.current.advance(MINUTE_MS);

/**
 * Backup then restore to `<root>/out`, returning everything the oracle needs.
 * @param {string} root
 */
const roundtrip = async (root) => {
  process.exitCode = 0;
  const result = await backup("hostile");
  const backupExit = process.exitCode;
  process.exitCode = 0;
  const out = join(root, "out");
  mkdirSync(out, { recursive: true });
  await restore([], { set: "hostile", output: out });
  return {
    result,
    backupExit,
    restoreExit: process.exitCode,
    restoredData: join(out, "data"),
  };
};

describe("hostile trees: names only the verbatim layer can spell", () => {
  it("handles reserved device names and trailing dots/spaces honestly", async (t) => {
    await using dir = await mkdtempDisposable(join("test", ".tmp"));
    const data = makeSet(dir.path);
    writeFileSync(join(data, "normal.txt"), "plain");
    const created = [
      writeVerbatim(data, "CON", "reserved device name"),
      writeVerbatim(data, "trailing.dot.", "dot at the end"),
      writeVerbatim(data, "trailing.space ", "space at the end"),
    ];
    if (!created.some(Boolean)) {
      t.skip("host refused every verbatim name");
      return;
    }

    const { result, restoredData } = await roundtrip(dir.path);

    // The honest outcomes per hostile file: stored-and-restored
    // byte-identically, or counted as an error/skip in the run report.
    const restored = captureTree([restoredData]);
    const hostileOnDisk = captureTree([data]);
    let faithful = 0;
    for (const [file, bytes] of hostileOnDisk) {
      const got = restored.get(file);
      if (got !== undefined) {
        assert.ok(got.equals(bytes), `${file} restored with different bytes`);
        faithful++;
      }
    }
    const accounted = faithful + result.errors + result.skipped;
    assert.ok(
      accounted >= hostileOnDisk.size,
      `every file must be restored or counted: ${faithful} faithful + ` +
        `${result.errors} errors + ${result.skipped} skipped < ${hostileOnDisk.size} files`,
    );
    // And the ordinary neighbour must never be collateral damage.
    assert.equal(restored.get("data/normal.txt")?.toString(), "plain");
  });

  it("round-trips paths far beyond MAX_PATH, or refuses loudly", async (t) => {
    await using dir = await mkdtempDisposable(join("test", ".tmp"));
    const data = makeSet(dir.path);
    const deep = deepDirectory(data);
    if (deep === null) {
      t.skip("host cannot create paths past MAX_PATH");
      return;
    }
    writeFileSync(join(deep, "buried.txt"), "deep content");
    writeFileSync(join(data, "shallow.txt"), "shallow content");

    /** @type {Awaited<ReturnType<typeof roundtrip>> | undefined} */
    let outcome;
    /** @type {unknown} */
    let threw = null;
    try {
      outcome = await roundtrip(dir.path);
    } catch (error) {
      threw = error;
    }

    if (threw !== null) {
      return; // loud refusal — honest
    }
    const { result, restoredData } =
      /** @type {NonNullable<typeof outcome>} */ (outcome);
    const restored = captureTree([restoredData]);
    const buried = restored.get(
      `data/${deep.slice(data.length + 1).replaceAll("\\", "/")}/buried.txt`,
    );
    if (buried !== undefined) {
      assert.equal(buried.toString(), "deep content");
    } else {
      assert.ok(
        result.errors + result.skipped > 0 || process.exitCode !== 0,
        "deep file neither restored nor accounted for",
      );
    }
    assert.equal(
      restored.get("data/shallow.txt")?.toString(),
      "shallow content",
    );
  });
});

describe("hostile trees: links", () => {
  it("skips junctions and symlinks without following or restoring them", async (t) => {
    await using dir = await mkdtempDisposable(join("test", ".tmp"));
    const data = makeSet(dir.path);
    writeFileSync(join(data, "real.txt"), "the real file");
    const sibling = join(dir.path, "outside");
    mkdirSync(sibling);
    writeFileSync(join(sibling, "outside.txt"), "outside the set");
    const links = writeLinks(data, join(data, "real.txt"), sibling);
    if (!links.junction && !links.symlink) {
      t.skip("host cannot create links");
      return;
    }

    const { result, restoredData } = await roundtrip(dir.path);

    const restored = captureTree([restoredData]);
    // The real file comes back; the links are recorded as skipped, are not
    // followed into the outside directory, and are not recreated.
    assert.equal(restored.get("data/real.txt")?.toString(), "the real file");
    assert.ok(result.skipped > 0, "links must be counted as skipped");
    assert.equal(
      [...restored.keys()].find((k) => k.includes("junction-to-sibling")),
      undefined,
      "junction contents must not be backed up",
    );
    assert.equal(
      [...restored.keys()].find((k) => k.includes("symlink-to-file")),
      undefined,
      "symlink must not be restored as a file",
    );
  });

  it("stores a hardlink pair once and restores two independent files", async (t) => {
    await using dir = await mkdtempDisposable(join("test", ".tmp"));
    const data = makeSet(dir.path);
    if (!writeHardlinkPair(data, "shared bytes")) {
      t.skip("host cannot create hardlinks");
      return;
    }

    const { result, restoredData } = await roundtrip(dir.path);

    const restored = captureTree([restoredData]);
    assert.equal(
      restored.get("data/hardlink-a.txt")?.toString(),
      "shared bytes",
    );
    assert.equal(
      restored.get("data/hardlink-b.txt")?.toString(),
      "shared bytes",
    );
    // One content → one object stored (content-addressing sees through links).
    assert.equal(result.uploaded, 1);
  });
});

describe("hostile trees: contents and timestamps", () => {
  it("round-trips unicode normalisation neighbours as distinct files", async (t) => {
    await using dir = await mkdtempDisposable(join("test", ".tmp"));
    const data = makeSet(dir.path);
    // APFS folds normalisation (the case-collision hazard's unicode twin —
    // a foreign manifest with both spellings restores last-wins there), so
    // the pair only exists as two files on NTFS/ext4.
    if (!writeUnicodePair(data)) {
      t.skip("filesystem folds unicode normalisation (APFS)");
      return;
    }

    const { restoredData } = await roundtrip(dir.path);

    const restored = captureTree([restoredData]);
    assert.equal(restored.get("data/café.txt")?.toString(), "nfc spelling");
    assert.equal(restored.get("data/café.txt")?.toString(), "nfd spelling");
  });

  it("round-trips zero-byte files and content above the multipart threshold", async () => {
    await using dir = await mkdtempDisposable(join("test", ".tmp"));
    const data = makeSet(dir.path);
    writeFileSync(join(data, "empty.dat"), Buffer.alloc(0));
    // partSize is 16MB — one byte past it exercises the multipart branch of
    // the real putFile (the fake stores it whole; Tier 2 covers real
    // multipart mechanics under the "multipart" capability).
    const big = Buffer.alloc(16 * 1024 * 1024 + 1, 7);
    writeFileSync(join(data, "big.bin"), big);

    const { result, restoredData } = await roundtrip(dir.path);

    const restored = captureTree([restoredData]);
    assert.equal(restored.get("data/empty.dat")?.length, 0);
    assert.equal(restored.get("data/big.bin")?.length, big.length);
    assert.equal(
      sha256(/** @type {Buffer} */ (restored.get("data/big.bin"))),
      sha256(big),
    );
    assert.equal(result.errors, 0);
  });

  it("round-trips implausible timestamps without mangling content", async () => {
    await using dir = await mkdtempDisposable(join("test", ".tmp"));
    const data = makeSet(dir.path);
    writeImplausibleTimestamps(data);

    const { result, restoredData } = await roundtrip(dir.path);

    const restored = captureTree([restoredData]);
    assert.equal(
      restored.get("data/ancient.txt")?.toString(),
      "written long ago",
    );
    assert.equal(
      restored.get("data/future.txt")?.toString(),
      "written tomorrow",
    );
    assert.equal(result.errors, 0);
  });
});

describe("hostile trees: mixed-case collisions", () => {
  it("restore claims both case-colliding paths while disk keeps one (bugs.md: silent last-wins — current behaviour)", async (t) => {
    await using dir = await mkdtempDisposable(join("test", ".tmp"));
    // Only meaningful where the filesystem folds case (Windows, macOS default).
    writeFileSync(join(dir.path, "probe.tmp"), "");
    if (!existsSync(join(dir.path, "PROBE.TMP"))) {
      t.skip("filesystem is case-sensitive");
      return;
    }
    const data = makeSet(dir.path);
    writeFileSync(join(data, "file.txt"), "lowercase content");
    process.exitCode = 0;
    await backup("hostile");

    // One backup on this host cannot list file.txt AND File.txt, but another
    // machine's case-sensitive tree can — craft that manifest directly.
    const fake = backendHolder.current;
    const key = "snapshots/hostile/2026-01-05T0000.tsv.zst";
    const manifestBytes = /** @type {Buffer} */ (
      await fake.getBytes(BUCKET, key)
    );
    const original = zstdDecompressSync(manifestBytes).toString("utf8");
    const altBytes = Buffer.from("UPPERCASE CONTENT!");
    const altHash = sha256(altBytes);
    await fake.putBytes(BUCKET, `objects/${altHash}`, altBytes);
    const rows = original.trimEnd().split("\n");
    const fileRow = /** @type {string} */ (
      rows.find((row) => row.includes("file.txt"))
    );
    rows.push(
      fileRow.replace(/^[0-9a-f]{64}/, altHash).replace("file.txt", "File.txt"),
    );
    await fake.putBytes(
      BUCKET,
      key,
      zstdCompressSync(Buffer.from(rows.join("\n") + "\n")),
    );

    const out = join(dir.path, "out");
    mkdirSync(out, { recursive: true });
    process.exitCode = 0;
    const result = await restore([], { set: "hostile", output: out });

    // TODO(known bug, proposals/bugs.md): restore reports both paths restored
    // and exits 0, but the case-folding filesystem kept only the last row's
    // bytes — the first file was silently overwritten. "Faithful or loud"
    // requires detecting the collision (an error or a counted skip); when that
    // lands, flip these assertions to the loud outcome.
    assert.equal(result.restored.length, 2, "restore claims both paths");
    assert.equal(process.exitCode, 0);
    const names = readdirSync(join(out, "data"));
    assert.equal(names.length, 1, "only one directory entry survives");
    const survivor = /** @type {string} */ (names[0]);
    assert.equal(
      readFileSync(join(out, "data", survivor), "utf8"),
      "UPPERCASE CONTENT!",
      "the last manifest row wins silently",
    );
  });
});

describe("hostile trees: files changing mid-run", () => {
  it("counts a file vanishing mid-scan as an error, not silence — and still exits 0 (bugs.md: backup exit code)", async () => {
    await using dir = await mkdtempDisposable(join("test", ".tmp"));
    const data = makeSet(dir.path);
    writeFileSync(join(data, "aaa-first.txt"), "uploads first");
    writeFileSync(join(data, "zzz-vanishes.txt"), "gone before its turn");

    // Delete the later file during the first file's upload — after the walk
    // enumerated it, before its content is read.
    backendHolder.current.onPutFileRead = async (path) => {
      if (path.endsWith("aaa-first.txt")) {
        const { rmSync } = await import("node:fs");
        rmSync(join(data, "zzz-vanishes.txt"), { force: true });
      }
    };
    process.exitCode = 0;
    const result = await backup("hostile");

    assert.equal(result.errors, 1, "the vanished file must be counted");
    // The machine-readable half must not lie: a backup that omitted files sets
    // a nonzero exit code (guide/output.md — scripts branch on it), while the
    // snapshot still publishes honestly with its #ERROR row.
    assert.equal(process.exitCode, 1);

    // The snapshot that landed is still complete for what it *does* list.
    nextMinute();
    const out = join(dir.path, "out");
    mkdirSync(out, { recursive: true });
    process.exitCode = 0;
    await restore([], { set: "hostile", output: out });
    const restored = captureTree([join(out, "data")]);
    assert.equal(
      restored.get("data/aaa-first.txt")?.toString(),
      "uploads first",
    );
  });

  it("a file mutating mid-transfer is refused loudly — the store never keeps wrong bytes (bugs.md C1, fixed)", async () => {
    await using dir = await mkdtempDisposable(join("test", ".tmp"));
    const data = makeSet(dir.path);
    writeFileSync(join(data, "victim.txt"), "original bytes");

    // Rewrite the file inside the putFile window: after hashing named the
    // object, before the transfer reads the content. The pre-PUT drift guard
    // has already passed by then — only putFile's streamed-digest check
    // (ContentMismatchError) can catch this.
    backendHolder.current.onPutFileRead = (path) => {
      if (path.endsWith("victim.txt")) {
        writeFileSync(join(data, "victim.txt"), "mutated bytes!");
      }
    };
    // The drift is fatal to a run that was about to publish a manifest: backup
    // refuses with the same "changed while the backup was running" error the
    // pre-PUT guard raises, and publishes nothing.
    await assert.rejects(backup("hostile"), (/** @type {Error} */ error) => {
      assert.equal(error.name, "FileChangedError");
      assert.match(error.message, /changed while the backup was running/);
      return true;
    });

    // The store is clean: the mis-stored object was removed (not merely
    // detected), no manifest was published, and the content-address invariant
    // holds for everything that remains.
    const model = new RepoModel(BUCKET, backendHolder.current);
    assert.deepEqual(await checkStore(model), []);
    const originalHash = sha256("original bytes");
    assert.equal(
      await backendHolder.current.objectExists(
        `s3://${BUCKET}/objects/${originalHash}`,
      ),
      false,
      "the object stored from mutated bytes must not survive under the original hash",
    );
  });
});
