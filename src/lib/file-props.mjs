import crypto, { createHash } from "node:crypto";
import { createReadStream, lstatSync, readFileSync } from "node:fs";
import { platform } from "node:process";
import { pipeline } from "node:stream/promises";
import { OnlineOnlyFileError } from "./error.mjs";

/** @import { Stats } from "node:fs" */
/** @import { Props, SnapshotEntries } from "./snapshot-file.mjs" */

/**
 * A hash in progress, for a caller drawing a progress line. Reported once, when
 * the read starts, carrying a `read` the caller polls on its own clock rather
 * than an event per chunk — the same read-don't-subscribe shape the upload's
 * transfer state uses, and for the same reason: the renderer's cadence should
 * not be set by how fast bytes happen to arrive.
 *
 * Only the *streaming* branch reports. A file below the slurp boundary is read
 * in one call with no intermediate count — and is far too small to spend the
 * second that would earn it a line anyway.
 * @typedef {Object} HashProgress
 * @property {string} path - The file being hashed
 * @property {number} size - Its size in bytes, from the `lstat` already taken
 * @property {number} startedAt - `performance.now()` when the read began
 * @property {() => number} read - Bytes hashed so far
 */

/**
 * SHA-256 of nothing — the digest every empty file has. Derived once at module
 * load rather than written out as a literal, so it cannot be mistyped and needs
 * no comment vouching for it.
 *
 * The `size === 0` shortcut it serves is **not** a micro-optimization: reading a
 * zero-byte file still costs an open/read/close, measured at ~81µs against ~1µs
 * to hash nothing. That is per empty file, on the walk/snapshot hot path where
 * CLAUDE.md warns small costs mount up — 20,000 of them is 1.6s against 15ms.
 */
const EMPTY_DIGEST = crypto.hash("sha256", "", "hex");

/**
 * The size below which "nothing allocated on disk" means nothing at all.
 *
 * **Load-bearing, not a fudge.** NTFS stores a small file *resident in the MFT*,
 * with no clusters allocated to it, so a bare `blocks === 0` calls every tiny
 * file a placeholder. Measured on Windows 11/NTFS: 1, 50, 100 and 500 bytes all
 * report `blocks=0`; 700 → 1, 900 → 8, 1500 → 8, 5000 → 16. 4KB clears that
 * resident ceiling (~700 bytes) with room to spare, and sits below any download
 * worth warning about — hydrating a sub-cluster placeholder costs nothing, so
 * there is no reason to catch one.
 */
const RESIDENT_CEILING = 4096;

/**
 * Whether a stat describes a file with a full logical size and **no bytes behind
 * it** — the shape a dehydrated cloud-sync placeholder has.
 *
 * Pure, and takes the two numbers rather than a platform, so the rule itself is
 * assertable on every CI runner while {@link DETECT_ONLINE_ONLY} decides where it
 * is *consulted*. What it observes is only "size, but no allocation": a fully
 * sparse file looks identical and there is no syscall in Node that tells the two
 * apart (macOS has `SF_DATALESS`, which `Stats` does not expose). That ambiguity
 * is why this is confined to Windows, where measurement showed the shape belongs
 * to placeholders — see {@link DETECT_ONLINE_ONLY}.
 * @param {Pick<Stats, "size" | "blocks">} stat - A stat already taken; this adds no syscall
 * @returns {boolean}
 */
export const hasNoBytesOnDisk = ({ size, blocks }) =>
  size >= RESIDENT_CEILING && blocks === 0;

/**
 * Whether to consult {@link hasNoBytesOnDisk} at all — **Windows only**, decided
 * once at module load because it can never change within a run.
 *
 * Measured on both sides before being trusted, because `blocks` does not mean the
 * same thing everywhere:
 *
 * - **Windows/NTFS** is where the problem is (Files On-Demand: OneDrive, Dropbox,
 *   Google Drive) and where the signal is clean, given the 4KB floor above.
 * - **Linux/ext4** has no Files-On-Demand implementation to catch, so the rule
 *   could only ever cost something here. Measured on ext4: no file is ever
 *   `blocks === 0` on size alone (1 byte already allocates a 4KB block, since
 *   `inline_data` is off by default) and delayed allocation is accounted for
 *   immediately — but a **fully sparse** file reads exactly like a placeholder
 *   (`truncate -s 1G` → `size=1073741824 blocks=0`). Torrent preallocation and a
 *   fresh `qemu-img` disk are both that shape, so enabling this on Linux would
 *   drop real files from a backup and misname the reason.
 * - **macOS** does have Files On-Demand, but its true signal is `st_flags &
 *   SF_DATALESS`, which Node's `Stats` doesn't carry, and APFS's sparse-file
 *   behaviour is unmeasured. Left off rather than guessed at; widening this is a
 *   one-line change once someone measures a real dataless file on a Mac.
 */
const DETECT_ONLINE_ONLY = platform === "win32";

/**
 * Compute a file's content properties — its `hash`, `size`, and `mtime` — from
 * the file on disk, reusing the stored hash from a previous snapshot's `lookup`
 * when the file is unchanged (same `size` *and* `mtime`), so an unchanged file is
 * never re-hashed.
 *
 * The `lib` hashing primitive behind both callers: the `prop` command (which
 * resolves a `--lookup <snapshot>` path into the `lookup` Map) and the snapshot
 * writer's injected `getProps` (bound by `snapshot`, see commands/snapshot.mjs).
 * It lives in `lib` so the snapshot pipeline reaches it directly instead of
 * smuggling a `commands/` function across the porcelain/lib seam (ADR-0023).
 *
 * One `lstat`, deliberately: its `size`/`mtime` drive both the reuse check and
 * the returned `Props`, so threading a second stat in for either is the per-file
 * overhead CLAUDE.md warns against in the walk/snapshot hot path. Its `blocks`
 * now drive the online-only check too, on the same principle — the detection
 * costs no syscall because the stat was already paid for.
 * @param {string} path - The file to inspect
 * @param {SnapshotEntries} [lookup] - Previous-snapshot entries; an unchanged file reuses its stored hash
 * @param {object} [options]
 * @param {(hashing: HashProgress) => void} [options.onHashStart] - Called when a
 *   file is big enough to be hashed by streaming, so a progress line can report it
 * @param {boolean} [options.includeOnlineOnly] - Read a cloud placeholder anyway,
 *   downloading it (`--include-online-only`). Off by default, so the default backup
 *   never pulls a cloud account onto the disk it is being backed up from
 * @returns {Promise<Props>} The file's hash/size/mtime (no `hashDuration` when reused from `lookup`)
 * @throws {OnlineOnlyFileError} When the file is a dehydrated cloud placeholder
 *   and `includeOnlineOnly` is not set — the caller turns this into a `#SKIPPED`
 *   row, not an `#ERROR` one (ADR-0080)
 */
export async function fileProps(
  path,
  lookup,
  { onHashStart, includeOnlineOnly } = {},
) {
  const start = Temporal.Now.instant();

  const stat = lstatSync(path);
  if (!stat.isFile()) {
    throw new Error(`Not a regular file: ${path}`);
  }

  const { size, mtime } = stat;

  const fromLookup = lookup?.get(path);
  if (
    fromLookup &&
    fromLookup.size === size &&
    fromLookup.mtime === mtime.toISOString()
  ) {
    return fromLookup;
  }

  // **After the reuse check, never before it** — this ordering is the whole
  // reason a synced set stays backed up rather than falling out of the backup
  // the first time the sync client reclaims space. `mtime` is byte-identical
  // across hydrated → dehydrated → rehydrated (only `ctime` moves), so a file
  // already recorded in the baseline reuses its stored hash here without the
  // file ever being opened, whatever its bytes are doing on disk today. Check
  // first and a placeholder s3cab already holds would start reporting as skipped
  // — and `compare` would show it *leaving* the set — purely because OneDrive
  // freed some space. Only a file with no usable stored hash gets this far, so
  // the choice is genuinely "download it, or say we didn't".
  if (
    DETECT_ONLINE_ONLY &&
    !includeOnlineOnly &&
    hasNoBytesOnDisk({ size, blocks: stat.blocks })
  ) {
    throw new OnlineOnlyFileError(path);
  }

  let hash;
  // Slurp small files (one-shot crypto.hash) and stream larger ones to bound
  // memory. The 5 MB boundary was chosen empirically on real data; worth
  // re-measuring during any future perf pass (proposals/performance.md).
  // The stream path deliberately takes Node's default highWaterMark — an
  // explicit 8 MB read buffer here was measured to buy nothing for SHA-256 and
  // was dropped as a relic. Don't reintroduce one without a measurement.
  if (size >= 5_000_000) {
    const hasher = createHash("sha256");
    const source = createReadStream(path);
    // `bytesRead` is a plain property the stream maintains anyway, so reporting
    // costs one object at the start of a large file's read and nothing per
    // chunk. The size comes from the `lstat` above — no second stat, and none
    // in the caller's render path, which is the whole reason this is reported
    // from in here rather than derived outside.
    onHashStart?.({
      path,
      size,
      startedAt: performance.now(),
      read: () => source.bytesRead,
    });
    await pipeline(source, hasher);
    hash = hasher.digest("hex");
  } else if (size) {
    hash = crypto.hash("sha256", readFileSync(path), "hex");
  } else {
    hash = EMPTY_DIGEST;
  }

  return {
    size,
    mtime: mtime.toISOString(),
    hash,
    hashDuration: Temporal.Now.instant()
      .since(start)
      .round("milliseconds")
      .total("seconds"),
  };
}
