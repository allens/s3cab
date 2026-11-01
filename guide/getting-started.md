# Getting started

A first run through s3cab, end to end, on a folder that doesn't matter. By the end you will
have:

- created a **backup set** over a small folder and backed it up;
- deleted a file and got it back from the backup;
- changed a few files, backed up again, and seen exactly what changed;
- met `list` and `status`, the two commands that tell you what you have.

Nothing here removes anything from your backup. Each step says what happened and why, in a
few lines, and links the guide that goes deeper.

**You need two things first.** s3cab installed ([Installing &
running](../README.md#installing--running)), and a bucket with an access key to reach it. On
AWS, `s3cab aws my-backups` prints a ready-to-deploy recipe for both — the walkthrough is
[Setting up a cloud bucket](aws.md). For Cloudflare R2, Backblaze B2, Wasabi and the like,
run `s3cab help provider`: you'll add `--endpoint` and `--region` to the first command below,
and everything else reads the same.

**Try it on a copy first.** Copy a few hundred photos, or any folder of files you have
elsewhere, to somewhere like `C:\Users\me\Photos`, and use that. s3cab never changes the
files it backs up, but a trial on a copy means you can delete a file in step 3 without a
second thought, and throw the whole thing away afterwards. The page follows one example
folder, 212 photos with a `beach.jpg` among them: where it names a file, use one of yours,
and expect your own counts and sizes in the reports. The pages use Windows paths; on macOS or
Linux, write yours the way your system does.

## 1. Create a backup set

A backup set is a name, the folders it covers, and the bucket it backs up to. This one is
called `photos`:

```console
> s3cab setup --set photos --bucket my-backups --keys C:\Users\me\Photos
Access key ID: AKIAIOSFODNN7EXAMPLE
Secret access key (hidden):
Contacting the cloud…
Wrote a starter exclude file — these patterns are skipped by default:
  **\node_modules\
  **\.git\
  **\.DS_Store
  **\Thumbs.db
  **\._*
  **\desktop.ini
  $RECYCLE.BIN\
  System Volume Information\
Edit C:\Users\me\.s3cab\sets\photos\exclude.txt to change what's skipped — see 's3cab help exclude'.
Set 'photos' → bucket 'my-backups'
dirs (C:\Users\me\.s3cab\sets\photos\dirs.txt):
  C:\Users\me\Photos
```

What happened:

- **`--keys` asked for the access key and secret at the prompt**, never on the command line,
  where they would land in your shell history. They are saved on the set, in a file only you
  can read. If you'd rather point the set at a profile in your AWS config, or you have a
  non-AWS provider, [Signing in to your storage](auth.md) has every option.
- **s3cab claimed the name `photos` in the bucket**, so no other machine can create a set with
  that name there. That is the one thing a set has: its name.
- **The set lives in a few small text files** under `C:\Users\me\.s3cab\sets\photos\`:
  `dirs.txt` lists its folders (one per line — add a folder by adding a line), `exclude.txt`
  lists the patterns it skips, `env` holds the bucket and the key, and `claim` records that
  this machine holds the set. Its snapshots will go in `snapshots\` beside them. To change
  what the set backs up, edit those files; to change how it signs in, use `s3cab provider`.
- **The starter exclude file** skips things nobody wants backed up — dependency folders, `.git`
  repositories, the operating system's own clutter — and says so, so nothing is skipped behind
  your back. [Exclude rules](exclude.md) explains the patterns; `s3cab tree --excluded` shows
  what they are leaving out of this set.

## 2. Back it up

With one set, you can leave its name out of most commands. While it runs, s3cab prints what
it's doing — which folder it's reading, how far the upload has got — and then this report:

```console
> s3cab backup
Contacting the cloud…
Backed up 'photos' → snapshot 20251112T0915
Scanned 212 files (1.1GB) in 6s
Uploaded 212 objects (1.1GB) in 2m 16s

First backup — every file is new.
```

What happened:

- **s3cab took a snapshot**: a list of every file in the set, with its size, its modification
  time and a fingerprint of its contents (a SHA-256 hash). The snapshot is named for the
  moment it was taken, `20251112T0915` — 12 November 2025 at 09:15, in your local time — and
  that name is how you'll refer to it from now on.
- **Each file was uploaded once, stored under its fingerprint.** Two files with the same
  contents, anywhere in the bucket — in this set or another — are stored once. That is why
  the report counts *objects* uploaded as well as *files* scanned: on this first run they are
  the same.
- **The snapshot went up last**, after every file it lists. Any snapshot you can see in the
  bucket is complete.

A first backup takes as long as reading every file. The next ones are quick: a file whose size
and modification time haven't changed isn't read again. You can stop a long first backup with
Ctrl+C and pick it up later — [Backing up](backup.md#stopping-part-way) explains how it
carries on from where it left off, and
[how it spots an unchanged file](backup.md#how-s3cab-spots-an-unchanged-file).

## 3. Delete a file, get it back

This is the everyday job the backup exists for. Delete `beach.jpg` from the folder — move it
elsewhere, or delete it and empty the recycle bin — then ask for it back:

```console
> s3cab restore --set photos C:\Users\me\Photos\beach.jpg
Contacting the cloud…
Restored 1 file from 'photos' (snapshot 20251112T0915).
```

The file is back where it was, byte for byte, with its original modification time. What to
know:

- **`restore` always names its set** (`--set photos`), even when you have only one. It writes
  into your folders, so it never guesses which backup to write from.
- **You name the file as the backup spells it**: the full path. Copy it out of
  `s3cab find beach.jpg`, which searches the snapshots and prints it, rather than typing it.
  A folder works too, and restores everything under it.
- **Files that still exist are left alone.** Restore a whole folder and only the missing files
  come back; everything you've changed since stays as it is. Add `--overwrite` when you really
  want the backup's copy to win ([Existing files are never
  touched](restore.md#existing-files-are-never-touched)).
- **An older version** is one flag away: `--snapshot <name>` restores from that snapshot
  instead of the latest ([Choosing which version](restore.md#choosing-which-version)). To
  look at an old copy beside the current one rather than replace it, `extract` puts it in the
  current folder under its own name ([Copying one item out](restore.md#copying-one-item-out)).
- **Every byte is checked.** A restored file's fingerprint must match the one the snapshot
  recorded, or nothing is written ([What restore
  guarantees](restore.md#what-restore-guarantees)).

[Getting files back](restore.md) covers the rest, including a whole set onto a new machine.

## 4. Change something, back up again

Make two changes. Move `2024\IMG_001.jpg` into a new subfolder, `2024\sorted`, and copy a new
photo in as `2025\new.jpg`. Then back up again:

```console
> s3cab backup
Contacting the cloud…
Backed up 'photos' → snapshot 20251113T0902
Scanned 213 files (1.1GB) in 1s — 2 needed re-hashing (7.5MB)
Uploaded 1 object (4.1MB) in 2s

Changes since 20251112T0915:
  Added     1
  Modified  0
  Deleted   0
  Moved     1

To see the details:
  s3cab compare photos --since 20251112T0915 --until 20251113T0902
Compare now? [y/N] y
photos: ~\Photos  20251112T0915 → 20251113T0902

Added (1)
  2025\new.jpg

Moved (1)
  2024\IMG_001.jpg → 2024\sorted\IMG_001.jpg

1 added, 0 renamed, 1 moved, 0 modified, 0 deleted · 4.1MB changed
```

What happened:

- **Two files were read, and one uploaded.** The 211 files still at their old paths kept the
  fingerprints from the first snapshot. The new photo and the moved one were read, because a
  fingerprint is looked up by path and the moved one sits at a new path — but only the new
  photo was new content.
- **The moved photo is reported as moved**, not as one file deleted and another added. Its
  fingerprint is the one the first snapshot recorded, so s3cab knows it is the same file — and
  it cost nothing to upload, because that content was already in the bucket.
- **The report counts; `compare` lists.** A backup that found changes ends with the counts
  and the command that shows the detail. At a terminal it offers to run it for you, which is
  what `y` did above. You can run it yourself at any time —
  `s3cab compare photos --since 20251112T0915` compares that snapshot with the latest — and
  [Reading a compare report](compare.md) explains each section.

## 5. What you have: `list` and `status`

`list` shows your sets and their snapshots, newest first. It reads this machine's own copies,
so it works offline:

```console
> s3cab list
photos:
  20251113T0902
  20251112T0915
```

Name a set and it shows the files that define it — the ones you edit to change what it backs
up — before the snapshots:

```console
> s3cab list photos
name: photos
bucket: my-backups
provider overrides:
  access keys: set (…MPLE)
dirs (C:\Users\me\.s3cab\sets\photos\dirs.txt):
  C:\Users\me\Photos
exclude file: C:\Users\me\.s3cab\sets\photos\exclude.txt
snapshots:
  20251113T0902
  20251112T0915
```

Add `--remote` to list the snapshots in the bucket instead (`s3cab list photos --remote`),
which is what a restore reads from. The two lists match after every finished backup.

`status` asks the bucket one question: is the latest snapshot backed up, and if not, how much
would a backup send?

```console
> s3cab status
Contacting the cloud…
photos
  latest snapshot   20251113T0902
  backed up         20251113T0902
  up to date
```

It compares snapshots, not your disk, so a file you edited a minute ago isn't counted until the
next `backup` (or `snapshot`, which records the files without uploading anything) takes a
snapshot of it.

## Where next

- **Point it at your real files.** The name `photos` is now taken in the bucket, for good: a
  set's name is claimed when it is created and nothing gives it back. So either keep this
  set and swap the trial folder for the real one in its `dirs.txt`, or create a set under a
  new name with `setup`, the same command as step 1 with your folders. One set per thing you
  think of as a unit — your photos, your documents — all in the same bucket.
- **Back up on a schedule.** `s3cab backup photos` is the whole job; run it from Task
  Scheduler, cron or launchd. It exits non-zero when something couldn't be backed up, so a
  scheduler can tell ([Output formats](output.md) lists the codes).
- **Check it now and then.** `s3cab verify my-backups` confirms every file your snapshots
  mention is really there, without downloading anything
  ([Is my backup still good?](maintenance.md#is-my-backup-still-good-verify)).
- **When you're done with the trial set**, [Looking after a backup](maintenance.md) covers
  removing its snapshots from the bucket and reclaiming the space they held. Its local files
  are just files: delete `C:\Users\me\.s3cab\sets\photos\` and the set is gone from this
  machine.
- **Something specific?** The [guides](README.md) open with a list by situation.
