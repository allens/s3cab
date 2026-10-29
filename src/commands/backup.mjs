import { isAbsolute, relative, sep } from "node:path";

import { compareSnapshots } from "../lib/compare.mjs";
import { loadSet } from "../lib/env.mjs";
import { assertHeld, pushSetConfig } from "../lib/set-marker.mjs";
import { readSetExclude } from "../lib/sets.mjs";
import { uploadSet } from "../lib/upload.mjs";

/** @import { CompareError, CompareResult } from "../lib/compare.mjs" */

/**
 * Back up a set to the cloud (docs/design/backup.md): the fused
 * snapshot-and-upload pass is `uploadSet` (lib/upload.mjs, ADR-0069), run
 * under the upload lock it takes for itself (ADR-0112). What is left here is
 * the porcelain around it — the holder check up front, the config re-sync
 * after, the comparison, and the report.
 *
 * **What a finished run reports** ([ADR-0078](../../docs/adr/0078-backup-run-report.md)):
 * in *files*, not objects — content-addressed dedup means a moved file changes
 * everything and uploads nothing, so an object count alone answers a question
 * nobody asked. `backup` states in full only what only `backup` knows (bytes,
 * timings, transfers), and hands the detail to `compare`: everything the
 * *snapshot* holds is a count plus a copy-pasteable command — except the files
 * that failed, which the report names because they are what to act on. Every
 * figure lands here rather than in the renderer, so `--json` gains it
 * deliberately.
 *
 * @typedef {Object} BackupResult
 * @property {string} set - The set backed up
 * @property {string} bucket - Where its objects went
 * @property {string} snapshot - The fresh snapshot that was uploaded
 * @property {number} files - Files the pass went through
 * @property {number} bytes - Those files' total size — **not** bytes read off the disk, since an unchanged file reuses its stored hash and is never opened. Which is why the report says "Scanned", not "Hashed"
 * @property {number} hashedFiles - How many were really read and hashed; the rest reused their stored hash
 * @property {number} hashedBytes - Their bytes — what `scanMs` was actually spent on
 * @property {number} scanMs - Milliseconds the pass spent on everything except sending: walking, stat-ing, and hashing whatever had changed
 * @property {number} candidates - Objects this backup attempted — the ones its skip-list (the trusted baseline, else a store LIST) didn't already account for
 * @property {number} uploaded - Those actually transferred (the rest were already in the store)
 * @property {number} uploadedBytes - Bytes those transfers moved
 * @property {number} uploadMs - Milliseconds spent sending them
 * @property {CompareError[]} errors - Files that couldn't be read to be backed up, each with the OS's reason
 * @property {string[]} excludeSuggestions - An exclude pattern for each failed file the baseline had failed on too: trying again hasn't fixed it, so the report offers leaving it out instead
 * @property {string} excludePath - The set's exclude file, where those patterns would go
 * @property {CompareResult | null} comparison - What changed since the baseline; `null` on a first backup, which runs no comparison at all (ADR-0078 §7)
 *
 * With no update mode ([ADR-0052](../../docs/adr/0052-retire-setup-update-mode.md)),
 * a set's `dirs.txt`/`exclude.txt` are edited by hand, so `backup` is where those
 * edits re-sync to the bucket's `.s3cab/sets/<name>/` (which a later `takeover`
 * reads). It's best-effort metadata: a failure there must not fail a backup whose
 * objects + snapshot are already safely up — the next backup re-publishes.
 *
 * Only the machine holding the set backs it up
 * ([ADR-0108](../../docs/adr/0108-set-ownership.md)). `uploadSnapshotFile`
 * checks just before publishing, as the format requires; `backup` checks first
 * too, so a refusal costs seconds rather than a whole pass.
 *
 * @param {string} [setName] - Backup set to back up (default: the only set)
 * @param {{ debug?: boolean, rehash?: boolean, resume?: boolean }} [options]
 * @returns {Promise<BackupResult>}
 */
export async function backup(setName, options = {}) {
  // Resolve the set and apply its env layer (its bucket's auth) over the ambient
  // shell (env.mjs, ADR-0022/0055 — the one s3cab layer), before any S3 call.
  const set = loadSet(setName);
  await assertHeld(set.bucket, set.name, set.claimPath);

  const { baseline, pass, candidates, uploaded, uploadedBytes, sendingMs } =
    await uploadSet(set, {
      rehash: options.rehash,
      resume: options.resume,
      debug: options.debug,
    });
  const { name: since, previous, previousErrors } = baseline;
  const { name } = pass;

  // Re-sync the set's published config (ADR-0052): the objects + snapshot are
  // already up, so this is best-effort metadata — a hiccup here leaves the copy
  // stale until the next backup, never a failed backup.
  try {
    await pushSetConfig(set.bucket, set.name, {
      dirs: set.dirs,
      exclude: readSetExclude(set.name),
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.warn(
      `Backed up. (Couldn't refresh this set's cloud config just now — ${detail}. ` +
        `It'll re-sync on your next backup.)`,
    );
  }

  // What changed, computed by **`compare` itself** over the snapshot just
  // written, with the baseline handed straight in from memory — it already
  // accepts that form, and `readBaseline` above is holding those very entries
  // (ADR-0078 §8). Accumulating the diff during the fused pass would be cheaper
  // and would reimplement `compare`; a report reading "425 added" above a
  // command that then lists 424 is a trust bug in the one place this design asks
  // for trust. One parse of a file still in the page cache is the price of
  // "these cannot diverge".
  //
  // A first backup runs none of it (§7): every file is an addition against an
  // empty baseline, which is where the diff is both most expensive and least
  // worth having.
  const comparison =
    since && previous
      ? await compareSnapshots(set.snapshotsDir, set.dirs, {
          since: { name: since, entries: previous, errors: previousErrors },
          until: name,
          setName: set.name,
        })
      : null;

  // Files the pass couldn't read became `#error` rows: the snapshot is honest
  // about them and worth publishing (everything it *does* list is stored), but
  // the run must not signal clean — a scheduled backup runs on the exit code
  // alone (guide/output.md tells scripts to branch on it), and
  // `s3cab backup && notify-ok` recording success for a backup that silently
  // omitted files is the machine-readable half lying. Same pattern as `verify`
  // and `restore`: set `process.exitCode` rather than throw, so the publish
  // above stands and the run report still prints.
  if (pass.errors.length > 0) {
    process.exitCode = 1;
  }

  return {
    set: set.name,
    bucket: set.bucket,
    snapshot: name,
    files: pass.files,
    bytes: pass.bytes,
    hashedFiles: pass.hashedFiles,
    hashedBytes: pass.hashedBytes,
    // The pass minus the sending. The two are exclusive because the fused pass
    // is strictly sequential (ADR-0078 §9), so this really is the disk half —
    // which is the whole point: one combined figure makes 14.9GB in 11m 24s
    // read as a slow link when the time went on reading 1.8TB off the disk.
    scanMs: Math.max(0, pass.elapsedMs - sendingMs),
    candidates,
    uploaded,
    uploadedBytes,
    uploadMs: sendingMs,
    errors: pass.errors,
    // Recurrence, not the error code, is the signal: EBUSY is both a sync
    // client's lock file nobody wants and an Outlook .pst that only needs Outlook
    // closed — suggesting an exclude for the second loses someone's mail.
    // Compared exactly, separator and all, not without it: a folder link whose
    // target is sometimes unreachable fails two different ways (`Share` can't
    // be resolved, `Share\` is outside the backup), and each is its own failure.
    excludeSuggestions: pass.errors
      .filter(({ path }) => previousErrors.has(path))
      .map(({ path }) => excludePattern(pass.roots, path)),
    excludePath: set.excludePath,
    comparison,
  };
}

/**
 * The exclude pattern naming exactly one entry: its path relative to the member
 * directory holding it, in the platform's own separator, as the starter
 * `exclude.txt` is written (ADR-0051).
 * @param {string[]} roots - The member directories as the walk resolved them,
 *   never `dirs.txt`'s text: a symlinked or differently-cased entry contains
 *   none of the walk's paths
 * @param {string} path - An entry the walk found beneath one of them, as its
 *   `#error` row spells it: a folder link's ends with a separator
 * @returns {string}
 */
function excludePattern(roots, path) {
  const root = /** @type {string} */ (
    roots.find((root) => {
      const rel = relative(root, path);
      return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
    })
  );
  // `relative` drops a folder link's trailing separator, without which the
  // pattern would match only a file.
  const rel = relative(root, path);
  return path.endsWith(sep) ? rel + sep : rel;
}
