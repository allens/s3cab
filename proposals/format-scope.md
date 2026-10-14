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

## Client prefixes

What I'm proposing is that a client may create other top-level folders, named after the client
with a `.` prefix. So the s3cab CLI reserves `s3://my-bucket/.s3cab/`, and under that we can have
`sets/`.

**Decided: the spec's rules for client folders.**

- A top-level folder starting with `.` belongs to a client, named after it. There is no
  registry; two clients choosing one name is theirs to sort out.
- Nothing a restore needs may live in one. It holds that client's own config and nothing else,
  which is what makes it safe to skip.
- Readers ignore every key under a `.` prefix. Writers touch only the core layout and their own
  folder, so s3cab's `cleanup` never touches another client's.

s3cab's folder then holds `.s3cab/sets/<set>/dirs.txt` and `exclude.txt`; `info` has moved to
`snapshots/<set>.info`.

## Set config vs set partition

I think there's a distinction to be made between *set config* and *set partitioning* — you'll see
why below. Set config is a client concern. The concept of a set is still important and is used on
the server side: it provides a backup-set partition.

**Decided: set ownership is part of the format.** A muddled history, where "latest" is another
machine's tree, is bad enough that the format prevents it rather than leaving it to each client.
The ownership marker moves to `snapshots/<set>.info`, beside the set's partition the way
`objects.deleted-<n>.tsv` sits beside `objects/`, so the core layout becomes:

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
- **Claim:** create `<set>.info` with a conditional PUT (`If-None-Match: *`); the loser is refused.
- **`<set>.info` holds three lines**, in `KEY=value` form:

  ```
  OWNER=allen@DESKTOP-7Q2
  CLAIMED=2026-10-14T09:15:32.123Z
  CREATED=2026-06-12T08:15:32.123Z
  ```

  `OWNER` is the holder as `user@machine`, one field like `@SNAPSHOT BY` and a `#deleted` row's
  last column. `CLAIMED` is when the holder claimed the set or took it over. `CREATED` is when the
  set was made, and never changes.
- **The ownership key is `OWNER` + `CLAIMED`.** The writer keeps a local copy of the pair, written
  when it claims or takes over. `CLAIMED` is what tells apart two writers with the same `OWNER`
  string (a second tool on one machine, a cloned VM); `CREATED` can't, since a takeover keeps it.
- **Every snapshot upload checks ownership:** read `<set>.info` first and refuse unless it still
  holds the writer's stored pair, compared as text. The pair is never recomputed, so a renamed
  machine or a drifting hostname (macOS) never locks anyone out, and the spec needn't pin down
  how `user@machine` is spelled. (s3cab's `backup` doesn't check today.)
- **Takeover is explicit:** rewrite `OWNER` and `CLAIMED`, keep `CREATED`, only when the user asks
  — s3cab's `reattach`. The old holder's next backup is then refused.
- **Supersedes ADR-0024's tolerance** of two live machines on one set (the OneDrive case) and its
  "owner is advisory" stance; ADR-0053 and docs/design follow. Two machines on one synced folder
  get a set each, losing only cross-set `compare`.
- **A rule for spec-adherent writers, not a lock:** anyone holding write keys can ignore it, and
  the spec says so.

## Consequences for the s3cab CLI

- **Attaching and taking over become two acts.** `reattach` pulls the config and snapshots and
  attaches the set read-only: `restore`, `list`, `find` and `compare` work as now. The first
  `backup` on a set this machine doesn't hold is refused, naming the takeover command. Today
  `reattach` re-stamps `OWNER`, which under the ownership rules would be a takeover just to get one
  file back. The exact command shape is cli-design's and ADR-0053's.
- **`reattach` doesn't require `.s3cab/` config.** A set another tool wrote has none, and s3cab
  must still restore it unaided: that is ADR-0096's "s3cab accepts spec-derived output" cell, and
  the no-lock-in promise read backwards. With no config, the set attaches with its snapshots and
  every read command works; `backup` refuses until the user writes a `dirs.txt` (the latest
  snapshot's `@SET DIR` rows say what to put in it) and takes the set over. Manual fix-up, no
  code deriving it.

## Exclude rules leave the spec

The big side effect is that `exclude.txt` and the exclude rules are no longer part of the spec.
This simplifies a lot. It seems near impossible to ratify one pattern-matching grammar that
accounts for multiple platforms, file systems and languages. I think it would suffice to say that
an s3cab-compatible client will likely need some suitable exclude/ignore functionality. s3cab has
one, which is documented of course, but that doesn't mean anyone else has to use the same rules.

**Decided: excluding is a format concept; the grammar is the client's.**

- `#excluded` and `#error` both stay. Being excluded is the same idea whatever the client; only
  the grammar differs.
- A `#excluded` row's column 2, and each `@SET EXCLUDE` row, hold a pattern in the writing
  client's own grammar. Readers record them and never interpret them.
- **A `@CLIENT` block says who wrote the file.** `@S3CAB` is the format and appears only in the
  heading row. Every writer gives `@CLIENT NAME` and `@CLIENT VERSION`; any other `@CLIENT` row
  is the client's own, so s3cab's `@S3CAB HOME` becomes `@CLIENT HOME` and `@SET EXCLUDE` becomes
  `@CLIENT EXCLUDE`, leaving `@SET` with only the format's facts. Deletion records get the same
  rows. Not `@<CLIENT>` rows named after each client like its bucket folder: `@S3CAB` would then
  mean the format in one row and the tool in the next, and a reader would find the writer by
  elimination. Not s3cab as the silent default: a writer that forgot to name itself would pass as
  s3cab, and its patterns as s3cab's grammar.
- The `.s3cab` never-walked rule moves to s3cab's docs; the format says only that a client may
  leave out its own working folders.
- `exclude.txt` stays in `.s3cab/`. Not a format-wide name any client's patterns go under: a
  client taking over a set would read another's patterns with its own grammar and silently back
  up different files.
- The spec recommends (not rules) that a client keep its config as plain UTF-8 text, one entry
  per line, in its own folder. Only a recommendation: what a client keeps there, SQLite or
  anything else, is its own business.
