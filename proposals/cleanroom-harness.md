# The clean-room harness

Built against [format-scope.md](format-scope.md), which lands first: every clean room reads the
format it decides. Running these clean rooms in CI is [cleanroom-ci.md](cleanroom-ci.md).

## Back to backup and restore

For the clean rooms, I think we should go back to backup and restore, i.e. roll snapshot and
upload back together. There was a nice 1-to-1 with the s3cab CLI, but the clean room isn't about
recreating the s3cab CLI from scratch (another reason the exclude rules sit outside). It's about
proving that you can take a collection of files on disk and replicate them properly to S3 — where
"properly" means s3cab, or any other spec-adherent client, can work with the result. So "backup"
is the fundamental step, even if the s3cab CLI has smaller pieces that can be used for it. It is
also (more importantly) about restoring an s3cab bucket from S3 back onto a disk correctly.

So I'd suggest the clean rooms build a `backup` and a `restore` script. As mentioned above, these
don't need to concern themselves with set config the way the s3cab CLI does. They just need to
use a set as a label, and get or put the data in the right place in the bucket. So I'd make their
arguments as simple as:

```
s3cab-backup <dir> <bucket> <set>
s3cab-restore <bucket> <set> <dir>
```

(or perhaps the `<bucket>/<set>` form).

**Decided: fuse.** One `s3cab-backup` program per platform replaces the snapshot and upload clean
rooms (standard library plus boto3). The clean room validates the format, and measured against
that, what the split's staged inputs tested moves to where it belongs:

| What | Where it's tested |
|---|---|
| Stored objects hash to their keys (format) | `check-upload`, every object, every run |
| What makes a file valid (format) | restorers, against the golden set's torn `faults` snapshot |
| Hashing the bytes as they're sent (implementation) | the harvest review of the program's code; s3cab's own tests for its upload |
| Refusing a torn snapshot handed in (implementation) | s3cab's tests for `upload`; the Uploading checklist keeps the rule |

- **Gained:** no s3cab output reaches any clean room (the upload room's exception goes); the
  questions that fell between the two halves get asked (a file whose bytes don't match while
  sending: re-hash, `#error` and carry on, or fail?); six runs a real set instead of nine.
- **Changes to the checks:** the published snapshot is downloaded and given `compare-snapshot`'s
  row checks against `s3cab snapshot` of the same trees, replacing "byte-identical to the one
  handed over"; `sets/` checks become `snapshots/<set>.info`. The comparison runs s3cab with no
  patterns and allows for s3cab skipping `.s3cab` folders. `spread`'s patterns and `edge`'s CRLF
  `exclude.txt` stay for s3cab's seed only.
- **The cost to watch: a shallower reading.** One session now covers both the "Writing a snapshot"
  and "Uploading" checklists. The first fused experiment's guesses against each are compared with
  the last split runs' (30 snapshot, 33 upload); clearly fewer argues for splitting again.
- Becomes ADR-0096's amendment when this lands.

## One directory or several?

The s3cab CLI handles multiple directories, of course. I'm just wondering whether that's of much
value here — wouldn't you just be showing you know how to loop over a list of directories in
Python or whatever, doing the same thing you'd do to one? However, if you think it's important to
test a multi-directory setup, we can allow multiple directories on the command lines above.

**Decided: several directories, last on the command line.**

```
s3cab-backup <bucket> <set> <dir>...
s3cab-restore <bucket> <set> <dir> [<snapshot>]
```

- Several directories is more than a loop: one snapshot spans them all as `@SET DIR` rows;
  placement takes the longest whole-segment match, which only bites when one is a prefix of
  another (`C:\Photos\`, `C:\Photos-2024\`); overlapping directories stop the backup; and `spread`,
  the only multi-directory set, is what makes the restore layout question answerable.
- `<snapshot>` is optional, latest by default: the golden set's torn `faults` snapshot is
  restored by name.
- Not the `<bucket>/<set>` form: it makes every program split a string and gives the spec nothing
  to check.
- The spec leaves the restore layout for several `@SET DIR`s to the tool, so the brief fixes it to
  s3cab's `--output` layout (`<dir>/<root-basename>/…`), as today, for `compare.py` to compare.

## Fixtures

**Decided: one Node module, with each platform's own oddities.** `fixtures.mjs` stays the one
master — a shared core plus a section per platform — rather than three native scripts drifting
apart. Today it is a Linux-maximal corpus that Windows and macOS only lose from.

- **Read back every build — the validation, not a separate script.** Each fixture declares what
  it expects on disk (the name's code points, file/directory/link/junction, attributes); the
  build reads every one back with `readdir` (raw names) and `lstat`, and a mismatch joins the
  "could not create" notice. Not trusting the creating tool is the point: Node writes a
  lone-surrogate string name as U+FFFD and reports success, and what works depends on the Node
  version, the machine (symlinks need Developer Mode or elevation) and the filesystem (NTFS, ReFS,
  exFAT, a share). Never checked through `s3cab snapshot`: an s3cab bug and a broken fixture
  would agree.
- **Windows' own commands only where Node has no API,** spawned from the module
  (`execFileSync`), so still one file: `attrib` for hidden and system, and
  `fsutil file setCaseSensitiveInfo` for a case-sensitive folder.
- **A lone surrogate goes through a `Buffer` path holding its WTF-8 bytes** (`ED A0 80`). A string
  path is converted to UTF-8 first, which swaps the surrogate for U+FFFD; the raw bytes reach
  Windows as the real U+D800 (Node 26, confirmed by PowerShell's code points).
- **Deterministic content, natural mtimes.** Random bytes buy only uniqueness, which fixed
  distinct content gives too; fixed content means the same hashes on every build and platform, so
  two runs' snapshots diff directly. The mtimes stay the filesystem's own: `utimes` takes a float,
  which can't pin a sub-millisecond value (F6).

What a probe on Windows (Node, cross-checked with `Get-ChildItem -LiteralPath -Force`) found:

| Fixture | On Windows |
|---|---|
| leading/trailing-space names (F2), path past `MAX_PATH` (F13) | creatable through Node: **not POSIX-only** |
| U+0085 in a name (a third of F3) | creatable; `\v` and `\f` are not (NTFS forbids 1–31) |
| trailing dot (`notes.`) | creatable; new — the spec's `\\?\` hint |
| case pair | only in a case-sensitive folder (`fsutil`) |
| `CON`, `aux.txt`, `nul.txt` | creatable, and hostile on Windows itself: a plain-path open of `CON` gets the console |
| `? * < > \| "` | impossible; Linux names for the golden set |
| `a:b.txt` | makes file `a` with an alternate data stream `b.txt` — never a fixture on Windows |
| junction, directory/file/broken symlink | creatable (symlinks needed no elevation here; a CI runner may differ) |
| hidden, hidden + system | creatable with `attrib` |
| lone surrogate | not through a string path (written as U+FFFD, reported as success); through a WTF-8 `Buffer` path, yes |

**Decided: Linux fixtures Windows can't hold**, so the golden set hands every Windows restorer
names it must deal with deliberately: the reserved names (`CON`, `aux.txt`, `nul.txt`), and
`: * ? " < > |` in a name (`a:b.txt`, `a?b.txt`, …). A Windows restorer that writes `a:b.txt` by
plain path makes an alternate data stream on `a` and reports success; `CON` is creatable through
`\\?\` but then hostile to every plain-path tool. What to do on arrival is the tool's choice
(the spec says so, "Restoring on another operating system") — these make the report say what it
chose. s3cab's own `restore` refuses `:` before writing; its handling of the reserved names is
unchecked.

**Open: the lone surrogate and the reserved names.** A name with no UTF-8 form stops the backup
(the spec refuses it), and without exclude patterns the clean-room backup has no way past, so it
needs a set of its own or stays out. `CON` needs s3cab tried against it first, carefully. Both
wait on that.

## The restore clean room

**Decided: two phases, the references shown only in the second.** Today the brief hands the
session s3cab's reference restores and tells it to compare against them — the opposite of the
backup side's "nothing of s3cab's output reaches the room", which exists because a session that
can diff against s3cab converges by imitation and every ambiguity resolved that way vanishes from
its report. But a restorer is also meant to be a working program (ADR-0096's second goal), and
the references are how it finds its own bugs. So both:

1. **Phase 1, no references.** The build leaves `reference/` out of the clean room. The session
   writes the restorer, tests it against the bucket, and writes its guess list.
2. **The harness freezes the report**, copying it out, so the list provably predates any
   reference.
3. **Phase 2, references in.** The harness copies `reference/` in and resumes the same session
   (`claude -p --resume <session-id>`): compare, fix what's yours, and report every difference in
   a separate section — your bug, or a gap in the spec.

The difference section is a result of its own: each entry is a place two careful readers
disagreed, explained while the session still has the context. Its size against phase 1's list
measures how much the references would have hidden. Changes `build-restore-cleanroom.mjs` (build
without `reference/`, then copy it in and resume) and the restore brief; the checks don't change.

Every golden-set snapshot today is a Linux backup, so no restorer reads drive letters or
backslashes; seeding per platform needs Windows and macOS machines, and is in
[cleanroom-ci.md](cleanroom-ci.md).

## Open: the readable example

We dropped the idea of the backup program also being easy-to-follow example code (ADR-0096's
2026-10-12 amendment: "proof only, with no readability goal"). Partly that was down to my personal
CLAUDE.md, but most of the complication was probably the exclude pattern matching, which has now
left the spec. So the idea may be back on the table. Let's see what the first fused run produces;
the brief isn't changed to sway it.
