# Backing up

`s3cab backup <set>` is the whole routine job. This page covers the two things about it you
might need to act on: how s3cab decides a file hasn't changed (and the rare edits that fool
it), and what happens when a backup stops part way.

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
  everything again from scratch.

(The work file itself is described in the [format spec](format.md#the-local-side-s3cab).)
