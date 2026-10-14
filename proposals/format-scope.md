# Format scope

I'm having a big rethink about the clean room, and about what constitutes the "format".

This file is the format half, and lands first. The clean-room half, built against it, is
[cleanroom-harness.md](cleanroom-harness.md); running clean rooms in CI is
[cleanroom-ci.md](cleanroom-ci.md).

## Client config leaves the format

I think it would be better not to include `info`, `dirs.txt` and `exclude.txt` in the format.

The rationale is that they are client-specific. Their existence in the bucket is merely a backup
of client config, and they aren't necessary for backup or restore. That's not to say we shouldn't
document their formats: the s3cab client (as opposed to the s3cab format) still extends the same
promises — easy to understand, opens with basic and ubiquitous tools, and user-editable.

That leaves the core of the bucket as:

```
s3://my-bucket/
  objects/
  snapshots/
  objects.deleted-<n>.tsv
```

**Decided: format.md is the public repository format and nothing else.** s3cab's own files move
to the pages that already cover their topic:

- README: the `~/.s3cab/` layout and `S3CAB_HOME`; the bucket's `.s3cab/` folder, with
  `exclude.txt` uploaded as a byte copy; what `@CLIENT HOME` means; which settings s3cab writes
  into `@SET BUCKET` and `@SET ENDPOINT`.
- backup.md, a new section on what a set backs up: `dirs.txt`'s rules, overlapping member
  directories, a linked member directory recorded as its real path, `.s3cab` folders skipped,
  `@CLIENT EXCLUDE`.
- exclude.md keeps its name and covers the pattern syntax only. It gains `exclude.txt`'s exact
  trim set and the matching details only format.md has today: simple case folding, `ẞ`/`ß`,
  Turkish `ı`/`İ`, U+FFFD.
- auth.md, aws.md and backup.md already hold `env`, `roles-anywhere/` and the two temporary
  snapshot files.
- Not one new page for s3cab's files: the README already draws the `~/.s3cab/` layout.
- Trap: format.md's "Trim the leading fields" defines its characters as `exclude.txt`'s. The set
  moves into that rule before the `exclude.txt` paragraph goes.

## Client prefixes

What I'm proposing is that a client may create other top-level folders, named after the client
with a `.` prefix. So the s3cab CLI reserves `s3://my-bucket/.s3cab/`, and under that we can have
`sets/`.

**Decided: the spec's rules for client folders.**

- A top-level folder starting with `.` belongs to a client: `.<name>`, where `<name>` is the
  client's `@CLIENT NAME`. There is no registry; two clients choosing one name is theirs to sort
  out.
- Nothing a restore needs may live in one. It holds that client's own config and nothing else,
  which is what makes it safe to skip.
- Readers ignore every key under a `.` prefix. Writers touch only the core layout and their own
  folder, so s3cab's `cleanup` never touches another client's.
- Not a spec recommendation on how a client keeps its config: format.md holds only the
  repository format, and what a client keeps in its folder is its own business.

s3cab's folder then holds `.s3cab/sets/<set>/dirs.txt` and `exclude.txt`; `info` has moved to
`snapshots/<set>.info`.

## Set config vs set partition

I think there's a distinction to be made between *set config* and *set partitioning* — you'll see
why below. Set config is a client concern. The concept of a set is still important and is used on
the server side: it provides a backup-set partition.

**Decided: set ownership is part of the format.** A muddled history, where "latest" is another
machine's tree, is bad enough that the format refuses a writer that doesn't hold the set, rather
than leaving it to each client. The ownership marker moves to `snapshots/<set>.info`, beside the
set's partition the way `objects.deleted-<n>.tsv` sits beside `objects/`, so the core layout
becomes:

```
s3://my-bucket/
  objects/<sha256>
  objects.deleted-<n>.tsv
  snapshots/<set>/<name>.tsv.gz
  snapshots/<set>.info
```

- Not `snapshots/<set>/info`: digits sort before letters, so `info` would be the last key in the
  set's listing, where "take the last name as the latest" looks.
- Listing `snapshots/` with a `/` delimiter finds every set, one with no snapshots yet included.
- The spec gains the set-name rule (today only s3cab's `validateSetName`): lowercase letters,
  digits and hyphens. With no dot in a name, `<set>.info` can't be mistaken for a set, nor
  collide with a set's folder in a bucket copied to disk.
- **Claim:** create `<set>.info` with a conditional PUT (`If-None-Match: *`); the loser is
  refused. A new set is claimed only while `snapshots/<set>/` is empty: one with snapshots and no
  `.info` already exists, and is taken over (below).
- **`<set>.info` holds three lines**, in `KEY=value` form:

  ```
  OWNER=allen@DESKTOP-7Q2
  CLAIMED=2026-10-14T09:15:32.123Z
  CREATED=2026-06-12T08:15:32.123Z
  ```

  `OWNER` is the holder as `user@machine`, one field like `@SNAPSHOT BY` and a `#deleted` row's
  last column. `CLAIMED` is when the holder claimed the set or took it over. `CREATED` is when the
  set was first claimed, and never changes.
- **Reading it:** UTF-8, split on LF, one trailing CR stripped; each line splits at its first
  `=` and the rest is the value; unknown keys are skipped.
  - Not `parseEnv` or another dotenv reader: `#` starts a comment there, so a Windows user name
    holding `#` reads back cut short, and dotenv has no standard a spec could cite.
  - Not tab-separated: a tab typed in an editor often lands as spaces, and the snapshot's reading
    rules wouldn't carry over anyway, since they keep a CR.
- **The ownership key is `OWNER` + `CLAIMED`.** The writer keeps a local copy of the pair, written
  when it claims or takes over. `CLAIMED` is what tells apart two writers with the same `OWNER`
  string, such as a second tool on one machine; `CREATED` can't, since a takeover keeps it.
- **The pair is a token, so it travels with copied state**: a VM cloned after the claim, a Mac
  moved with Migration Assistant, a restored `~/.s3cab`. Both copies pass. The spec says so; the
  check refuses writers without the pair, it doesn't detect copies.
- **Publishing a snapshot checks ownership**, immediately before the snapshot's upload: read
  `<set>.info` and refuse unless it holds the writer's stored `OWNER` and `CLAIMED`, each compared
  as text, never the whole file. The pair is never recomputed, so a renamed machine or a drifting
  hostname (macOS) never locks anyone out, and the spec needn't pin down how `user@machine` is
  spelled. (s3cab's `backup` doesn't check today.)
- **The spec names the gap that remains:** a takeover landing between that read and the upload
  lets the old holder publish one more snapshot. S3 can't make one key's upload conditional on
  another's.
- **Takeover is explicit:** rewrite `OWNER` and `CLAIMED`, keep `CREATED`, only when the user asks
  — `s3cab takeover`. The old holder's next backup is then refused. A set with no
  `<set>.info` is taken over by creating one with a conditional PUT, `CREATED` equal to
  `CLAIMED`.
- **Reading needs no `<set>.info`.** Nothing a restore needs is in it, so a reader works on a set
  without one.
- **Supersedes ADR-0024's tolerance** of two live machines on one set (the OneDrive case) and its
  "owner is advisory" stance; ADR-0053 and docs/design follow. Two machines on one synced folder
  get a set each, losing only cross-set `compare`.
- **A rule for spec-adherent writers, not a lock:** anyone holding write keys can ignore it, and
  the spec says so.

## Consequences for the s3cab CLI

- **Attaching and taking over become two acts.** Today `reattach` re-stamps `OWNER`, which under
  the ownership rules would be a takeover just to get one file back.
  - `reattach` attaches the set read-only, or refreshes one already attached: it pulls the
    snapshots this machine lacks, and nothing else. No config comes down and `<set>.info` isn't
    written.
  - `s3cab takeover` refreshes, pulls `dirs.txt` and `exclude.txt` from `.s3cab/` wherever no
    local file exists, then claims.
  - `restore`, `list`, `find` and `compare` work on a read-only set; `list` shows who last backed
    it up in place of its directories.
  - `backup`, `upload --snapshot` and `forget` on a set this machine doesn't hold are refused,
    naming `s3cab takeover`. `backup` also checks when it starts, so a refusal costs seconds
    rather than a whole pass.
  - `setup` refuses a name whose `snapshots/<set>/` isn't empty, pointing at `reattach`.
  - Not config on a read-only attach: `dirs.txt` and `exclude.txt` describe the holder's disk, and
    only the commands that walk this machine's disk (`snapshot`, `tree`, `status`, `backup`) read
    them.
  - Not `reattach` refusing a set that exists locally: the only refresh would be delete and
    reattach, which on the holder's machine gives the set up.
- **`reattach` needs neither `.s3cab/` config nor `<set>.info`.** A set another tool wrote may
  have neither, and s3cab must still restore it unaided: that is ADR-0096's "s3cab accepts
  spec-derived output" cell, and the no-lock-in promise read backwards. The set attaches with its
  snapshots and every read command works; `backup` refuses until the user writes a `dirs.txt`
  (the latest snapshot's `@SET DIR` rows say what to put in it) and takes the set over. Manual
  fix-up, no code deriving it.

## Exclude rules leave the spec

The big side effect is that `exclude.txt` and the exclude rules are no longer part of the spec.
This simplifies a lot. It seems near impossible to ratify one pattern-matching grammar that
accounts for multiple platforms, file systems and languages. I think it would suffice to say that
an s3cab-compatible client will likely need some suitable exclude/ignore functionality. s3cab has
one, which is documented of course, but that doesn't mean anyone else has to use the same rules.

**Decided: excluding is a format concept; the grammar is the client's.**

- `#excluded` and `#error` both stay. Being excluded is the same idea whatever the client; only
  the grammar differs.
- **Exclusion is optional for a writer.** Anything it leaves out on purpose gets an `#excluded`
  row, except its own working folders. The spec's refusals (a name with a tab, CR or LF, a name
  with no UTF-8 form, overlapping member directories) say the backup stops, and that a writer may
  offer a way to leave the entry out. Not required: the format would dictate a feature.
- An `#excluded` row's column 2 is free text for people, like an `#error` row's message: a
  pattern in the writing client's own grammar, or blank. Readers never interpret it, nor
  `@CLIENT EXCLUDE` rows.
- **A `@CLIENT` block says who wrote the file.** `@S3CAB` rows describe the format: the heading
  row, and the date row below. Every writer gives `@CLIENT NAME` and `@CLIENT VERSION`; any other
  `@CLIENT` row is the client's own, so s3cab's `@S3CAB HOME` becomes `@CLIENT HOME` and
  `@SET EXCLUDE` becomes `@CLIENT EXCLUDE`, leaving `@SET` with only the format's facts. Deletion
  records get the same rows. Not `@<CLIENT>` rows named after each client like its bucket folder:
  `@S3CAB` would then mean the format in one row and the tool in the next, and a reader would find
  the writer by elimination. Not s3cab as the silent default: a writer that forgot to name itself
  would pass as s3cab, and its patterns as s3cab's grammar.
  - `@CLIENT NAME` is the client's folder name without the dot (`s3cab`), in the set-name
    characters. `@CLIENT VERSION` is free text.
  - A valid file has exactly one of each. A reader that finds one missing or repeated ignores it,
    as it does `FILES` disagreeing with the row count: only people read them.
  - s3cab writes them straight after `@S3CAB SPEC`.
- **`@S3CAB SPEC` dates the spec a file follows**: the date format.md states. It changes with the
  format, not its wording, and a unit test holds s3cab's constant to format.md's date. Readers
  never refuse a file over it; it is for people, and for wording a refusal ("written to the
  format of …"). Deletion records carry it too.
  - No version number: additive changes need none, and a breaking change changes the heading row,
    which every reader already matches exactly.
  - Not in the heading row's `time` cell: that cell names the column for Excel's AutoFilter, and
    the heading row is matched exactly.
- **`@SET BUCKET` and `@SET ENDPOINT` are optional**, in the spec's own terms: the bucket the
  writer meant the snapshot for, as `s3://<bucket>`, and the S3 endpoint it used when that isn't
  AWS's default. Only people read them; a writer with no bucket in mind leaves `BUCKET` out. Which
  settings s3cab reads for them is s3cab's docs.
- The `.s3cab` never-walked rule moves to s3cab's docs; the format says only that a client may
  leave out its own working folders.
- `exclude.txt` stays in `.s3cab/`. Not a format-wide name any client's patterns go under: a
  client taking over a set would read another's patterns with its own grammar and silently back
  up different files.

## Still to plan

- **Recorded** as [ADR-0107](../docs/adr/0107-the-spec-is-the-public-repository-format.md) and
  [ADR-0108](../docs/adr/0108-set-ownership.md), both accepted and implemented.
- **The spec date:** move format.md's date and `SPEC_DATE` in snapshot-file.mjs to the day the
  ownership change lands, if that isn't 2026-10-14.
- **Clean room:** the seed's "is this bucket mine?" check reads `snapshots/<set>.info` as a
  foreign set and `.s3cab/` keys as strays; then a reseed.
- **Live buckets:** run `s3cab takeover` for each real set on the machine its latest
  `@SNAPSHOT BY` names, copying the old `CREATED` in by hand if wanted, then delete `sets/`; check
  that no real set is backed up from two machines.
