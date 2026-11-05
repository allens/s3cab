# Audit of `restore` and `extract` (2026-11-04)

Reading `202171e0` (Claude Fable 5.1, unattended). The two failures that matter: **(a) a write
outside the place the user asked to restore to**, and **(b) exit 0 over a tree that is wrong or
incomplete, with nothing said.** Threat model: a hostile or hand-edited snapshot (plain text; a
bucket may be shared) and a target directory that already holds things.

Attacked by reading and by running, on Windows 11 (build 26300, Node 26.13.0, NTFS) and in WSL2
(Ubuntu, Node 26.10.0, ext4 under `/tmp`, `fs.protected_symlinks=1`, uid 1000). Every run went
through the real snapshot reader (`parseSnapshotStream` on hand-built TSV), the real planning
and writes (`restoreTargets`, `atomic-file.mjs`); only the bucket was faked, at the lib seams
the unit tests already use (`env`, `remote`, `objects`, `s3`, `deletion-record`), with the real
digest check kept in the fake `getObject`. No real bucket was needed. The harness lives outside
the repo (this session's scratchpad). The findings are pinned by two uncommitted test files
beside their modules, red on both systems:

- [src/lib/atomic-file.temp-link.test.mjs](../src/lib/atomic-file.temp-link.test.mjs) — defect 1
- [src/commands/restore.target-changes-mid-run.test.mjs](../src/commands/restore.target-changes-mid-run.test.mjs)
  — defects 2 and 3

**Result: three defects, none reachable from a snapshot alone.** Every snapshot-only attack
held (the ruled-out list below). All three need something else to have written in the output
folder: a link there before the run, or a change to it while the run is going. All three are on
the `--output`/`extract` path; an in-place restore writes to the snapshot's absolute paths by
design ([ADR-0071](../docs/adr/0071-snapshot-paths-absolute-native.md)) and has no boundary.

## Defects, ranked by harm

### 1. The temp sibling's name is fixed, and a link there is written through — (a)

[src/lib/atomic-file.mjs](../src/lib/atomic-file.mjs), `land`: the temp is
`.<sha256(basename)[:16]>.s3cab-tmp` beside the destination, opened with `open(tmp, "w")` for a
download and written by `copyFile(from, tmp)` for a dedup copy. Neither call refuses a symbolic
link already at that name, so the bytes go to the link's target — which can be anywhere — and
the rename then puts the *link* at the destination. The digest check runs after the bytes have
left. Measured on NTFS and ext4 (the test, both tests): a file outside `--output` ends up
holding the restored content, the destination is a link to it, and the run reports the path
`restored`; it exits 1 only because the time read back from the link disagrees (`clamped`),
which says nothing about where the bytes went. In the harness:

```
restored=["<out>/data/a.txt"] clamped=[{"path":"<out>/data/a.txt","kept":"…"}]
elsewhere/victim.txt = "PAYLOAD"
out/data/a.txt -> <base>/elsewhere/victim.txt [link]
```

A folder at the temp name instead aborts the whole run with a raw `EISDIR` from `open`
(nothing degrades it to a per-file report).

### 2. The folder-link check is remembered for the run — (a)

[src/lib/restore.mjs](../src/lib/restore.mjs), `linkedFolder`: each folder between
`--output` and a file is `lstat`ed once and the answer kept in `linkedFolders` ("sound because
restore never makes a link"). It is only sound while nothing *else* writes there. Measured on
both systems: once `out/data` has been checked for its first file, replacing it with a
junction (Windows) or a symlink (ext4) to a folder elsewhere sends every later file under it —
new subfolders included, since their check recurses into the cached parent — to that other
folder, with every path reported `restored` and exit 0:

```
exit=0 restored=["<out>/data/sub/a.txt","<out>/data/sub/b.txt","<out>/data/other/c.txt"]
elsewhere/data/other/c.txt = "C"   elsewhere/data/sub/b.txt = "B"
out/data -> <base>/elsewhere/data [link]
```

Without the cache the same swap would have to land in the gap between one file's `lstat` and
its rename; with it the gap is the rest of the run, which on a video set is minutes per file.

### 3. A dedup copy trusts the file it landed earlier — (b)

[src/lib/restore.mjs](../src/lib/restore.mjs): the second path holding a hash is copied from
where the first landed (`fateByHash` → `copyFileAtomic`), and the copy is not digest-checked.
Measured on both systems: a landed file changed before the copy is copied as changed; both
paths are reported `restored`, exit 0:

```
exit=0 restored=["<out>/data/a.txt","<out>/data/b.txt"]
out/data/a.txt = "POISON"   out/data/b.txt = "POISON"
```

The first path's change is the user's own business; the second path's content is the restore's
promise ([guide/format.md](../guide/format.md): a download that doesn't hash to its key is
withheld), and here it is wrong with nothing said.

## Observations (not defects)

- A landed file removed before `realpathSync.native(step.dest)` runs aborts the run with a raw
  `ENOENT`, not a per-file report. Same window as defect 2; loud, so not counted.
- In-place restore on Linux: a `//server/share/x` row passes the "absolute on this system"
  check (`isAbsolute` is true) and `mkdir //server/share` fails `EACCES` for a non-root user,
  aborting the run; as root it would write under `/server/share/`. The refusal message promises
  more than the check does for share paths. Exit nonzero, so not counted.
- Windows, Node 26: trailing-dot and trailing-space names and the reserved names (`con`,
  `nul`, `aux.txt`, `com1`…) are created **verbatim** as files and folders, where .NET and `cmd`
  on the same machine strip the dot (`x.` → `x`). So format.md's "Windows drops a trailing
  space or dot" trap does not bite s3cab's own restore, and `CON` and `con` collide only by
  case. Measured here only; Windows 10 not run.

## Ruled out: what was attacked and which guard held

Each line was run on both systems unless marked; "reader" is `parseSnapshotStream`'s row
validity (ADR-0101), "reroot" is `reroot`/`placeUnder`/`extractTo`.

- **`..`, `.`, empty and trailing segments**, in `/`, `C:\`, `C:/`, `\\nas\share` and
  `//nas/share` forms, mixed separators, `///x`, `\\\x`: reader refuses every one, exit 1,
  nothing written. `C:data\x` (drive-relative) and `data/x`: refused as not absolute.
- **NUL, tab, CR in a path**, `..` followed by NUL: reader refuses.
- **A POSIX name holding `\`** (`a\..\..\..\x.txt`, `back\slash.txt`, `Windows\System32\k.txt`)
  under a **Windows** output: reroot refuses (`placeUnder`), reported `refused`, exit 1; under a
  **Linux** output they land as literal names inside `out`.
- **Dot/space-only and trailing-dot/space folder names** (`.. `, `...`, `. .`, `.. .`, `....`,
  ` ..`, `x.`, `x `) as folders and as final names: land verbatim inside `out` on both systems;
  nothing climbs. Sentinel file beside `out` untouched.
- **ADS**: `a:b.txt`, `Con:x`, and `/mnt/C:/x.txt` under a Windows output: `putsColonInName`
  refuses before any write; under Linux `a:b` is an ordinary name.
- **`\\?\`, `\\.\`, `//?/GLOBALROOT/…`**: `\\.\…` is refused (`.` segment); `\\?\C:\…` and
  `\\?\UNC\…` read as a share named `?`, so under `--output` they land in `out/UNC/?/…` and in
  place they are only valid under a `@SET DIR` spelled the same way (then they mean what Windows
  makes of them — in-place, by design).
- **`@SET DIR` games**: a row under no DIR, DIR with `..`, nested DIRs, a DIR that is a file
  row, no DIR at all: reader refuses the row or the DIR; `@SET DIR /` makes any POSIX path
  valid, as documented (DIR is consistency, not a boundary).
- **8.3 short name of a junction** (Windows): `lstat` on `LONGJU~1` reports the link; `blocked`.
- **A junction or symlink at a folder inside `out`**, before the run, with and without
  `--overwrite`: `blocked`, nothing fetched, target folder untouched; also when the folder is
  `extract`'s `to` (refused as already there; with `--overwrite`, `blocked`).
- **A file symlink at the destination's own name**, before the run: skipped; with `--overwrite`
  the rename replaces the link and the target keeps its bytes. One created *after* the plan, at
  a later row's name: the rename replaces it; target untouched.
- **Case twins** (`File.txt`/`file.txt`, `Sub/`/`sub/`): NTFS `collided`, exit 1, first row
  kept; ext4 both written. A twin of a file there before the run: `skipped`. A file and a
  folder differing by case: `blocked` (NTFS), both (ext4).
- **NFC/NFD twins** (`café`): two files on NTFS and ext4, both correct. APFS not run (ADR-0086's
  realpath check is the guard, by reading).
- **Objects that lie**: bytes that don't hash to the key → `corrupt`, nothing written, the
  twin path the same casualty, exit 1. Size column lies (1, 10²⁰) → ignored by restore
  (verify's business). Upper-case or short hash → reader refuses. Hash of another row's
  content → that content, correctly.
- **Absences**: `NoSuchKey` → `missing`, exit 1; recorded deletion after START → `deleted`,
  exit 0 (ADR-0064, said in the report); record before START, or no START row → `missing`,
  exit 1. `AccessDenied` mid-run → aborts, folders made for the failed file removed.
- **`--from-file`**: lines are trimmed and `#`-prefixed lines dropped, so `/data/#hash.txt`
  still matches (the `#` isn't first), a quoted path is `unmatched` (exit 1), a path with a
  trailing space can't be listed (trimmed → `unmatched`, exit 1 — said). Flag-like names
  (`/data/-x.txt`, `/data/--all`) match as paths; a bare `-` or `--all` as a path is
  `unmatched`.
- **`extract --name`**: `..`, `.`, `""`, `a/b`, and `a\b` on Windows refused up front; `con`,
  `a.`, `" "`, `...`, `-`, `--overwrite`, `nul.txt` become literal folder names inside `out`;
  `a:b` refused on Windows. Item spellings: trailing `/`, other case, `C:\`, `//nas/share`,
  `//nas`, `/` with `--name`: each lands under `out/<name>` only. `/data/Photos/../Photos`
  matches nothing (filters are not normalized).
- **Exit codes**: `skipped` alone 0; `unmatched`, `invalid`, `blocked`, `refused`, `collided`,
  `missing`, `corrupt`, `clamped` 1; an abort throws.
- **In place, cross-OS**: a POSIX path on Windows and a drive path on Linux refuse the whole
  run up front, pointing at `--output`.

## Not run, read only

macOS (APFS normalization and case folding; the ADR-0086 guard is the same code path as the
NTFS case-twin test, which held); Windows 10 (the trailing-dot/reserved-name measurement is
Windows 11 only, though it is Node's path handling, not the OS's, that decides it); a symlink
owned by another user under `protected_symlinks` (would not be followed in a sticky
world-writable directory; same-user links are, which is the case the tests use); FAT/exFAT;
paths past `MAX_PATH`; the real-bucket integration suite (nothing on the S3 path was changed).
