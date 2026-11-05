# Audit: what `backup` leaves out (2026-11-04)

The failure hunted: `backup` exits 0 and reports success, but a file the user would expect in
the snapshot is missing from it, or is recorded with stale content, and nothing said so.
Attacked by reading and by running, on Windows 11 (build 26300, Node 26.13) and WSL2 Ubuntu
(Node 26.10), against local trees under a scratch `S3CAB_HOME`. No bucket was needed, so
none was used. Anything only read, not run, is marked **(read only)**.

**Result: no defect of that class.** Every omission found is either refused loudly, recorded
as an `#error`/`#excluded` row, or documented as it behaves. One real defect was found in the
opposite direction — files the user excluded are backed up anyway, silently — plus two lesser
silences of the same kind. Defect 1 is fixed; 2 and 3 are open.

## Defects (all over-inclusion, none the omission class)

### 1. On a network-share member directory, no exclude pattern ever matched

**Harm:** every set whose member directory is a UNC path (`\\nas\share\…`) backed up its
`.git`, `node_modules`, `Thumbs.db` and everything else the starter `exclude.txt` from `setup`
names, and anything the user added. Cost and privacy, not loss. A mapped drive letter should
be the same case, since `realpathSync.native` is expected to return the UNC form for one, but
no drive is mapped on this machine, so that is **not run**.

**Told anywhere?** No. No `#excluded` row (nothing matched), exit 0, and the snapshot's
`@CLIENT EXCLUDE` rows record the patterns as if they had applied. The only sign was
`tree <set> --excluded` saying, in neutral words, "Nothing was excluded — nothing in this set
matched an exclude pattern."

**Mechanism** ([src/lib/exclude.mjs](../src/lib/exclude.mjs), `compileExcludePatterns`):
the pattern side was `posix.normalize(spell(join(root, pattern)))`, and `posix.normalize`
collapses a leading `//` to `/`:

```
posix.normalize('//nas/share/photos/**/Thumbs.db')  →  '/nas/share/photos/**/Thumbs.db'
```

The path side is `spell(path)`, which keeps `//nas/share/photos/…`. The RegExp is anchored
`^…$`, so no pattern could match.

**Fix:** drop the `posix.normalize`; `join` has already normalized on both flavours. Compared
over 434 root-and-pattern pairs on both flavours (`..`, `.`, doubled and trailing separators,
escapes), the pattern side changes for all 124 UNC pairs and no other.

**Test:** "matches beneath a network share as beneath a drive letter" in
[src/lib/exclude.test.mjs](../src/lib/exclude.test.mjs). It failed before the fix
(`expected: '**\\Thumbs.db'`, actual `undefined`) and passes now.

**Reproduction before the fix** (Windows; the share was WSL's own, any share does):

1. `$S3CAB_HOME\sets\audit\dirs.txt`: `\\wsl.localhost\Ubuntu\tmp\s3cab-audit\unc`, a folder
   holding `keep.txt`, `Thumbs.db`, `node_modules\pkg\index.js`, `.git\HEAD`.
2. `exclude.txt`: the starter file `setup` writes (`starterExclude` in `src/lib/sets.mjs`).
3. `s3cab tree audit --excluded`:

   ```
   Using exclude file '~\...\sets\audit\exclude.txt'
   Nothing was excluded — nothing in this set matched an exclude pattern. Its patterns, if any, are listed in:
     ~\...\sets\audit\exclude.txt
   ```

4. `s3cab snapshot audit` → exit 0, "First snapshot: 4 files (5B)", rows:

   ```
   @CLIENT  EXCLUDE  **\node_modules\      (…and the other seven starter patterns)
   -  8254c329…  1  …  \\wsl.localhost\Ubuntu\tmp\s3cab-audit\unc\keep.txt
   -  e3b98a4d…  1  …  \\wsl.localhost\Ubuntu\tmp\s3cab-audit\unc\Thumbs.db
   -  2ca7289b…  2  …  \\wsl.localhost\Ubuntu\tmp\s3cab-audit\unc\node_modules\pkg\index.js
   -  cd0aa985…  1  …  \\wsl.localhost\Ubuntu\tmp\s3cab-audit\unc\.git\HEAD
   ```

5. Control: the same `exclude.txt` on a local tree excluded `node_modules`, `.git` (×2),
   `Thumbs.db`/`THUMBS.DB`, `._apple`, `desktop.ini` and `$RECYCLE.BIN`. A bare `**` or `*` on
   the share excluded nothing either.

**After the fix**, on a real SMB path (`\\localhost\C$\…\uncfix`, with `sub\THUMBS.DB` and
`sub\also-keep.txt` added) and the starter file, `s3cab snapshot audit` → exit 0, "First
snapshot: 2 files (25B)", rows:

```
#excluded  **\.git\          …\uncfix\.git\
#excluded  **\node_modules\  …\uncfix\node_modules\
#excluded  **\Thumbs.db      …\uncfix\sub\THUMBS.DB
#excluded  **\Thumbs.db      …\uncfix\Thumbs.db
-  9973d505…  8   …\uncfix\keep.txt
-  b4f97dcc…  17  …\uncfix\sub\also-keep.txt
```

### 2. A UTF-16 `exclude.txt` with LF endings silently matches nothing

A UTF-16 file with CRLF endings is refused (the CR is caught by `unusableExcludeError`, though
the message shows the patterns as `� * * \ n o d e …`). With LF endings the file is read as
UTF-8, every pattern is NUL-laden garbage, nothing matches, and nothing says so:
`tree --excluded` says "Nothing was excluded"; the `@CLIENT EXCLUDE` rows show `*^@*^@/^@…`.
Run on both Windows (`**\node_modules\`, `*.jpg`: zero exclusions, where the control with
UTF-8+BOM+CRLF excludes both) and Linux. Nothing on the read path recognizes UTF-16 or a NUL.
Low: UTF-16 with LF-only endings is unusual.

### 3. A trailing `# comment` on a pattern line is part of the pattern

`top.log # keep this out` matches nothing, silently (Linux run; `guide/exclude.md` says only
that *lines starting with* `#` are comments, so this is gitignore's rule, documented by
implication). Listed because it is the one way a pattern a user can read as right does
nothing, with no `#excluded` row to miss. Lowest.

## Ruled out: attacked, and which guard held

Everything below was run unless marked **(read only)**.

**Exclude patterns**

- `*` matches one segment, `**/` zero or more whole segments, `***` every file at any depth,
  `**/` every directory (links to directories and `.s3cab` too), `?` one character — each
  recorded on an `#excluded` row with its pattern. A lone `*` excludes a top-level link before
  the walk can raise its `#error`; the `#excluded` row says so.
- Escapes on Linux (`\*`, `\?`, `\#`, `\ ` leading, `\ ` trailing kept by `parseExclude`,
  `\\`) match the literal name; a stray `\` (`**\Thumbs.db` written on Windows, used on Linux)
  is refused with the escape rule printed.
- Windows: `*.jpg` → `UPPER.JPG`, `**\thumbs.db` → `THUMBS.DB` (case folds); `/sub/`,
  `\plain.txt` (leading separator ignored), forward slashes, trailing `\` on a file name (names
  only a directory, as documented).
- UTF-8 BOM + CRLF: fine on both OSes. UTF-16 + CRLF: refused on both. UTF-16 + LF: defect 2.
- A pattern with `..` climbs and re-enters (`x/../../tree/plain.txt` matched `plain.txt`;
  `a/../logs/` is `logs/`) — visible on the `#excluded` row.
- The starter `exclude.txt` on a local tree: its `**\` patterns match at any depth
  (`sub\.git`, `sub\THUMBS.DB`, `sub\desktop.ini`); `$RECYCLE.BIN\` matches only at the top of
  a member directory, as a pattern without `**` does, so `sub\$RECYCLE.BIN\r.txt` is recorded.
- A pattern swallowing a whole member directory (`sub/` on a nested member, `*`, `***`): what
  it swallows is recorded on `#excluded` rows; a member hidden this way to dodge the overlap
  check works as `guide/backup.md` documents.

**The walk — Linux**

- Link to a file or directory inside the backup: no row (ADR-0103, documented). Outside:
  `#error` row + exit 1. Broken, loop, to a device: no row. FIFO, socket: no row (not files).
- Unreadable file (mode 000): `#error`. Member directory without `x`: `#error lstat` per
  entry. Unlistable directory inside the tree: the run aborts (ADR-0098).
- Names: `st*ar.txt`, `wh?at.txt`, `back\slash.txt`, `#hash.txt`, leading space, trailing
  space, NBSP, `UPPER.JPG`/`lower.jpg` — all recorded. Tab/CR/LF in a name: refused
  (ADR-0073) **(read only)**.
- A file named `.s3cab` and `sub/.s3cab` (a file): backed up. A directory named `.s3cab` at
  any depth: no row, exactly as `guide/backup.md` ("never walked … gets no row") says.

**The walk — Windows**

- Junction out of the backup: `#error` + exit 1. Junction in, file symlink: no row. Hard link:
  recorded as a file (both names). Sparse file, NTFS-compressed, WOF/`compact /exe` (xpress4k
  and lzx): read as plain files — on build 26300 neither leaves a reparse point. Hidden+system,
  read-only: recorded. Alternate data streams: the main stream only (see observations).
- Names Windows programs can't make, reaching a drive via WSL/DrvFs: `nul`, `con`, `aux.txt`,
  `trail.`, `sp `, and PUA-mapped `st*ar`, `wh?at`, `co:lon`: all recorded; Node's `\\?\`
  prefixing handles them. A path over 260 characters: recorded.
- OneDrive placeholders: a census of 20,000 entries under the user's OneDrive classifies every
  one as a plain file by `Dirent` and `lstat` alike; none is a link. Personal Vault can't be
  opted in (proposals/filesystem-edge-cases.md).
- An 8.3 short name in `dirs.txt`: canonicalized to the long name. (Cosmetic: the report's
  relative path for an `#error` is then `..\..\..\..\..\7e5119…\junc-out`, computed against
  the short spelling.)

**`dirs.txt` as people write it**

- Refused loudly, with the file's path in the message: a quoted entry, a relative entry, `~`,
  a file instead of a folder, a removed drive (`Q:\photos`), a misspelled folder, the same
  folder twice in different case (overlap), nested members, a member reached through a symlink
  that overlaps another. An empty list: "has no directories to back up".
- Accepted and canonical: lowercase drive letter, forward slashes, trailing separator,
  doubled separators, a member that is a symlink to a folder, a UNC member, `#` comment
  lines and blank lines (documented), UTF-8 BOM + CRLF. UTF-16 `dirs.txt`: refused (shown as
  `� C : \ U s e r s …`, which at least points at the file).
- A member that is now empty (an unmounted mount point looks like this): exit 0, and the
  report says `Deleted (2)` with every file listed and `2 deleted` on the summary line. Told —
  by the compare report only, not a warning.

**Stale content by reuse** (`src/lib/file-props.mjs`, ADR-0085/0094)

- Default: same size + same mtime (to the millisecond, half-up) reuses the stored hash. A
  same-size rewrite with the mtime put back is recorded stale, exactly the case
  `guide/backup.md` ("When that rule is fooled") documents. A size change is re-hashed.
- The millisecond: mtimes `.1234` → `.1226` both record `.123Z` and the rewrite is reused;
  `.1235` → `.1225` (`.124Z` vs `.123Z`) is re-hashed. Inside the documented class.
- `S3CAB_CHECK_CHANGE_TIME=1`, from the shell or from the set's env file: a rewrite after the
  previous run's start is re-hashed ("1 modified"). A rewrite before a check-*off* run, then a
  check-*on* run: stays stale for good — the boundary is the previous run's start, so the
  guide's sentence is exact, though it doesn't say to run `--rehash` once when switching the
  check on.
- Size 0: the empty digest without reading. A file that changes size while being read:
  `ChangedWhileReadError` **(read only)**.
- `--resume` / parked rows: validated by size+mtime like the previous snapshot, one boundary
  (ADR-0094 §4) **(read only)**. `--rehash` drops the lookup entirely **(read only)**.
- A hash believed stored that isn't (`storedHashes`, ADR-0084/0069): the baseline's hashes are
  trusted only when the remote copy of the baseline snapshot is byte-identical, minus deletion
  records whose objects are absent; the fused pipeline guards each PUT with an `lstat` and the
  streamed digest, and drift aborts without a manifest. The hole left is an object deleted in
  the bucket by something other than s3cab (a lifecycle rule, a hand delete): `backup` doesn't
  LIST, so it reuses the hash and succeeds; `verify` is the documented recourse
  (`guide/maintenance.md`, `guide/errors.md`). By design **(read only)**.
- Roots vanishing or moving mid-pass, files appearing mid-walk **(read only, not raced)**: an
  entry gone before its type is known gets no row, a file gone before it is read gets an
  `#error` row, and a directory that can't be listed stops the backup, all as
  `guide/format.md` says.

## Observations (not defects, not the brief's class)

- Alternate data streams on NTFS are not backed up (`ads.txt` is recorded as its 4-byte main
  stream); no page in `guide/` mentions streams. Low: Zone.Identifier is the common one.
- The refusal messages for a UTF-16 file print it as spaced characters with a `�` prefix,
  which names the cause only to someone who knows the encoding.

## Not run

macOS (NFC folding, read only in `compileExcludePatterns`); a real bucket; a mapped network
drive; Personal Vault; a drive unplugged mid-walk.
