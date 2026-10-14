# The spec is the public repository format; a file names its writer in `@CLIENT` rows

**Status:** accepted & implemented (2026-10-14), bar the client folders, which land with
[0108](0108-set-ownership.md). Partly supersedes
[0096](0096-three-implementations-prove-the-format.md) (the spec is format.md alone, so a
clean-room backup needs neither s3cab's exclude syntax nor its config files),
[0098](0098-snapshot-row-layout.md) (`@S3CAB VERSION` and `HOME`, `@SET EXCLUDE`, and the
`VERSION` clause of its case against a versioned spec URL),
[0102](0102-deletion-record-takes-the-snapshot-layout.md) and
[0103](0103-row-marks-and-unrecorded-links.md) (the rows every file opens with). Set ownership and
the bucket layout it changes are [0108](0108-set-ownership.md).

## Context

[guide/format.md](../../guide/format.md) commits to s3cab's own config as if it were format:
`sets/<set>/` with `dirs.txt`, `exclude.txt` and `info`, the `~/.s3cab/` home, `env`, the work
files, and the exclude-pattern grammar. None of it is needed to read or write a backup, and a
single pattern grammar that holds across platforms, filesystems and languages is near impossible
to ratify. As written, a second client has to reproduce s3cab's config and grammar to count as
spec-adherent.

## Decision

1. **format.md holds the public repository format and nothing else**: the bucket layout, the
   snapshot and the deletion record, and the reading, writing, uploading and deleting rules.
   s3cab's own files move to the page for their topic:
   - the README: the `~/.s3cab/` layout and `S3CAB_HOME`, the bucket's `.s3cab/` folder, what
     `@CLIENT HOME` means, and which settings s3cab writes into `@SET BUCKET` and `ENDPOINT`;
   - backup.md: what a set backs up (`dirs.txt`, overlapping member directories, a linked member
     directory recorded as its real path, `.s3cab` folders skipped, `@CLIENT EXCLUDE`);
   - exclude.md: the pattern syntax only, gaining `exclude.txt`'s trim set and the matching
     details (simple case folding, `ẞ`/`ß`, Turkish `ı`/`İ`, U+FFFD);
   - auth.md and aws.md, which already hold `env` and `roles-anywhere/`.
2. **A top-level folder `.<name>` belongs to the client named `<name>`.** Nothing a restore needs
   lives in one. Readers ignore every key under a `.` prefix; writers touch only the core layout
   and their own folder. There is no registry.
3. **`@S3CAB` rows describe the format**: the heading row, then `@S3CAB SPEC`, whose value is the
   date format.md states. The date changes when the format does, not its wording, and no reader
   refuses a file over it: it is for people, and for wording a refusal. There is no version
   number. An additive change needs none, and a breaking change changes the heading row, which
   every reader already matches exactly.
4. **`@CLIENT` rows say who wrote the file.** `@CLIENT NAME` is the client's folder name without
   the dot (`s3cab`), in the set-name characters; `@CLIENT VERSION` is free text. A valid file has
   exactly one of each, and one `@S3CAB SPEC`, and a reader ignores any of the three missing or
   repeated, as it ignores `FILES` disagreeing with the row count. Any other `@CLIENT` row is the client's own: s3cab's `HOME` and
   `EXCLUDE`. s3cab writes them after the `@S3CAB` rows, in deletion records too.
5. **Excluding is a format concept; the grammar is the client's, and exclusion is optional.**
   Anything a writer leaves out on purpose gets an `#excluded` row, except its own working
   folders. Column 2 is free text for people: a pattern in the writer's grammar, or blank. The
   refusals (a name holding a tab, CR or LF, a name with no UTF-8 form, overlapping member
   directories) say the backup stops, and that a writer may offer a way to leave the entry out.
6. **`@SET BUCKET` and `@SET ENDPOINT` are optional**, in the spec's own terms: the bucket the
   writer meant the snapshot for, as `s3://<bucket>`, and the S3 endpoint it used when that isn't
   AWS's default. A writer with no bucket in mind leaves `BUCKET` out.

## Considered and rejected

- **`@<CLIENT>` rows named after each client**, like its folder: `@S3CAB` would mean the format in
  one row and the tool in the next, and a reader would find the writer by elimination.
- **s3cab as the default when `@CLIENT NAME` is missing**: a writer that forgot to name itself
  would pass as s3cab, and its patterns as s3cab's grammar.
- **Refusing a file with no `@CLIENT NAME`**: only people read it, and the refusal would block a
  restore whose every file row is sound.
- **The spec date in the heading row's `time` cell**: that cell names the column for Excel's
  AutoFilter, and the heading row is matched exactly.
- **Naming the date row `PUBLISHED`**: s3cab already says "publish" for uploading a snapshot, so
  it reads as the file's upload date.
- **Requiring exclusion**: the format would dictate a feature.
- **One `exclude.txt` name for every client**: a client taking over a set would read another's
  patterns with its own grammar and silently back up different files.
- **s3cab's material kept in format.md under a "not the format" heading**: the golden set's stamp
  hashes format.md, so every s3cab doc edit would force a reseed, and the clean room takes the
  page as its spec.
- **A spec recommendation on how a client keeps its config**: what a client keeps in its folder
  is its own business.

## Consequences

- A unit test holds s3cab's `@S3CAB SPEC` constant to the date format.md states.
- format.md's "Trim the leading fields" defines its characters as `exclude.txt`'s. The set moves
  into that rule before the `exclude.txt` paragraph goes, or the rule points at nothing.
