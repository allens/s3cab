import assert from "node:assert/strict";
import * as realFs from "node:fs";
import { writeFileSync } from "node:fs";
import { mkdtempDisposable } from "node:fs/promises";
import { join } from "node:path";
import { platform } from "node:process";
import { describe, it, mock } from "node:test";

// Detection of dehydrated cloud-sync placeholders — Windows Files On-Demand
// (OneDrive, and the same shape in Dropbox and Google Drive), which leave a file
// with its full logical size and no bytes behind it, fetched on first read
// (ADR-0081).
//
// Its own file, and a dotted aspect name (ADR-0049), because a placeholder
// cannot be *made* on the test machine: NTFS allocates on a truncate-extend
// (measured: `truncateSync(f, 1MB)` → `blocks=2048`, not 0), and `fsutil sparse`
// needs elevation. So the stat has to be mocked, which means mocking `node:fs`
// before `file-props.mjs` is loaded — the same constraint that gave
// `walk.unknown-dirent.test.mjs` its own file.

/** The size a placeholder reports. Any value at or above the 4KB floor will do. */
const LOGICAL_SIZE = 262_144;

/** @type {Set<string>} Paths the mocked `lstat` reports as having no bytes on disk */
const dehydrated = new Set();

const passthrough = Object.fromEntries(
  Object.entries(realFs).filter(([name]) => name !== "constants"),
);

mock.module("node:fs", {
  exports: {
    ...passthrough,
    /**
     * The real stat, with `size`/`blocks` rewritten for a registered path — so
     * every other field (`mtime` above all, which drives the reuse check this
     * ordering depends on) stays the genuine article.
     * @param {string} path
     */
    lstatSync: (path) => {
      const stat = realFs.lstatSync(path);
      if (!dehydrated.has(path)) {
        return stat;
      }
      return Object.create(stat, {
        size: { value: LOGICAL_SIZE, enumerable: true },
        blocks: { value: 0, enumerable: true },
      });
    },
  },
});

const { fileProps, hasNoBytesOnDisk } = await import("./file-props.mjs");
const { OnlineOnlyFileError } = await import("./error.mjs");

const mkTmpDir = async () => mkdtempDisposable(join("test", ".tmp"));

/**
 * A real file on disk that the mocked `lstat` then reports as a placeholder.
 * @param {string} dir - A disposable temp directory the caller owns
 * @returns {string} The file's path
 */
function placeholderIn(dir) {
  const path = join(dir, "IMG_0421.jpg");
  writeFileSync(path, "the bytes OneDrive would have had to fetch");
  dehydrated.add(path);
  return path;
}

describe("hasNoBytesOnDisk", () => {
  it("is true only for a full logical size with nothing allocated behind it", () => {
    assert.equal(hasNoBytesOnDisk({ size: 262_144, blocks: 0 }), true);
    assert.equal(hasNoBytesOnDisk({ size: 4096, blocks: 0 }), true);
    // Hydrated: 262,144 bytes really on disk is 512 512-byte blocks.
    assert.equal(hasNoBytesOnDisk({ size: 262_144, blocks: 512 }), false);
  });

  it("holds the 4KB floor, so an MFT-resident small file is not a placeholder", () => {
    // NTFS keeps a small file *inside* the MFT record, allocating no clusters to
    // it — measured on Windows 11: 1, 50, 100 and 500 bytes all report blocks=0,
    // then 700 → 1, 900 → 8, 1500 → 8, 5000 → 16. Without the floor every one of
    // those tiny files reads as a cloud placeholder and drops out of the backup,
    // which is why the constant is load-bearing rather than a fudge.
    for (const size of [1, 50, 100, 500, 700, 4095]) {
      assert.equal(
        hasNoBytesOnDisk({ size, blocks: 0 }),
        false,
        `${size} bytes with no clusters is MFT-resident, not a placeholder`,
      );
    }
  });

  it("is false for an empty file, which has nothing to be missing", () => {
    assert.equal(hasNoBytesOnDisk({ size: 0, blocks: 0 }), false);
  });
});

describe("fileProps on a cloud placeholder", () => {
  it("refuses to download it on Windows, and reads it anywhere else", async () => {
    // One assertion per platform rather than a skip, because the *split* is the
    // decision under test (ADR-0081): Windows is where Files On-Demand exists and
    // where the signal was measured clean, while on ext4 the identical shape is a
    // fully sparse file (`truncate -s 1G` → blocks=0) — a real file that must
    // stay in the backup, and one no Linux cloud client would have made.
    await using dir = await mkTmpDir();
    const path = placeholderIn(dir.path);

    if (platform === "win32") {
      await assert.rejects(fileProps(path), OnlineOnlyFileError);
      await assert.rejects(fileProps(path), {
        message: /Stored online, not on this computer/,
      });
    } else {
      const props = await fileProps(path);
      assert.equal(typeof props.hash, "string");
    }
  });

  it("downloads it when --include-online-only says to", async () => {
    await using dir = await mkTmpDir();
    const path = placeholderIn(dir.path);

    const props = await fileProps(path, undefined, {
      includeOnlineOnly: true,
    });

    // It really hashed the file rather than short-circuiting: `hashDuration` is
    // set only on a path that read bytes.
    assert.equal(typeof props.hash, "string");
    assert.notEqual(props.hashDuration, undefined);
  });

  it("reuses a stored hash for one already in the baseline, instead of skipping it", async () => {
    // The ordering that keeps a synced set backed up. `mtime` is byte-identical
    // across hydrated → dehydrated → rehydrated (only `ctime` moves), so a file
    // s3cab already holds must keep reusing its stored hash however OneDrive is
    // storing it today. Check the placeholder shape *before* the lookup and a
    // file already in the backup starts reporting as skipped — `compare` would
    // show it leaving the set — purely because the sync client freed some space.
    await using dir = await mkTmpDir();
    const path = placeholderIn(dir.path);
    const { size, mtime } = realFs.lstatSync(path);
    const stored = {
      hash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      size,
      mtime: mtime.toISOString(),
    };

    const props = await fileProps(path, [
      { entries: new Map([[path, { ...stored, size: LOGICAL_SIZE }]]) },
    ]);

    assert.equal(props.hash, stored.hash);
    // Reused, not re-derived: no `hashDuration` on a lookup hit.
    assert.equal(props.hashDuration, undefined);
  });

  it("keeps reusing when dehydration bumped ctime past the baseline", async () => {
    // The ctime staleness guard (ADR-0085) must exempt the placeholder shape:
    // dehydration moves *only* ctime, so distrusting the match here would make
    // every file the sync client reclaims read as touched — and, having no
    // bytes to re-hash, drop out of the backup. On other platforms the same
    // stat shape is a real sparse file, so the guard applies and re-reads it.
    await using dir = await mkTmpDir();
    const path = placeholderIn(dir.path);
    const { mtime } = realFs.lstatSync(path);
    const stored = {
      hash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      size: LOGICAL_SIZE,
      mtime: mtime.toISOString(),
    };
    // The file was just written, so its ctime is after this baseline instant.
    const lookups = [
      {
        entries: new Map([[path, stored]]),
        baselineMs: Date.parse("2020-01-01T00:00:00.000Z"),
      },
    ];

    if (platform === "win32") {
      const props = await fileProps(path, lookups);
      assert.equal(props, stored);
    } else {
      const props = await fileProps(path, lookups);
      assert.notEqual(props.hash, stored.hash);
      assert.notEqual(props.hashDuration, undefined);
    }
  });
});
