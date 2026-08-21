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
 * - **macOS** does have Files On-Demand, so it was measured rather than assumed —
 *   and APFS turns out to behave like ext4: a written file always allocates
 *   (1 byte → 8 blocks, so no false positive from small files), but every
 *   truncate-extended file reports `blocks=0` at every size. Same collision, and
 *   sparse files are ordinary there. Its true signal is `st_flags & SF_DATALESS`,
 *   which Node's `Stats` doesn't carry, so reopening macOS needs a way to read
 *   `st_flags` — not another look at `blocks`.
 */
const DETECT_ONLINE_ONLY = platform === "win32";

/**
 * One place a stored hash may be reused from, paired with the moment that makes
 * its entries trustworthy: the instant its file's last row was written, in epoch
 * milliseconds.
 *
 * A pass has **two** such sources and they do not share a boundary — which is
 * the whole reason this is a pair rather than a Map and a number. The previous
 * snapshot's rows were written when that snapshot finished; an interrupted run's
 * parked rows were written when the user stopped it, typically much later
 * (ADR-0067). Merging them into one Map left one boundary to judge both by, and
 * it was the older one, so every parked hash read as touched and was thrown
 * away — the resume re-hashed exactly the files the parking had saved.
 *
 * `baselineMs` absent means "trust a size+mtime match on its own": no ctime
 * cross-check, the pre-ADR-0085 behaviour. That is what the `prop` command's
 * `--lookup` gets (it has no snapshot instant to offer) and what
 * `S3CAB_SKIP_CHANGE_TIME_CHECK` asks for.
 * @typedef {Object} HashSource
 * @property {SnapshotEntries} entries - The stored hashes
 * @property {number} [baselineMs] - When they were written, in epoch ms; absent = no cross-check
 */

/**
 * Why a file had to be read rather than reusing a stored hash — a fact about
 * *this run*, not about the file, so it rides back on the returned `Props`
 * beside `hashDuration` and is never written to a snapshot.
 *
 * The three are worth telling apart because they call for completely different
 * responses. `changed` is the system working: the file really is different.
 * `ctime` means the guard fired — size and mtime matched but the change time had
 * moved, so the bytes may have been rewritten behind a restored mtime. And
 * `ctime-on-read` means the guard fired *and* re-reading the file moved its
 * change time again, which is the signature of a cloud-sync filter driver
 * (OneDrive, Dropbox, Google Drive) rather than of anything editing the file: on
 * such a volume the guard can never settle, and the user has a decision to make
 * (`S3CAB_SKIP_CHANGE_TIME_CHECK`). A file absent from every source is simply new and
 * gets no reason at all.
 * @typedef {"changed" | "ctime" | "ctime-on-read"} RehashReason
 */

/**
 * Whether a size+mtime lookup match can be trusted, given when the baseline
 * snapshot was taken — the ctime cross-check on the reuse test (ADR-0085).
 *
 * `mtime` can be set from userland, so a same-size rewrite that puts the old
 * mtime back (`touch -r`; FAT32's 2-second timestamps collide the same way
 * with nobody asking) looks unchanged to the size+mtime test and would carry
 * the baseline's hash forward against new bytes. `ctime` cannot be set back:
 * the rewrite — and the `utimes` call itself — bumps it. So a ctime at or
 * after the baseline's instant proves the file was touched *since the baseline
 * recorded it*, and the match is not trusted.
 *
 * **It self-heals only if the boundary is the moment the baseline's rows were
 * *written*.** ADR-0085 shipped weighing the ctime against the `#SNAPSHOT`
 * instant, which is minted at pass *start*, and assumed one re-hash would settle
 * a file for good. On any volume where reading a file moves its ctime — a
 * OneDrive, Dropbox or Google Drive sync root, where a filter driver services
 * the read — the opposite happens: the pass hashes the file, the read pushes its
 * ctime past the header's instant, and the next run distrusts it again. Measured
 * on a real 278,000-file OneDrive set: 97% of files distrusted, none of them
 * changed, 1.8 TB re-hashed every single run. The trailer's completion instant
 * (`#END`, ADR-0082) is *after* every read the pass made, so it settles.
 *
 * Two deliberate trust grants:
 *
 * - **No `baselineMs` → trust the match as before.** The `prop` command's
 *   `--lookup` has no snapshot instant to offer, and a baseline written before
 *   ADR-0072 carries no `#SNAPSHOT` header to read one from. (An instant that
 *   won't parse arrives as `NaN`, which fails the comparison and so distrusts —
 *   the safe direction, costing one re-hash.)
 * - **A dehydrated placeholder is trusted regardless.** Dehydration moves
 *   *only* ctime (measured; the ordering comment in {@link fileProps} leans on
 *   the same fact), so without this exemption every file the sync client
 *   reclaims would read as touched — and, having no bytes to re-hash, fall out
 *   of the backup (ADR-0081). Windows-only like all placeholder detection: on
 *   other platforms the same stat shape is a real sparse file, which the guard
 *   must apply to.
 *
 * Takes epoch milliseconds rather than the trailer's string: the instant is
 * constant for a whole source, so parsing it per file would be exactly the
 * hot-path overhead the one-`lstat` rule below exists to avoid. The caller
 * parses once (`readBaseline`, lib/snapshot.mjs).
 * @param {Pick<Stats, "ctimeMs" | "size" | "blocks">} stat - The one stat already taken
 * @param {number} [baselineMs] - When the baseline snapshot was taken, in epoch ms
 * @returns {boolean}
 */
const trustMatch = (stat, baselineMs) =>
  baselineMs === undefined ||
  stat.ctimeMs < baselineMs ||
  (DETECT_ONLINE_ONLY && hasNoBytesOnDisk(stat));

/**
 * Compute a file's content properties — its `hash`, `size`, and `mtime` — from
 * the file on disk, reusing a stored hash from one of the `lookups` when the
 * file is unchanged (same `size` *and* `mtime`, cross-checked against `ctime`
 * via {@link trustMatch}), so an unchanged file is never re-hashed.
 *
 * The `lib` hashing primitive behind both callers: the `prop` command (which
 * resolves a `--lookup <snapshot>` path into a single source) and the snapshot
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
 * @param {HashSource[]} [lookups] - Where a stored hash may be reused from, **in
 *   priority order** — a pass hands in the interrupted run's parked hashes first
 *   and the previous snapshot's second, each with its own trust boundary (see
 *   {@link HashSource}). The first source holding a trustworthy match wins
 * @param {object} [options]
 * @param {(hashing: HashProgress) => void} [options.onHashStart] - Called when a
 *   file is big enough to be hashed by streaming, so a progress line can report it
 * @param {boolean} [options.includeOnlineOnly] - Read a cloud placeholder anyway,
 *   downloading it (`--include-online-only`). Off by default, so the default backup
 *   never pulls a cloud account onto the disk it is being backed up from
 * @returns {Promise<Props>} The file's hash/size/mtime (no `hashDuration` or
 *   `rehashReason` when reused from a lookup — a reuse did no work and had no reason to)
 * @throws {OnlineOnlyFileError} When the file is a dehydrated cloud placeholder
 *   and `includeOnlineOnly` is not set — the caller turns this into a `#SKIPPED`
 *   row, not an `#ERROR` one (ADR-0081)
 */
export async function fileProps(
  path,
  lookups,
  { onHashStart, includeOnlineOnly } = {},
) {
  const start = Temporal.Now.instant();

  const stat = lstatSync(path);
  if (!stat.isFile()) {
    throw new Error(`Not a regular file: ${path}`);
  }

  const { size, mtime } = stat;
  const mtimeIso = mtime.toISOString();

  // Sources in the order the caller ranked them, first trustworthy match wins.
  // A source that doesn't know the path, or knows it at another size/mtime, is
  // simply passed over — only a *vetoed* match stops the search, because every
  // later source has an earlier boundary and would veto it too.
  /** @type {RehashReason | undefined} */
  let rehashReason;
  for (const { entries, baselineMs } of lookups ?? []) {
    const stored = entries.get(path);
    if (!stored) {
      continue;
    }
    if (stored.size !== size || stored.mtime !== mtimeIso) {
      rehashReason ??= "changed";
      continue;
    }
    if (trustMatch(stat, baselineMs)) {
      return stored;
    }
    rehashReason = "ctime";
    break;
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

  // Did reading the file just move its own change time? One `lstat`, and only
  // for a file the ctime guard actually vetoed — so this costs nothing on a
  // healthy run (where the guard never fires) and one stat against a whole file
  // read on a run where it does. That is the population the answer is about: if
  // re-reading moves the ctime again, no amount of re-hashing will ever settle
  // this file, and the cause is the filesystem rather than anything editing it.
  // Deliberately *not* sampled or cached per directory — a set can span a synced
  // root and an ordinary one, and per-file is both simpler and exact.
  if (rehashReason === "ctime" && lstatSync(path).ctimeMs !== stat.ctimeMs) {
    rehashReason = "ctime-on-read";
  }

  return {
    size,
    mtime: mtimeIso,
    hash,
    hashDuration: Temporal.Now.instant()
      .since(start)
      .round("milliseconds")
      .total("seconds"),
    // Spread rather than assigned, so a file no lookup knew about carries no
    // `rehashReason` *key* at all rather than one holding `undefined`. The two
    // read the same through the optional property, but not to `deepStrictEqual`
    // — and `prop --json` would print a null nobody can act on.
    ...(rehashReason && { rehashReason }),
  };
}
