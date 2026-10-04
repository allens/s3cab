# An online-only file is read like any other file

**Status:** accepted & implemented (2026-10-04). Supersedes
[0081](0081-online-only-files-skipped.md), and with it the placeholder exemption in
[0085](0085-ctime-cross-check-on-hash-reuse.md)'s change-time check, which
[0094](0094-change-time-check-opt-in.md) had kept.

## Context

0081 left a dehydrated cloud placeholder (Windows Files On-Demand: OneDrive, Dropbox, Google
Drive) unread. It recorded the file as an `Online-Only File` skip and printed a hint offering
`--include-online-only`. That took a Windows-only stat predicate with a measured 4KB floor, an
error subclass caught by type, a second author for the `dirent_type` column, a flag on two
commands, a separate result channel through `upload --dir`, an ordering rule in `fileProps`, and
an exemption in the change-time check.

The stance this replaces it with, in the user's words: *"fundamentally s3cab is for backing up
local files. i just want it to work nicely with onedrive. so that means 'all files locally' or at
least you're doing it on a machine with enough breathing room for work with online-only files."*

Two facts carry the decision, the first measured for 0081:

- **A file reaches the hash only when it has no usable stored hash.** `mtime` is unchanged across
  hydrate and dehydrate, so a file s3cab already holds reuses its hash without being opened,
  whatever state the sync client keeps it in. What is left is new or edited, and usually local
  already, because something just wrote it.
- **When it isn't local, downloading it is what backing it up means.** It can be made online-only
  again afterwards, and the next run reuses its hash without opening it.

## Decision

1. **A placeholder is read like any other file.** No detection, no skip, no hint. If its bytes
   are not on disk, reading it downloads them.
2. **`--include-online-only` is gone** from `snapshot` and `backup`, and `upload --dir` loses its
   `onlineOnly` result.
3. **The change-time check ([0094](0094-change-time-check-opt-in.md)) has no placeholder
   exemption.** Dehydration moves only ctime, so with the check on, a dehydrated file is
   distrusted, re-read and downloaded. That happens only on a set that opted in, and the guide
   already says not to opt in on a synced folder.

## Consequences

- A first backup of a synced folder downloads every online-only file in it. On a disk smaller
  than the cloud account it fills the disk. That is the case the stance puts out of scope: have
  the files local, or the room for them.
- `--rehash` reads every file, so on a synced folder it downloads every online-only one.
- A download that fails (offline, sync client not running) is a read that fails, so the file is
  an ordinary `#ERROR` row and the run exits 1.
- `dirent_type` is written by the walk alone again.
- 0081's open macOS question (`SF_DATALESS`) is moot.
- Gone from the code: `hasNoBytesOnDisk`, `RESIDENT_CEILING`, `DETECT_ONLINE_ONLY`,
  `OnlineOnlyFileError`, `warnAboutOnlineOnly`, the placeholder clause in `trustMatch`, and the
  check-after-reuse ordering rule in `fileProps`.
