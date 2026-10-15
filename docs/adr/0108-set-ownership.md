# Set ownership: `snapshots/<set>.info`, a read-only `reattach`, and `takeover`

**Status:** accepted & implemented (2026-10-14). Partly supersedes
[0013](0013-one-repository-one-bucket.md) (`sets/<set>/` leaves the layout; `.`-prefixed client
folders join it), [0024](0024-set-name-is-the-whole-identity.md) (two live machines on one set
stop being tolerated, `OWNER` stops being advisory, and its `sets/<set>/` marker goes; the set's
name stays its whole identity), [0052](0052-retire-setup-update-mode.md) (`backup` re-publishes
config to `.s3cab/sets/<set>/`), [0053](0053-reattach-command.md) (`reattach` no longer
re-stamps `OWNER`) and [0098](0098-snapshot-row-layout.md)'s "Who did something is always
`user@machine`" (`OWNER` advisory, and `reattach` comparing it). Client folders are
[0107](0107-the-spec-is-the-public-repository-format.md)'s.

## Context

[0024](0024-set-name-is-the-whole-identity.md) tolerated two live machines on one set and kept
`OWNER` advisory, re-stamped by `reattach`. Two writers on one set interleave their trees, so the
latest snapshot can be another machine's tree, and nothing checks at backup time. Meanwhile
`reattach` re-stamps `OWNER` even when someone only wants to look, so getting one file back is a
takeover.

## Decision

The format:

1. **Set ownership is part of the format.** The marker is `snapshots/<set>.info`, beside the set's
   snapshots; s3cab's config for the set goes to its client folder, `.s3cab/sets/<set>/`. The spec
   gains the set-name rule (lowercase letters, digits, hyphens): with no dot in a name,
   `<set>.info` can't be mistaken for a set, nor collide with a set's folder in a bucket copied to
   disk.
2. **`<set>.info` holds `OWNER` (the holder, as `user@machine`), `CLAIMED` (when the holder
   claimed or took over the set) and `CREATED` (when the set was first claimed; never changes).**
   It is read line by line: UTF-8, split on LF, one trailing CR stripped, each line split at its
   first `=` with the rest as the value, lines with no `=` and unknown keys skipped.
3. **A claim is a conditional PUT of `<set>.info`, and a new set is claimed only while
   `snapshots/<set>/` is empty.** One with snapshots and no `.info` already exists. The check
   and the PUT are on different keys, a gap stated rather than closed: a snapshot uploaded
   between them leaves a `.info` claiming a set with history, its `CREATED` later than its
   first snapshot.
4. **Publishing a snapshot checks ownership** immediately before the snapshot's upload: the writer
   reads `<set>.info` and refuses unless its `OWNER` and `CLAIMED` each match, as text, the pair
   the writer stored when it claimed. The pair is never recomputed, so a renamed machine or a
   drifting hostname never locks anyone out, and the spec needn't say how `user@machine` is
   spelled. Two gaps are stated rather than closed: a takeover landing between that read and the
   upload lets the old holder publish one more snapshot, since S3 can't make one key's upload
   conditional on another's; and the pair is a token, so it travels with copied state (a VM
   cloned after the claim, a migrated Mac, a restored `~/.s3cab`) and both copies pass.
5. **Taking a set over is explicit**: rewrite `OWNER` and `CLAIMED`, keep `CREATED`. A set with no
   `<set>.info` is taken over by creating one with a conditional PUT, `CREATED` equal to
   `CLAIMED`. Reading needs no `.info`: nothing a restore needs is in it.
6. **It is a rule for spec-adherent writers, not a lock**: anyone holding write keys can ignore
   it, and the spec says so.

s3cab:

7. **`s3cab reattach <set> --bucket <bucket>` attaches a set read-only, or refreshes one already
   attached**: it pulls the snapshots this machine lacks and nothing else. No config comes down,
   and `.info` isn't written. It needs neither `.s3cab/` config nor `.info`, so s3cab restores a
   set another client wrote unaided.
8. **`s3cab takeover <set> [--bucket <bucket>]` makes this machine the holder**: it attaches the
   set if needed, refreshes, pulls `dirs.txt` and `exclude.txt` from `.s3cab/` wherever no local
   file exists, then claims. On a set this machine already holds it does nothing and exits 0. No
   prompt: it deletes nothing, the old holder can take the set back, and the output names the
   machine it took over from.
9. **s3cab's stored pair is `~/.s3cab/sets/<set>/claim`**, the text it wrote to `.info`, read with
   the same reader. Its presence means this machine holds the set. A backup refused because
   another machine took over deletes it.
10. **`backup`, `upload --snapshot` and `forget` refuse on a set this machine doesn't hold**, naming
    `takeover`; `backup` checks when it starts too, so a refusal costs seconds rather than a pass.
    `setup` refuses a name whose `snapshots/<set>/` isn't empty, pointing at `reattach`. `list`
    stays offline, so for a read-only set it names who last backed it up, from its latest
    snapshot's `@SNAPSHOT BY`; `reattach` reads the holder from `.info`.

## Considered and rejected

- **`snapshots/<set>/info`**: digits sort before letters, so `info` would be the last key in the
  set's listing, where "take the last name as the latest" looks.
- **Recomputing `user@machine` at each backup**: a renamed machine or macOS's drifting hostname
  would lock its holder out. Binding the pair to an OS secret instead needs code per platform,
  and Migration Assistant copies the Keychain anyway.
- **Reading `.info` with `parseEnv` or another dotenv reader**: `#` starts a comment there, so a
  Windows user name holding `#` reads back cut short, and dotenv has no standard a spec could
  cite. Not tab-separated either: a tab typed in an editor often lands as spaces.
- **Claiming a set with no `.info` on its first backup**: the writer that skipped the claim keeps
  writing, and s3cab would join a muddled history without anyone choosing to.
- **`reattach --take-over`**: on an attached machine the fix would tell the user to "reattach",
  and the one act that switches another machine's backups off hides behind a modifier. Not
  `claim` as the name: that is the spec's word for the first, conditional create.
- **Config on a read-only attach**: `dirs.txt` and `exclude.txt` describe the holder's disk, and
  only the commands that walk this machine's disk read them.
- **`reattach` refusing a set that exists locally**: the only refresh would be delete and
  reattach, which on the holder's machine gives the set up.
- **The pair in the set's `env`**: `parseEnv` cuts at `#`, and `env` holds credentials. Not a
  local file named `info`: it would read as a synced copy of the bucket's and go stale silently.
- **`forget` open to any machine**: a machine that is only browsing could delete the holder's
  history.

## Consequences

- A backup reads `.info` twice, at the start and before the snapshot upload. The argument in
  [docs/design/backup.md](../design/backup.md) against a check at backup time, that it costs a
  marker GET per run, no longer holds.
- Two machines on one synced folder (0024's OneDrive case) get a set each, losing only `compare`
  across them.
