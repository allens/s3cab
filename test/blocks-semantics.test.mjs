import {
  closeSync,
  ftruncateSync,
  openSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { mkdtempDisposable } from "node:fs/promises";
import { join } from "node:path";
import { platform } from "node:process";
import { it } from "node:test";

// TEMPORARY PROBE — DELETE ONCE READ.
//
// ADR-0080 §3 leaves macOS out of online-only detection because APFS's `blocks`
// behaviour is unmeasured and no Mac was to hand. This file measures it on the
// `macos-14` CI runner, and prints the same table for the other two runners — the
// ADR already records those, so a discrepancy would show up too.
//
// It asserts nothing about the numbers; it prints them. The only assertion is the
// one thing that would be a real finding on any platform: an *ordinary* file, one
// with bytes genuinely written to it, is never `blocks === 0` at or above the 4KB
// floor. If that fires, `hasNoBytesOnDisk` has a false positive and the predicate
// is wrong rather than merely unported.
//
// **What it cannot do**: create a real dataless (iCloud Drive / OneDrive) file.
// So it can rule the predicate *out* on macOS — by showing that something ordinary
// wears the placeholder shape there — but it cannot rule it *in*. Turning macOS on
// still needs someone with a real synced Mac; this only says whether the idea is
// dead on arrival.
//
// Read the CI log, write the numbers into ADR-0080 §3, delete this file.

/** Below this, NTFS's MFT-resident files legitimately report no clusters. */
const RESIDENT_CEILING = 4096;

/**
 * Blocks allocated for one logical size, reached the two different ways — real
 * bytes written, and the file extended over a hole. That is exactly where the
 * platforms diverge: on ext4 the second is `blocks=0` and the first never is.
 * @param {string} dir - A disposable directory
 * @param {number} size - Logical size to produce
 * @returns {{ size: number, written: number, truncated: number }} 512-byte block counts
 */
function blocksFor(dir, size) {
  const writtenPath = join(dir, `written-${size}`);
  writeFileSync(writtenPath, Buffer.alloc(size, 0x61));

  const truncatedPath = join(dir, `truncated-${size}`);
  const fd = openSync(truncatedPath, "w");
  try {
    ftruncateSync(fd, size);
  } finally {
    closeSync(fd);
  }

  return {
    size,
    written: statSync(writtenPath).blocks,
    truncated: statSync(truncatedPath).blocks,
  };
}

it("PROBE: how this filesystem reports blocks (ADR-0080 §3)", async () => {
  await using dir = await mkdtempDisposable(join("test", ".tmp"));
  const rows = [1, 500, 700, 1500, 5000, 65_536, 262_144].map((size) =>
    blocksFor(dir.path, size),
  );

  console.log(`\n=== blocks probe: ${platform} ===`);
  console.table(rows);
  console.log(
    "written = bytes actually written; truncated = extended over a hole.\n" +
      "A placeholder-shaped file is size >= 4096 with blocks === 0.\n",
  );

  const falsePositive = rows.find(
    ({ size, written }) => size >= RESIDENT_CEILING && written === 0,
  );
  if (falsePositive) {
    throw new Error(
      `${platform}: ${falsePositive.size} bytes written to disk still reports ` +
        `blocks=0 — hasNoBytesOnDisk would call a real file a cloud placeholder`,
    );
  }
});
