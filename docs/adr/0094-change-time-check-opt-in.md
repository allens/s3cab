# The change-time check is opt-in, and weighs against the run's start

**Status:** accepted & implemented. Partly supersedes
[0085](0085-ctime-cross-check-on-hash-reuse.md) — the check being on by default, and all of its
Amendment 1 — and [0082](0082-snapshot-end-trailer.md)'s Amendment 1 use of the `#END` instant as
that check's boundary (the instant itself stays). Retires
[0092](0092-recover-the-interrupted-work-file.md)'s mtime stand-in boundary for a recovered work
file. Its keeping of the placeholder exemption is superseded by
[0095](0095-online-only-files-read-like-any-other.md), which removes it.

## Context

0085 made reuse of a stored hash need three things: same size, same mtime, and a ctime older
than the baseline. The third catches a same-size rewrite that puts the old mtime back
(`touch -r`, `exiftool -P`, a VeraCrypt container), which size and mtime alone miss.

On a synced folder (OneDrive Files On-Demand, and the same shape in Dropbox and Google Drive)
reading a file moves its ctime, so the check distrusted files nothing had changed: 97% of a
278,000-file set, 1.8 TB re-read every run. Amendment 1 fought that inside a default-on design:
a completion-instant boundary, one boundary per hash source, a stand-in boundary for a recovered
work file, a second `lstat` after each re-read, a tally of why each file was re-read, and a
warning offering `S3CAB_SKIP_CHANGE_TIME_CHECK` to switch it off. The warning still fired, and
rewording it raised the question of why the check was on by default at all.

rsync decides "unchanged" on size and mtime alone. restic and Borg include ctime by default,
but neither has to coexist with a Windows sync client.

## Decision

1. **Off by default.** A file is unchanged when its size and mtime match the stored row. The
   rule and its edge cases are written down for users in
   [guide/backup.md](../../guide/backup.md), with `--rehash` as the periodic recourse — so
   `backup` takes `--rehash` too, not only `snapshot`.
2. **`S3CAB_CHECK_CHANGE_TIME` turns it on.** Any non-empty value, in the set's env file or the
   shell. A size+mtime match is then distrusted if the file's ctime is at or after the boundary.
   That is the whole mechanism: no reasons, no second `lstat`, no warning.
3. **The boundary is when the run that recorded the rows _started_** — the `#SNAPSHOT` instant,
   as 0085 first had it. Not the finish: a file edited mid-run, after the pass read it, with its
   mtime put back, has a ctime between the two, and only the start catches it. The cost is that
   on a volume where reading moves ctime every file is re-read every run. That is why the check
   is opt-in, and the guide says not to set it there.
4. **One lookup, one boundary.** The parked hashes ([0067](0067-park-hashes-on-interrupt.md)) are
   laid over the previous snapshot's in a single map. The boundary is the previous snapshot's
   start, or the parked file's own start when there is no previous snapshot. A recovered work
   file has that header too: it is the first line a run writes. One boundary is safe for both
   sources because every parked row was recorded after the previous run started. The cost, under
   the opt-in only, is that a resume re-reads a parked file touched between the two runs.
5. **The `#END` instant stays.** No code reads it now, but the file is read by people too
   ([0002](0002-no-lock-in-hard-constraint.md)). With the start instant, it is the only record
   of how long a run took.

The dehydrated-placeholder exemption in `trustMatch` is untouched: it belongs to
[0081](0081-online-only-files-skipped.md), whose removal is a separate decision (since taken:
[0095](0095-online-only-files-read-like-any-other.md)).

## Consequences

- By default a same-size rewrite with its mtime put back is missed until the next
  `--rehash`, or for good on a set that opts in. The model tier pins both outcomes.
- With the check on, the first run after a restore or a move to a new disk re-reads everything
  once: every ctime is newer than the baseline. Turning it on costs nothing extra, because files
  untouched since the previous run started have older ctimes.
- With the check on, the model suite's virtual clock (behind real time) distrusts every reuse.
  This is harmless, because the hashes come out identical.
- FAT32 records no change time, so `--rehash` is the only recourse there, as before.
- Gone from the code: `HashSource[]` and its per-source boundaries, `RehashReason`, the post-read
  `lstat`, `warnAboutCtimeChurn`, `lastWrittenInstant`, and `S3CAB_SKIP_CHANGE_TIME_CHECK`.
