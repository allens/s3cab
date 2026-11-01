# s3cab guides

The full documentation, for when you want more than `--help`. New to s3cab? The
[README](../README.md) has the install and a quick start, and
[Getting started](getting-started.md) walks you through a first backup and a first restore
on a folder that doesn't matter.

Each of these has a terminal-sized counterpart: run `s3cab help <topic>` or
`s3cab <command> --help` for what you need mid-task without reaching for a browser. These
pages are the sit-down read.

## By situation

- **I deleted a file** — name it and get it back; everything else is left alone:
  [choosing what to restore](restore.md#choosing-what-to-restore).
- **I need last month's version of a file** — `--snapshot` picks the backup to restore from:
  [choosing which version](restore.md#choosing-which-version). To look at the old copy beside
  the current one, [copy it out](restore.md#copying-one-item-out) instead.
- **My laptop died** — attach the backup to the new machine, restore everything, then take the
  set over: [restoring onto a fresh machine](restore.md#restoring-onto-a-fresh-machine).
- **Is my backup OK?** — `verify` checks every file your snapshots mention is really stored,
  without downloading anything: [is my backup still good?](maintenance.md#is-my-backup-still-good-verify)
- **The bill is too high** — drop the snapshots you no longer want, then reclaim the space:
  [removing snapshots](maintenance.md#removing-snapshots-forget) and
  [reclaiming storage](maintenance.md#reclaiming-storage-cleanup). Reclaimed space frees once
  the bucket's [versioning window](maintenance.md#versioning-why-any-of-this-is-safe) elapses.
- **Something huge got backed up that I never wanted** — remove it from every backup, keeping
  the snapshots: [deleting files from every backup](maintenance.md#deleting-files-from-every-backup-delete).
- **Which backups hold this file?** — `find` searches every snapshot on this machine:
  [finding a file in your backups](find.md).
- **A file isn't being backed up** — see what the exclude patterns are dropping, and which
  pattern did it: [seeing what a pattern actually drops](exclude.md#seeing-what-a-pattern-actually-drops).
- **I edited a file and the backup kept the old version** — the rare edit that keeps a file's
  size and time: [when that rule is fooled](backup.md#when-that-rule-is-fooled), and
  [re-reading everything now and then](backup.md#re-reading-everything-now-and-then).
- **A backup stopped part way** — Ctrl+C, a crash or a lost connection, and what the next run
  does about it: [stopping part way](backup.md#stopping-part-way).
- **It says a backup is running, but nothing is** — a stopped run left its lock behind:
  [locks: backups and clean-ups take turns](maintenance.md#locks-backups-and-clean-ups-take-turns).
- **s3cab can't sign in** — expired sessions, rejected keys, and the signature mismatch a wrong
  endpoint produces: [when it doesn't work](auth.md#when-it-doesnt-work).
- **I don't use AWS** — Cloudflare R2, Backblaze B2, Wasabi and the like:
  [non-AWS providers](aws.md#non-aws-providers).
- **I want my files back without s3cab** — a snapshot and any gzip tool are enough:
  [recovering by hand](format.md#recovering-by-hand-no-s3cab).
- **I want to script it** — `--json` output and the exit codes: [output formats](output.md).

## Everyday

- **[Backing up](backup.md)** — what a set backs up and where its files live, how s3cab
  decides a file hasn't changed, the rare edits that fool it, and when to re-read everything
  with `--rehash`.
- **[Getting files back](restore.md)** — recovering a deleted file, an older version, or
  everything onto a fresh machine. The job the backup exists for.
- **[Reading a compare report](compare.md)** — what added / renamed / moved / modified /
  deleted mean, and why a "rotated" file reads as modified.
- **[Finding a file in your backups](find.md)** — which snapshots hold a file and what it
  hashed to; how a `find` pattern differs from an exclude pattern, and what the warnings mean.
- **[Exclude rules](exclude.md)** — the glob patterns that keep files out of a backup set.
  (Quick reference: `s3cab help exclude`.)
- **[Looking after a backup](maintenance.md)** — checking backups are still restorable
  (`verify`), dropping snapshots (`forget`), reclaiming storage (`cleanup`), why bucket
  versioning makes all of it safe to get wrong, and the `hashes` and `upload` building blocks
  underneath.

## Setting up

- **[Getting started](getting-started.md)** — a first set on a small folder, a first backup,
  a deleted file back, a second backup and what changed, and what `list` and `status` tell
  you. Start here once you have a bucket.
- **[Setting up a cloud bucket](aws.md)** — standing up an AWS bucket and a locked-down
  identity, the versioning/lifecycle model, keyless
  [Roles Anywhere](aws.md#--roles-anywhere--keyless-certificate-based-access) access, and
  [non-AWS providers](aws.md#non-aws-providers) (R2, B2, Wasabi, …).
- **[Signing in to your storage](auth.md)** — the four ways a set signs in, where s3cab looks
  for credentials, and what to do when the server rejects them.
  (Quick reference: `s3cab help provider`.)

## Reference

- **[The format spec](format.md)** — the repository layout, the snapshot-file grammar, and
  recovering by hand with no s3cab at all. The stored format is a promise, and this is it
  written down.
- **[Output formats](output.md)** — human-readable text by default, `--json` for scripts.
