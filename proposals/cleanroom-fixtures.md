# Clean-room fixtures

Epic: what the clean-room restore fixtures and backup fixtures
([scripts/cleanroom/](../scripts/cleanroom/),
[ADR-0096](../docs/adr/0096-three-implementations-prove-the-format.md)) don't yet provoke. Every
fixture here is buildable on Linux by a Node script, with no root and no special mounts. Ordered
by what a wrong reading costs: **silent** (a restore or backup that looks right and isn't) before
**loud** (it fails, or the harness compare catches it).

The backup side's gaps are built (the unreadable file, the links, the hard-link pair and FIFO,
the out-of-range mtimes, the backslash names, the refused sets). What is left reaches the seed
and the restore fixtures only: the backup clean room has no exclude patterns and no `dirs.txt`
([ADR-0096](../docs/adr/0096-three-implementations-prove-the-format.md)).

## Gaps

- **Hand-edited snapshots.** A new set whose `info`, `dirs.txt` and snapshots are published
  through the SDK, the way the seed already publishes the damaged `faults` snapshot. Its rows
  reuse hashes already in the bucket, and `restore --output` builds its reference on Linux.
  - Windows `@SET DIR`s (`C:\…`, `\\nas\share\…`, `//nas/share/…`) with rows in a different
    case or with `/` separators. Covers "Reading is more forgiving…" and the Windows half of
    "How a `@SET DIR` matches a path". Nothing in the restore fixtures is Windows-shaped today. Loud.
  - A row under `…\PhotosX\` where the only `DIR` is `…\Photos`. s3cab refuses the row, since
    it's under no `DIR`; a restorer comparing string prefixes lands it at `Photos/X/…`.
    **Silent.**
  - The same path twice with different hashes. "Valid and invalid files" refuses both rows, and
    s3cab exits nonzero; a first-wins or last-wins reader restores one of them and reports
    nothing. This is F4, which no tree can provoke. **Silent.**
  - A row with a `..` segment. s3cab refuses the path; a restorer that joins it onto its output
    directory writes outside it. **Silent.**
  - A POSIX `@SET DIR` in a different case from its rows. "Every other path is matched exactly",
    so a restorer that folds case everywhere restores files s3cab refuses. **Silent.**
  - A `DIR` with a trailing or doubled separator. Loud.
  - A second snapshot whose last line is another `@S3CAB` row, `VERSION` say. A reader that
    checks only the type restores a cut-short snapshot. **Silent.**
- **Exclude-pattern edges, seed side.** Add these to `spread`, beside its existing near misses.
  They reach no clean room now, since none has patterns; what they test is that the seed's
  own patterns mean what exclude.md says, so the restore fixtures hold the tree they claim.
  - A directory `old.log/` containing `inner.txt`. A pattern without a trailing `/` never matches
    a directory, so s3cab keeps it.
  - `alpha/sub/deep.log`. `*` stays within one name, so `*.log` doesn't reach it.
  - `photo[1].jpg` with that exact pattern, and a `photo1.jpg` near miss. Brackets are literal
    in s3cab.
  - `runxlog`, which s3cab keeps.
  - `.a.log`, which s3cab drops.
  - `LOUD.LOG`, excluded only on Windows.
- **The rest of `exclude.txt` and `dirs.txt` the way people write them.** `edge`'s
  `exclude.txt` already has CRLF and no final newline. Still missing: an indented `#` line, a
  blank line and a pattern with a trailing space in an `exclude.txt`, and a `dirs.txt` with a
  comment, a member directory reached through a symlink, and one written with a trailing `/`.
  The seed writes every `dirs.txt` clean, with LF endings. A member directory kept as typed
  rather than resolved changes every path in the restore fixtures.
- **Nested member directories separated by an exclude.** Use `dirs` set to
  `[nest/outer, nest/outer/inner]` with the pattern `inner/`. s3cab accepts this and writes
  nested `@SET DIR`s, which exercises "the **longest wins**". A restorer that takes the first match
  lays the files out differently. **Silent**, though layout is the tool's own decision.
- **A gap in the deletion-record numbering.** Run `s3cab cleanup` after both deletes and before
  the torn object, the corrupt bytes and the damaged snapshot exist; cleanup refuses an
  unreadable snapshot, so it has to run first. That leaves a single `-3` record. A restorer that
  counts `-1`, `-2` … reports a recorded deletion as unexplained damage. Loud, but in the wrong
  category.
- **A tab, LF or CR in an excluded name**: `edge/odd\nname.jpg` and `edge/odd\rname.jpg` with
  the pattern `odd*name.jpg`. s3cab spells them out (`odd␊name.jpg`). A restorer that reads
  them raw splits the row. Loud. (With no pattern, such a name is the `ledger` set a backup
  must refuse.)
- **"Two snapshots of an unchanged set differ in `@SNAPSHOT NAME`, `START` and `FINISH`,
  and nowhere else" costs no new fixture.** F5 already backs `edge` up twice without touching
  the tree; the harness only has to diff the two snapshots.
- **mtimes before 1970 and after 2262 on Windows.** Built on POSIX; held back on Windows until
  the `statSync` wrap in [bugs.md](bugs.md) is fixed, since s3cab's own reference row is wrong
  there.

## Questions the fixtures raise

- **Does the spec require one `#excluded` row for a whole directory?** s3cab writes a single
  row for one, its path ending with a separator, and format.md describes that row without saying
  a row per file is wrong. No clean room has patterns now, so no checker meets the question.
- **Unwritten rules that s3cab enforces:**
  - exclude.md never says that pattern characters other than the wildcard tokens are literal.
  - exclude.md never says that a pattern without a trailing `/` never matches a directory.
  - exclude.md never says whether an indented `#` line is a comment.

## Rejected

- **A `.s3cab` directory inside `edge`.** Skipping it is s3cab's own rule
  ([guide/backup.md](../guide/backup.md)), not the format's: a correct clean-room backup records
  its files, and the checker, which compares with `s3cab snapshot`, would fail it for that.
- **Sparse files.** Zeros are content, so sparseness isn't visible in the format. The only reason
  to use one would be to push the size column past 12 digits, which needs an object of a
  terabyte or more on every seed. A hand-made row lying about the size would raise a different question
  instead: is `size` authoritative?
- **Sizes around the multipart threshold.** Invisible to the format. A restorer's ranged-GET
  size is its own business, and `media` already crosses the usual thresholds.
- **Zero bytes.** Already covered by `empty.txt`.
- **Cross-set dedup.** Readers resolve objects across the whole bucket. A backup that dedups only
  within a set just PUTs the same key again.
- **Several snapshots of one set, latest versus by name.** "Latest" isn't a format concept. `edge`
  already has two snapshots, the harness restores every snapshot by name, and the backdated
  damaged snapshot already catches "latest by LastModified".
- **Overlapping member directories.** s3cab refuses them, so no snapshot in the restore fixtures can hold any.
- **Sub-millisecond mtimes and half-millisecond ties.** F6 already covers sub-millisecond times.
  Node can't set exact nanoseconds, and a tie costs a re-hash, not data.
- **mtimes past 9999.** They break the 24-character form, and ext4 stops at 2446.
- **Sockets.** No row, like the FIFO, and Node removes the socket when its server closes.
- **Devices.** Creating one needs root.
- **255-byte name components.** s3cab's temp name is a fixed length, and re-rooting lengthens
  paths, not components. The only thing it would catch is a restorer that builds `<name>.tmp`
  temp files, which fails loudly with `ENAMETOOLONG`.
- **Commitments about ordering and behaviour:** objects uploaded first and the snapshot last; a
  same-minute second snapshot refused; a record written before its delete; the grace window.
  None of these shows in a finished bucket, so no fixture can catch a violation.
