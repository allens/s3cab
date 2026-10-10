# Snapshot format

Epic: the shape of the snapshot file itself — its columns, its row types and what each one
records. The spec is [guide/format.md](../guide/format.md); this is what might change in it.

- **A new row layout.** Discussed 2026-10-09. Pre-1.0, so nothing existing constrains it: not old
  snapshots, not the clean-room golden set or its restorers. The aims are that it reads well in
  Notepad, and that Excel's AutoFilter, sorting and `SUM` all work on it. Agreed so far:

  | Col | Heading | Width | File row | Other rows |
  | --- | --- | --- | --- | --- |
  | 1 | `#S3CAB` | 6 | `object` | the row's type |
  | 2 | | 64 | the hash | the property (`#S3CAB`, `#SET`, `#SNAPSHOT`), or a per-path row's wide text: a pattern, an error, a link target |
  | 3 | `size` | 12, right-aligned | size in bytes | always blank |
  | 4 | `time` | 24 | mtime | an instant, where the row has one |
  | 5 | | ragged | the path | the path, or the property's value |

  ```
  #S3CAB                 size          time                      https://s3cab.plantegral.com/guide/format
  #S3CAB     VERSION                                           0.14.0
  #S3CAB     HOME                                              C:\Users\allen\.s3cab\
  #SET       NAME                                              onedrive
  #SET       BUCKET                                            s3://my-backups
  #SET       DIR                                               D:\OneDrive\
  #SET       EXCLUDE                                           ~$*
  #SNAPSHOT  NAME                                              2026-10-08T1656
  #SNAPSHOT  BY                                                allen@DESKTOP-7Q2K
  #SNAPSHOT  START                   2026-10-08T15:56:00.000Z  Europe/London
  #excluded  ~$*                                               D:\OneDrive\~$budget.xlsx
  #error     EPERM: operation not permitted, …                 D:\OneDrive\locked.docx
  link       ..\2026\img.jpg                                   D:\OneDrive\Photos\latest.jpg
  object     9f86d0…    15463758036  2026-08-27T19:11:12.000Z  D:\OneDrive\backup\…\pack-5a31….pack
  #SNAPSHOT  FILES                                             281785
  #SNAPSHOT  SIZE                                              1234567890123 (1.1 TiB)
  #S3CAB     END                     2026-10-08T17:42:10.123Z
  ```

  - **Row 1 is a fixed heading row**, so AutoFilter's dropdowns have names. Its first string,
    `#S3CAB`, is the first thing in the file and says what the file is. Only `size` and `time`
    are named: columns 2 and 5 hold different things on different rows, so column 2 stays
    blank. Measured 2026-10-09: blank headings still get a dropdown, and filter the same as
    named ones. Measured 2026-10-10: AutoFilter always takes row 1 as its heading, so without
    this row the first property row would play it, showing through every filter and never
    sorting. Data › Sort guesses there is no heading and sorts this row in with the rest,
    unless "My data has headers" is ticked.
  - **The heading's last column is the format spec's URL**, the same in every s3cab file, so a
    file found on its own says where it is explained. Unversioned: after 1.0 the format only
    changes additively, so the current spec describes every older file, and `#S3CAB VERSION`
    says which release wrote it. It freezes the URL into every stored file, so keeping the
    domain and not renaming `guide/format.md` (CLAUDE.md) now protect data, not just
    binaries. Measured 2026-10-10: Excel imports it as text, not a hyperlink.
  - **A lowercase type is something restore could act on; a `#` type is not.** `object`
    and `link` are the backup's content: a link is recorded as itself, even though it has no
    object. `#excluded` and `#error` record paths that weren't saved, alongside `#SET` and
    `#SNAPSHOT`. So a reader that skips `#` lines is left with exactly what a restore writes.
    Each per-path row can name a file or a folder; the trailing separator says which.
  - **Case says the scope: lowercase is one path from inside the walk, uppercase is the whole
    snapshot from outside it.** So `object`, `link`, `#excluded` and `#error` against `#S3CAB`,
    `#SET` and `#SNAPSHOT`. Types are case-sensitive; Excel's sort and filter ignore case.
  - **Hash first** because it is the primary key; then the fixed-width fields, and the path last
    as the ragged edge ([ADR-0004](../docs/adr/0004-tsv-snapshot-manifests.md)). Size and time
    stay in that order: hash and size describe the stored object, time and path the file at
    that path.
  - **A type names what column 2 holds**: an `object` row's column 2 is the object's name, a
    `link` row's the link's target, an `#error` row's the message. Not `file`: every per-path
    row is about a file, so `file` would name column 5 instead. Not `sha256`: the hash is
    SHA-256 by design ([ADR-0001](../docs/adr/0001-file-level-content-addressable-dedup.md))
    and names the stored objects, so another algorithm would be a format change anyway; the
    spec says so once. Two paths with the same content are two `object` rows naming one
    object, which is what dedup means.
  - **Size holds file sizes only**, so `=SUM` over it is the backup's total. A total stored in
    that column would double it. 12 wide because the largest file in a real set has an
    11-digit size (a 14.4 GiB git pack).
  - **A directory's path ends with a separator** (`…\cache\`). That replaces the entry-type
    column `#EXCLUDED` and `#SKIPPED` carry today.
  - **`#SKIPPED` goes** ([filesystem-edge-cases.md](filesystem-edge-cases.md)). A link row
    records a link, with its target in the wide column so the path stays the ragged edge. No
    separate junction type.
  - **Three whole-snapshot types, one fact per row**, so that a snapshot found on its own says
    where it came from. Column 2 is the property; the value goes in the last column, the
    instant in the time column. Each records things as this run saw them, so a value can go
    stale later without the row being wrong.
    - **`#S3CAB`** is the file itself and the software that wrote it: `VERSION`, `HOME` (the
      s3cab home on that machine) and `END`. The set's directory and this snapshot's local
      path follow from `HOME` and the names, so neither is recorded.
    - **`#SET`** is the set's configuration: `NAME`, `BUCKET`, `ENDPOINT` (only for a provider
      other than AWS, where a bucket name alone doesn't say where it is), `DIR` once per
      member directory, and `EXCLUDE` once per exclude pattern in force. The bucket's paths
      follow from `BUCKET` and the layout the spec fixes. The bucket's copy of `exclude.txt`
      is only the latest; these rows say which patterns applied to this run, including ones
      that matched nothing. Not the set's `info` marker: `OWNER` is whoever claimed the set,
      not necessarily who ran, and both it and `CREATED` would cost a bucket read per run.
    - **`#SNAPSHOT`** is the run: `NAME`, `BY`, `START`, `FILES`, `SIZE`. `BY` is
      `user@machine`, the form deletion records use. `START`'s last column is the time zone.
      The name is local wall-clock time, so the zone is what ties it to the instant: `1656`
      in London in October is `15:56Z`.
  - **A reader skips a `#` type or sub-type it doesn't know, and refuses a lowercase type it
    doesn't know.** An unknown `#` row is information a newer s3cab added; an unknown lowercase
    row is content a restore would miss. So a new property stays additive after 1.0, and new
    content is a format break that says so.
  - **`#S3CAB END` is the last line of every s3cab file, and it means the file is complete.** A
    file without it was cut short, whatever the cause, so one check reads every kind. Its
    instant is when the file was finished, which for a snapshot is when the run finished.
    So the lookup file parked on Ctrl+C
    ([ADR-0067](../docs/adr/0067-park-hashes-on-interrupt.md)) stops after its last object row,
    with no `FILES`, `SIZE` or `END`, and the `COMPLETE`/`PARTIAL` status goes. That file is
    only read back by the tolerant read of
    [ADR-0092](../docs/adr/0092-recover-the-interrupted-work-file.md), which drops the last
    row, so a graceful stop now costs one file re-hashed, as a killed run already does.
    `FILES` and `SIZE` come just before `END`.
  - **`FILES` and `SIZE` are exact**, so each checks something: `FILES` against the count of
    `object` rows, `SIZE` against `=SUM` of the size column. `SIZE` carries a readable form in
    parentheses, which also keeps it text; a bare 13-digit number shows as `1.23E+12` in a
    column of default width.
  - **A folder that can't be listed stops the walk**; it gets no `#error` row.
  - **Column 1 is 6 wide, the length of `object`**, so an object row carries no padding: its
    hash and mtime are exactly their widths too. Excel keeps padding in the cell, leading or
    trailing (measured 2026-10-09: a type padded to 9 imports as `sha256   `, so
    `=COUNTIF(A:A,"sha256")` is 0), and a padded column would put it on every object row.
    `#SNAPSHOT` and `#excluded` overflow instead, which pushes the rest of their row one tab
    stop right in Notepad: in the real set's snapshot, 37 rows (32 exclusions and the five
    `#SNAPSHOT` rows) beside 281,785 object rows.
  - **Excel's ascending sort** puts `#…` before words: `#error`, `#excluded`, `#S3CAB`, `#SET`,
    `#SNAPSHOT`, `link`, `object`. Padded sizes import as numbers, and `SUM` is right.

- **The deletion record takes the same layout.** Discussed 2026-10-10. What
  [ADR-0090](../docs/adr/0090-deletion-record-format-compaction.md) decided about its job stays:
  no paths, numbered files at the bucket root, uncompressed, compacted by `cleanup`. Only the
  rows change: today's unpadded `hash / size / instant / user@machine` become `#deleted` rows
  in the five columns, the deletion instant in the time column and `user@machine` last, the
  form `#SNAPSHOT BY` uses.

  ```
  #S3CAB                 size          time                      https://s3cab.plantegral.com/guide/format
  #S3CAB     VERSION                                           0.14.0
  #S3CAB     HOME                                              C:\Users\allen\.s3cab\
  #deleted   a3f9c21e…60d         1204  2026-08-14T09:31:07.412Z  allen@DESKTOP
  #deleted   5e21ab7f…c93          892  2026-08-19T22:10:41.006Z  allen@LAPTOP
  #S3CAB     END                        2026-10-10T09:12:00.000Z
  ```

  - **`#deleted`, lowercase with a `#`**: one object, and nothing restore can act on, like
    `#excluded` and `#error`. The type replaces ADR-0090's test of a 64-hex first field as what
    makes a row count.
  - **The `#DELETED` header goes.** Its instant repeats the rows', and its sentence ("absence
    here is not damage") is now said by every row's type; the spec says the rest.
  - **No `#SET`, `#SNAPSHOT`, bucket or count rows.** A record belongs to the bucket, not a set
    or a run, and only means anything inside it; `#S3CAB END` already proves it whole, which
    matters because a lost row lets `backup` trust a baseline that vouches for deleted content.
  - **`#deleted` is 8 characters, so it overflows column 1 on every row.** The rows still line
    up with one another; only the `#S3CAB` rows sit one tab stop left.

- **Who reads each property.** Traced through `src/` 2026-10-10, mapping today's fields onto
  the new rows.

  | Read by the code | What reads it |
  | --- | --- |
  | `object`: hash, size, time, path | restore, compare, backup's hash reuse and upload |
  | `link`: target, path | compare, so a link isn't reported deleted; restore, if it recreates links (not decided) |
  | `#error`: message, path | compare ([ADR-0079](../docs/adr/0079-previously-unreadable-file-is-an-annotated-addition.md)); backup's exclude suggestions |
  | `#SET DIR` | `restore --output`, which re-roots by it |
  | `#SNAPSHOT START`'s instant | compare's out-of-order warning; ignoring a stale parked lookup; the change-time check's boundary |
  | `#S3CAB END`, being there | the completeness check |
  | `#deleted`: hash, instant | verify, restore, backup, status, forget, cleanup; the instant keeps the newest of repeated rows and is shown as a date |

  - **Read only by people:** `#S3CAB HOME`, `#SET NAME` (deliberately not checked, see
    `readParkedLookup`), `#SET BUCKET`/`ENDPOINT`/`EXCLUDE`, `#SNAPSHOT NAME` (the code takes
    the filename), `BY`, `START`'s zone, `FILES` and `SIZE` (a hand edit can change either, so a
    mismatch isn't damage), `#S3CAB END`'s instant, every `#excluded` row, and a `#deleted`
    row's size and `user@machine`.
  - **A reader skips the people-only rows the way it skips an unknown sub-type**, so it needn't
    parse them. Today's parser reads the set name, zone, status and end instant, and nothing
    uses any of them. Promoting a row to the code later is a feature change, not a format one.
  - **Not built; a program could use these:**
    - the opening `#S3CAB`, to refuse a file that isn't s3cab's before parsing it;
    - `#S3CAB VERSION`, to name the release that wrote a file the unknown-type rule refuses, so
      the error says what to upgrade to;
    - `#excluded` rows, so `compare` reports a path a newly added pattern drops as excluded,
      not deleted. That reopens the choice `snapshot-file.mjs` records as settled (only
      `tree --excluded` answers "what are my patterns dropping?"), though it answers a
      different question;
    - `#SET BUCKET`/`ENDPOINT`, to restore from a lone snapshot with no set configured. The
      most speculative of the four.

- **Who did something is always `user@machine`, and the set's `info` `OWNER` follows.** Today
  `#deleted` rows (and `#SNAPSHOT BY`, as proposed) are `user@machine`, while `OWNER` is the
  bare hostname. Not split into two fields: a `#deleted` row has only its last column free.
  The user belongs in `OWNER` because the collision rule is "first person wins"
  ([ADR-0024](../docs/adr/0024-set-name-is-the-whole-identity.md)), and `OWNER` is advisory,
  so this doesn't put the user back into the set's identity. `reattach` compares `OWNER` with
  `user@machine` too, so another user on the same machine now also counts as a change of
  owner. The keys stay distinct: `OWNER` claimed the set, `BY` ran the snapshot.

- **Hold the fourth clean-room run (Windows, C#) until this revision lands.** Run now, it would
  prove a format about to be replaced.
