# Backing up

`s3cab backup <set>` is the whole routine job. This page covers what a set backs up and where
it lives, how s3cab decides a file hasn't changed (and the rare edits that fool it), and what
happens when a backup stops part way.

## What a set backs up

A set's directories are listed in `~/.s3cab/sets/<set>/dirs.txt`, one absolute path per line.
Blank lines are ignored, a line starting with `#` is a comment, and each line is trimmed the
way an [exclude file's](exclude.md) lines are. Editing that file is how you add or drop a
directory.

- **Everything under each directory is backed up**, hidden and system files included, except
  what your [exclude patterns](exclude.md) leave out. Each snapshot lists the patterns that
  applied to that run in its `@CLIENT EXCLUDE` rows, one per pattern, including any that
  matched nothing; the copy of `exclude.txt` in the bucket is only the latest.
- **Links inside a directory are never followed**; the [format spec](format.md#links) says
  what a snapshot records for them. A directory in `dirs.txt` that is itself a link is
  followed, since you named it, and recorded as its [real path](format.md#paths).
- **The directories mustn't overlap.** A file reached from two of them stops the backup,
  unless an exclude pattern keeps the inner directory out of the outer one's walk.
- **A directory named `.s3cab`**, all lowercase even on Windows, is never walked: it is
  s3cab's own, and backing it up would back up the tool's working files. It gets no row in
  the snapshot unless an exclude pattern matches it, and then it is listed as excluded like
  any other. Only a directory is skipped: a file or a link named `.s3cab` is backed up as
  usual.

## Where a set lives

A set is a folder of plain files in s3cab's home, never inside the directories it backs up:

```
~/.s3cab/sets/photos/
  claim                     # present while this machine holds the set
  dirs.txt                  # the directories that make up the set — yours to edit
  env                       # S3CAB_BUCKET=… plus how this set signs in
  exclude.txt               # patterns for files to skip — yours to edit
  snapshots/
    20251110T2104.tsv.gz    # one snapshot per run
    20251111T0830.tsv.gz
```

- **Editing a set is editing these files**, and deleting the folder deletes the set.
- **Only `env` can't be got back.** `s3cab reattach` pulls the snapshots back down from the
  bucket, and `s3cab takeover` the directory list and exclude rules too. `env` never leaves
  this machine, since it can hold credentials ([signing in](auth.md)).
- **`claim`** marks this machine as the set's holder, the one machine that backs it up
  ([who holds a set](format.md#who-holds-a-set)).
- **`~/.s3cab` is the home on every OS.** Set `S3CAB_HOME` to move the whole tree; every path
  s3cab prints follows it. Beside `sets/`, the home holds `roles-anywhere/`, this machine's
  keyless identity if you set one up ([signing in](auth.md#roles-anywhere-keyless)), and the
  templates `s3cab aws` writes ([setting up a cloud bucket](aws.md)).

Each snapshot records a few of these settings for whoever reads it later:

- `@CLIENT HOME` is the home it was taken from, so the set's folder and the snapshot's own
  path follow from it and the names.
- `@SET BUCKET` is the set's `S3CAB_BUCKET`.
- `@SET ENDPOINT` is its endpoint, when it has one: `AWS_ENDPOINT_URL_S3`, else
  `AWS_ENDPOINT_URL`.

### Its copy in the bucket

s3cab keeps a copy of each set's directory list and exclude rules in the bucket, in its own
folder, so a machine taking the set over gets them back:

```
s3://my-backups/.s3cab/sets/photos/
  dirs.txt                  # its member directories
  exclude.txt               # its exclude patterns, if it has any
```

- `exclude.txt` is a byte-for-byte copy of yours.
- `dirs.txt` is the list s3cab read from yours, one directory per line, without its comments
  and blank lines.
- Another tool leaves `.s3cab/` alone, as s3cab leaves any other `.`-named folder alone
  ([the format spec](format.md#the-remote-repository-the-keystone)).

## How s3cab spots an unchanged file

A backup doesn't read every file. If a file has the **same size and the same modification
time** as the previous snapshot records for it, s3cab treats it as unchanged and reuses the
hash it stored last time, without opening the file. rsync uses the same rule. It's why a
routine backup of a large set takes minutes, not the hours its first backup took.

## When that rule is fooled

The rule is fooled by a file that is rewritten to **exactly its old size** and then has its
**old modification time put back**. Some real ways that happens:

- **`touch -r`**, or any script or tool that copies timestamps from one file onto another.
- **Photo metadata edited in place with the timestamp kept**, e.g. `exiftool -P`. Most
  metadata edits change the file's size, which s3cab does notice. The miss is the edit that
  keeps the size the same.
- **VeraCrypt containers.** A container file has a fixed size, and VeraCrypt puts its
  modification time back after you use it by default ("Preserve modification timestamp of
  file containers"), so a container full of new files looks untouched.
- **Drives with coarse timestamps.** FAT32 records modification times to the nearest 2
  seconds, so a same-size edit made within 2 seconds of the last one can keep the same time.

When this happens, the backup keeps the **old contents** for that file and nothing warns you. A
restore then brings back the old version.

## Re-reading everything now and then

To catch anything the rule missed, run a backup that reads every file:

```
s3cab backup <set> --rehash
```

It takes as long to read your files as your first backup did, but it uploads only what really
changed. How often is up to you; more often if you use the tools above on files in the set.
(`s3cab snapshot <set> --rehash` does the same without uploading anything.)

## The change-time check

Besides a modification time, every file has a **change time**: the system sets it whenever the
file is written or its timestamps are set, and no program can put it back. If you add this line
to the set's env file (`~/.s3cab/sets/<set>/env`), s3cab also checks the change time before it
decides a file is unchanged:

```
S3CAB_CHECK_CHANGE_TIME=1
```

A file whose change time is later than the start of the previous backup is then read again,
however its size and modification time look. That catches every case above except FAT32,
which records no change time, so `--rehash` stays the only cure there.

It's off by default because it costs a lot in the wrong place:

- **Don't set it on a folder a cloud client syncs** (OneDrive, Dropbox, Google Drive). On those,
  merely reading a file moves its change time, so every backup reads the whole set again.
- **Expect one slow backup after restoring files onto this disk, or moving them to a new
  disk.** Both give every file a new change time, so that backup reads everything once. The
  backups after it are fast again.

## Dates Windows reads wrong

On Windows, a file whose modification time is **before 1970, or from 06:28:16 UTC on
7 February 2106 on**, is backed up with the wrong date. Node, which s3cab runs on, reads such a
time as a different one inside that range: a file dated 31 December 1969 is recorded as
7 February 2106, and one dated 2200 as 2064. The wrong date looks like a real one, so nothing
warns you, and a restore puts it on the file. The file's contents are backed up and restored
correctly; only its date is wrong. Linux and macOS read these times correctly. The fix waits
on [libuv](https://github.com/libuv/libuv/issues/3864), the library Node reads file times
through.

## Stopping part way

A first backup of a large set can take hours, mostly spent reading files. You don't have to
finish it in one sitting:

- **Press Ctrl+C whenever you like.** The file hashes worked out so far are saved, and files
  already uploaded stay uploaded, so the next `s3cab backup` carries on from there instead of
  starting over. Stop and restart as often as you want — each run gets further.
  (`s3cab snapshot` works the same way.)
- **If the run was killed outright** — the machine lost power, or the process was ended
  without a chance to tidy up — it leaves its work file behind, and the next run stops and
  says so. From the outside, that file looks exactly like a backup still running, so s3cab
  won't guess. Once you're sure nothing is running, run the same command again with
  `--resume` to carry on from the hashes the dead run had already worked out:

  ```
  s3cab backup <set> --resume
  ```

  The message also prints the command to delete the work file instead, if you'd rather read
  everything again from scratch. The lock the dead run held in the bucket usually needs
  nothing from you: the next run on the same system — Windows, or the same WSL distribution —
  can see the process is gone and removes it
  ([looking after a backup](maintenance.md#locks-backups-and-clean-ups-take-turns)).

Two work files can appear in the set's `snapshots/` directory while s3cab is working. Both
start with a dot, neither is ever uploaded, and both are safe to delete when nothing is
running. Neither ends with a snapshot's closing `.` line, so neither can pass for a finished
snapshot.

- `.snapshot.tsv.gz` — the snapshot being written right now, which becomes the finished
  snapshot when the run completes. One left behind is the work file of a run that was
  killed, which `--resume` carries on from.
- `.snapshot.lookup.tsv.gz` — the file hashes from a run you stopped with Ctrl+C, kept for
  the next run to reuse. Every hash in it is checked against the file's current size and
  modification time before it is trusted, and the file is deleted as soon as a snapshot
  completes.
