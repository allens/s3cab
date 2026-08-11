# Online-only files are skipped, not downloaded

**Status:** accepted — designed and implemented 2026-08-11. Applies
[0030](0030-error-message-guidelines.md)'s wording rules and [0012](0012-consumer-vocabulary-naming.md)'s
naming rule; routes through the skip channel [0078](0078-backup-run-report.md) gave a voice to, and
rides inside [0069](0069-fused-snapshot-upload-pipeline.md)'s fused pass without changing its shape.

## Context

Windows **Files On-Demand** (OneDrive, and the same feature in Dropbox and Google Drive) leaves a
*dehydrated placeholder* on disk: a file with its full logical size, **zero bytes allocated behind
it**, and contents fetched transparently on first read. A cloud account is routinely far larger
than the disk syncing it — that is the point of the feature.

s3cab walked straight into it. The walk keeps placeholders and `fileProps` opens every one to hash
it, so **`backup` over a OneDrive folder downloads the entire cloud tree onto the local disk** —
with no warning, no error, and no way to see it coming short of watching free space fall. On a
drive smaller than the cloud account it fills the disk and the run dies part-way through, on a
hydration failure that names nothing about the real cause.

Four measured facts shaped the design. All were taken 2026-08-11 against a real OneDrive install
(`D:\OneDrive`), one 262,144-byte file cycled through `attrib +U -P` and back.

- **Nothing in the walk catches it, and that is correct.** Every synced OneDrive directory carries
  `FILE_ATTRIBUTE_REPARSE_POINT` (`0x80410`), but libuv discriminates on the reparse **tag**, not
  the attribute — cloud folders resolve to `Directory` and cloud files to `File`, from both
  `readdir` and `lstat`. The skip path that catches symlinks never fires because a placeholder
  really *is* a file. That is exactly why the problem is invisible; it is not a bug in
  [`walk.mjs`](../../src/lib/walk.mjs).
- **Steady state is already safe — this is a first-run problem.** `mtime` is byte-identical across
  hydrated → dehydrated → rehydrated (only `ctime` moves), so `fileProps` reuses a stored hash on
  matching `size` *and* `mtime` without ever opening the file. A set that s3cab already holds stays
  backed up however OneDrive is storing it today.
- **Storage Sense is not a backstop.** Its cloud-content rule defaults to *Never*, it is scheduled
  low-space housekeeping rather than backpressure, and its heuristic is "not opened for N days" — a
  backup has just opened everything, which makes the whole tree maximally *ineligible* for
  reclamation. It works against this case, not for it.
- **The signal is already in hand.** Hydrated `blocks=512` → dehydrated `blocks=0` → after a plain
  `readFileSync` `blocks=512` again (the read took 174 ms and reported nothing). `fileProps`
  already takes exactly one `lstat`, whose `size`/`mtime` drive the reuse check, so `blocks` is a
  field already paid for.

## Decision

**A dehydrated cloud placeholder is left online and reported as skipped, unless the user asks for
it by name.**

1. **The predicate is `size >= 4096 && blocks === 0`, on the `lstat` `fileProps` already takes** —
   [`hasNoBytesOnDisk`](../../src/lib/file-props.mjs). No new syscall on the hot path, which is the
   only reason a per-file check is affordable at all (CLAUDE.md's walk/snapshot rule).

   **The 4KB floor is load-bearing, not a fudge.** NTFS stores a small file *resident in the MFT
   record*, allocating no clusters, so a naive `blocks === 0` misclassifies every tiny file as a
   placeholder and drops it silently from the backup. Measured on Windows 11: 1, 50, 100 and 500
   bytes all report `blocks=0`; 700 → 1, 900 → 8, 1500 → 8, 5000 → 16. 4KB clears the
   MFT-resident ceiling (~700 bytes) and sits below any download worth warning about — hydrating a
   sub-cluster placeholder costs nothing, so there is no reason to catch it.

2. **It is called an `Online-Only File`, not a OneDrive file.** The signal is not vendor-specific,
   and the same shape comes from Dropbox and Google Drive; naming it for one vendor would be wrong
   on the other two and unverifiable in the code, which never learns who made the placeholder. The
   name states what the user can act on — the bytes are online, not here — in the plain
   backup vocabulary [0012](0012-consumer-vocabulary-naming.md) asks for, and reads correctly in
   the one place it surfaces: `1 Online-Only File` in the run's skipped list.

3. **Detection is Windows-only, and the platform gate is separate from the rule.**
   `hasNoBytesOnDisk` is a pure function of two numbers so the rule is assertable on every CI
   runner; `DETECT_ONLINE_ONLY` decides where it is *consulted*. The asymmetry is measured, not
   assumed:

   - **Windows/NTFS** is where Files On-Demand exists and where the signal is clean, given the
     floor above.
   - **Linux/ext4** has no Files-On-Demand implementation to catch, so the check could only ever
     cost something. Measured on ext4: no file is `blocks === 0` on size alone (1 byte already
     allocates a 4KB block — `inline_data` is off by default), and delayed allocation is accounted
     for immediately. But a **fully sparse** file is byte-for-byte the same shape as a placeholder
     (`truncate -s 1G` → `size=1073741824 blocks=0`; `fallocate -l 256K` → `blocks=512`, so only
     the sparse form collides). Torrent preallocation and a fresh `qemu-img` disk are both that
     shape. Enabling this on Linux would drop real files from a backup and misname the reason.
   - **macOS** *does* have Files On-Demand, but its true signal is `st_flags & SF_DATALESS`, which
     Node's `Stats` does not expose, and APFS's sparse-file behaviour here is unmeasured. Left off
     rather than guessed at. Widening it is a one-line change once someone measures a real dataless
     file on a Mac.

4. **It travels the existing skip channel, as an error subclass caught by type.** `fileProps`
   throws [`OnlineOnlyFileError`](../../src/lib/error.mjs) and `stringifySnapshot` writes a
   `#SKIPPED` row for it. No third row type and no new pipeline stage: `propsRows` already catches
   into the `Props | Error` row that [0069](0069-fused-snapshot-upload-pipeline.md) streams, and the
   uploader already passes an `Error` row through un-uploaded, so a one-branch change in the writer
   was the whole wiring. It is a **subclass** because it is the one throw out of `fileProps` caught
   *by type to branch behaviour* — every other is a **fault** and becomes an `#ERROR` row, while
   this one is a **choice** and becomes a `#SKIPPED` row
   ([`error.mjs`](../../src/lib/error.mjs)'s taxonomy).

   The distinction is the whole point of the entry: an error count would call a run that worked
   exactly as designed a run that failed, and [0078](0078-backup-run-report.md)'s
   `Couldn't be backed up:` block already draws that line.

5. **The check runs _after_ the lookup reuse, and the ordering is load-bearing.** A placeholder
   already in the baseline keeps reusing its stored hash. Check the shape first and a file s3cab
   *already holds* starts reporting as skipped — and `compare` shows it leaving the set — purely
   because the sync client freed some space overnight. The steady state above is only safe if
   nothing observes hydration state before observing the baseline.

6. **`--include-online-only` opts in, on `backup` and `snapshot`.** Someone whose cloud copy is
   precisely the copy they want held off-vendor must be able to say so, and the default cannot be
   "download it" (that is the bug). The name says what it includes rather than how, is the
   `--include-<thing>` form, and needs no short flag — it is a rare, deliberate choice, and
   clig.dev reserves single letters for common options.

   Deliberately **not** on `upload --dir`, whose seeding pass hits the same throw: giving one
   choice two homes means two places to get it wrong. `upload` reports its placeholders and leaves
   them, in its own `onlineOnly` channel rather than folded into `Drift[]` — the drift renderer's
   "couldn't be confirmed while being read" would be a lie about a file that was never opened.

7. **The count comes with the flag that changes it**, which no other skip class can offer. Skipped
   items are otherwise a count plus a `compare` command ([0078](0078-backup-run-report.md) §2); here
   there is a specific, correct next action, so ADR-0030's copy-pasteable fix applies:

   ```
   Left 48,213 files in 'onedrive' online rather than downloading them: this computer holds a
   placeholder for each, not the contents (OneDrive Files On-Demand, or the same feature in
   Dropbox or Google Drive).
   Including them means downloading every one to this disk first, so there has to be room for
   the lot. To do that:
     s3cab backup onedrive --include-online-only
   ```

   It names the vendor feature in a parenthetical — that is where the user will recognise it, and
   the code still never claims to know which vendor. The second sentence is the warning the
   original bug had no way to give: the cost is stated *before* it is paid.

   **"Including", not "backing up"**, because `snapshot` reaches this line too and stores
   nothing — the cost it warns about is the *reading*, which is identical either way. The verb
   also names what the flag on the line below does. Only the command in the copy-pasteable line
   varies between the two porcelains.

## Consequences

- **The `dirent_type` column has a second author.** It was `getFileType`'s alone; `Online-Only File`
  is written straight by `stringifySnapshot`, because the placeholder's type really is `File` and
  the column carries what a reader needs to recognise the entry. Noted in
  [`walk.mjs`](../../src/lib/walk.mjs) where the assumption used to hold.
- **`backup` gained its first options block**, and the flag exists on two commands with one
  meaning. `upload --dir` reports but cannot opt in — an asymmetry accepted on purpose (§6).
- **A placeholder cannot be created in a unit test**, so the stat is mocked. NTFS allocates on a
  truncate-extend (`truncateSync(f, 1MB)` → `blocks=2048`, not 0) and `fsutil sparse` needs
  elevation. Both new test files mock `node:fs` before the module under test loads and say why in
  their headers; the Windows-only assertions skip elsewhere, while the pure predicate is asserted
  on all three runners.
- **`skipped` is now two things summed** — the walk's unsupported types plus this pass's
  placeholders — which is right for the report and worth knowing when reading `SnapshotResult`.
- **The macOS question stays open**, recorded in §3 rather than in `proposals/`, because the answer
  belongs beside the decision it would change.
- **The workaround still works and is now unnecessary**: back up a chunk, free the space again, and
  the next run never re-reads it. It was the only option before this and rested on the mtime
  stability in Context; that fact is now load-bearing for §5 instead.
