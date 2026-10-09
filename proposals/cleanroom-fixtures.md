# Clean-room fixtures

Epic: what the clean-room golden set and backup trees
([scripts/cleanroom/](../scripts/cleanroom/),
[ADR-0096](../docs/adr/0096-three-implementations-prove-the-format.md)) don't yet provoke. Every
fixture here is buildable on Linux by a Node script, with no root and no special mounts. Ordered
by what a wrong reading costs: **silent** (a restore or backup that looks right and isn't) before
**loud** (it fails, or the harness compare catches it).

## Gaps

- **An unreadable file, which gives an `#ERROR` row.** ADR-0096 names this open. Use
  `chmodSync(0o000)` with about twenty readable siblings: ext4 returns readdir entries in hash
  order, so the unreadable file can't be placed, and the siblings make sure some rows come after
  it. The builder has to check the file really is unreadable, because root reads anything, and
  skip it loudly otherwise. `backup` exits 1 on an `#ERROR` row, so the seed has to accept that
  exit for this set instead of using `mustRun`. **Silent** on the backup side: a backup that
  drops the row and shifts every later hash by one stores objects that match their keys but
  belong to other files, and hashing what you download can't catch that. Restore side: no
  golden snapshot has ever held an `#ERROR` row.
- **Hand-edited snapshots.** A new set whose `info`, `dirs.txt` and snapshots are published
  through the SDK, the way the seed already publishes the damaged `faults` snapshot. Its rows
  reuse hashes already in the bucket, and `restore --output` builds its reference on Linux.
  - Windows `#DIR`s (`C:\…`, `\\nas\share\…`, `//nas/share/…`) with rows in a different case or
    with `/` separators. Covers "Reading is more forgiving…" and the Windows half of "How a
    `#DIR` matches a path". Nothing in the golden set is Windows-shaped today. Loud.
  - A row under `…\PhotosX\` where the only header is `…\Photos`. A restorer comparing string
    prefixes lands it at `Photos/X/…`. **Silent.**
  - The same path twice with different hashes. "A path appears at most once" says first-wins and
    last-wins readers restore different bytes; s3cab takes the last. This makes F4 in
    `fixtures.mjs` (marked NOT TESTABLE) testable. **Silent.**
  - A POSIX `#DIR` in a different case from its rows. "Every other path is matched exactly", so
    a restorer that folds case everywhere restores files s3cab refuses. **Silent.**
  - A header with a trailing or doubled separator. Loud.
  - A trailer with an extra column. A strict reader refuses an intact snapshot. Loud.
  - A second snapshot whose last line is `#ENDX`. A reader testing `startsWith("#END")`
    restores a trailerless snapshot. **Silent.**
- **A backslash in a POSIX name**: `edge/back\slash.txt` and `edge/a\b/c.txt`. Covers
  "a Windows path splits on `/` *and* `\`, any other on `/` alone". A restorer splitting on both
  misplaces them on Linux; on Windows it has to refuse them. **Silent.**
- **Exclude-pattern edges, backup side.** Add these to `spread`, beside its existing near misses.
  In each case a home-made matcher (Python's `fnmatch` or `glob`, or a hand-translated regex)
  can disagree with s3cab, so the tree that gets backed up differs. **Silent.**
  - A directory `old.log/` containing `inner.txt`. A pattern without a trailing `/` never matches
    a directory, so s3cab keeps it.
  - `alpha/sub/deep.log`. `*` stays within one name, so `*.log` doesn't reach it. `fnmatch`'s
    `*` crosses `/`.
  - `photo[1].jpg` with that exact pattern, and a `photo1.jpg` near miss. Brackets are literal
    in s3cab; `fnmatch` treats them as a character class.
  - `runxlog`, which s3cab keeps. A regex translation that leaves `.` unescaped drops it.
  - `.a.log`, which s3cab drops. `glob.glob` skips hidden names by default.
  - `LOUD.LOG`, excluded only on Windows. A Windows backup using the case-sensitive
    `fnmatchcase` keeps it.
- **The rest of `exclude.txt` and `dirs.txt` the way people write them.** `edge`'s
  `exclude.txt` already has CRLF and no final newline. Still missing: an indented `#` line, a
  blank line and a pattern with a trailing space in an `exclude.txt`, and a `dirs.txt` with a
  comment, a member directory reached through a symlink, and one written with a trailing `/`. The
  snapshot and upload builds write every `dirs.txt` clean, with LF endings. A pattern that keeps
  its trailing space matches nothing, so the backup takes files s3cab excludes. **Silent.** A
  member directory kept as typed rather than resolved changes every path, which the harness
  catches.
- **Nested member directories separated by an exclude.** Use `dirs` set to
  `[nest/outer, nest/outer/inner]` with the pattern `inner/`. s3cab accepts this and writes
  nested `#DIR`s, which exercises "the **longest wins**". A restorer that takes the first match
  lays the files out differently. **Silent**, though layout is the tool's own decision.
- **mtimes before 1970 and after 2262**, for example `-86_400.25` and a date in 2300; ext4 holds
  1901–2446. For a negative time, rounding toward zero instead of flooring sets the restored
  mtime a second off. After 2262, a 64-bit nanosecond count overflows (Go's `UnixNano`, C++
  `chrono` nanoseconds). **Silent.**
- **A directory symlink and a dangling symlink in `edge`.** `link-to-plain` covers only a symlink
  to a file. A backup that follows the directory symlink backs up the target tree under the
  link's name. **Silent.** A dangling link fails both `is_file()` and `is_dir()`, so its
  `#SKIPPED` row disappears; the harness catches that.
- **A gap in the deletion-record numbering.** Run `s3cab cleanup` after both deletes and before
  the torn object, the corrupt bytes and the damaged snapshot exist; cleanup refuses an
  unreadable snapshot, so it has to run first. That leaves a single `-3` record. A restorer that
  counts `-1`, `-2` … reports a recorded deletion as unexplained damage. Loud, but in the wrong
  category.
- **A `.s3cab` directory inside `edge`.** It is "never walked and gets no row". A backup that
  walks it adds rows, which the harness catches. Loud.
- **A tab, LF or CR in an excluded or skipped name**: `edge/odd\nname.jpg` and
  `edge/odd\rname.jpg` with the pattern `odd*name.jpg`, and a symlink named `odd\nlink`. s3cab
  spells the excluded ones out (`odd<NL>name.jpg`) and writes no row for the symlink. A backup
  that writes them raw splits the row, and the second half reads as a malformed file row. Loud.
- **Hard links and a FIFO** (`linkSync`, `execFileSync("mkfifo")`). A backup that deduplicates by
  inode drops a path. **Silent.** A backup that opens the FIFO hangs. Loud.
- **"Two snapshots of an unchanged folder differ only in `#SNAPSHOT` and `#END`" costs no new
  fixture.** F5 already backs `edge` up twice without touching the tree; the harness only has to
  diff the two snapshots.

## Waiting on a fix in [bugs.md](bugs.md)

- **A filename that isn't valid UTF-8**, created through a `Buffer` path in a set of its own. Its
  shape depends on how the fix handles such names.

## Questions the fixtures raise

- **Does the spec require one `#EXCLUDED` row for a whole directory?** s3cab writes a single
  row for one (for example `logs/**` matching `logs/`), and format.md calls those payloads
  context, not commitment. Until it says, `compare-snapshot.mjs` reports a backup that writes a
  row per file as a note, not a mismatch.
- **What should a restorer do with a `PARTIAL` trailer found in the bucket?** format.md says only
  the local lookup file carries one.
- **Unwritten rules that s3cab enforces:**
  - format.md never says overlapping member directories are refused.
  - exclude.md never says that pattern characters other than the wildcard tokens are literal.
  - exclude.md never says that a pattern without a trailing `/` never matches a directory.
  - exclude.md never says whether an indented `#` line is a comment.
- **Are the preserved restorers meant to be rerun?** The ones in
  [restorers/](../scripts/cleanroom/restorers/) read `.tsv.zst`, so none of them runs against
  today's golden set. That's fine if they are a frozen record and a gap if they are meant as a
  regression check.
- **Should `..` be tested per restorer instead?** s3cab's restore follows a `..` on purpose (the
  comment in `reroot`), so the golden set can't stage one against s3cab's own reference.

## Rejected

- **Sparse files.** Zeros are content, so sparseness isn't visible in the format. The only reason
  to use one would be to push the size column past 10 digits, which needs an object of 10 GB or
  more on every seed. A hand-made row lying about the size would raise a different question
  instead: is `size` authoritative?
- **Sizes around the multipart threshold.** Invisible to the format. A restorer's ranged-GET
  size is its own business, and `media` already crosses the usual thresholds.
- **Zero bytes.** Already covered by `empty.txt`.
- **Cross-set dedup.** Readers resolve objects across the whole bucket. A backup that dedups only
  within a set just PUTs the same key again.
- **Several snapshots of one set, latest versus by name.** "Latest" isn't a format concept. `edge`
  already has two snapshots, the harness restores every snapshot by name, and the backdated
  damaged snapshot already catches "latest by LastModified".
- **Overlapping member directories.** s3cab refuses them, so no golden snapshot can hold any.
- **Sub-millisecond mtimes and half-millisecond ties.** F6 already covers sub-millisecond times.
  Node can't set exact nanoseconds, and a tie costs a re-hash, not data.
- **mtimes past 9999.** They break the 24-character form, and ext4 stops at 2446.
- **Sockets.** Same `#SKIPPED` path as the FIFO, and Node removes the socket when its server
  closes.
- **Devices.** Creating one needs root.
- **255-byte name components.** s3cab's temp name is a fixed length, and re-rooting lengthens
  paths, not components. The only thing it would catch is a restorer that builds `<name>.tmp`
  temp files, which fails loudly with `ENAMETOOLONG`.
- **Commitments about ordering and behaviour:** objects uploaded first and the snapshot last; a
  same-minute second snapshot refused; a record written before its delete; the grace window.
  None of these shows in a finished bucket, so no fixture can catch a violation.
