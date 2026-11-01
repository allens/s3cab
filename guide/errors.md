# Error messages

When s3cab can't do what you asked, it stops and prints `ERROR:` followed by what went wrong
and how to fix it. This page covers the errors you're most likely to meet. Each heading is the
first line of one of them, spelled the way s3cab prints it, with `…` where it names your set,
bucket, path or a count. Search this page for the first line of yours, or paste it into the
search at https://s3cab.plantegral.com/guide/errors.

The message already gives the fix. An entry here adds why it happens, what else might be going
on, and where to read more.

Problems with what's stored in the bucket aren't errors: `verify` and `restore` list them in
their report and carry on. [Is my backup still good?](maintenance.md#is-my-backup-still-good-verify)
and [If some content is missing](restore.md#if-some-content-is-missing-from-the-backup) explain
those.

## Signing in and reaching the bucket

### No credentials found for set '…'.

The set needed the bucket and s3cab found nothing to sign in with, either in the set's own
settings or in your standard AWS setup. The message says where it looked and, when it can
tell, the exact cause. See
[s3cab can't find any credentials](auth.md#s3cab-cant-find-any-credentials).

### No AWS credentials found.

The same, for a command that runs before there is a set to hold credentials: `setup`,
`reattach`, and `upload --bucket`. These use your ambient AWS setup, so `s3cab provider` can't
help yet. Set up an AWS profile or export the `AWS_*` variables, then run the command again.
[Where s3cab looks](auth.md#where-s3cab-looks) lists the places.

### Your AWS credentials … have expired.

Your sign-in worked before and has run out. Nothing needs changing: sign in again and re-run
the command. See [your sign-in has expired](auth.md#your-sign-in-has-expired).

### You're signed in, but you don't have permission to use …

The bucket accepted your sign-in but not the request. The message says which identity s3cab
signed in as, and that is the first thing to check: with no profile set, AWS falls back to your
`default` one, which is often not the identity meant for backups. If it's the wrong one, point
the set at the right profile with `s3cab provider --profile <name> photos`. If it's the right
one, its policy is missing a permission. See
[the server rejects your credentials](auth.md#the-server-rejects-your-credentials) and
[the security model](aws.md#the-security-model).

### Your credentials were rejected as invalid.

The server doesn't recognise the key, or the session token is wrong or incomplete. Re-enter
the keys with `s3cab provider --keys photos`, or renew the profile or sign-in they came from.
See [the server rejects your credentials](auth.md#the-server-rejects-your-credentials).

### Your credentials couldn't be verified (signature mismatch).

The request was signed, but not the way the server expected. Usually the secret is wrong or
cut short, or, on a non-AWS provider, the endpoint or region doesn't match the bucket. Check
those before the secret. See
[the server rejects your credentials](auth.md#the-server-rejects-your-credentials).

### Your computer's clock is too far out of sync.

S3 refuses requests stamped too far from its own time. Sync your system clock and run the
command again.

### The cloud refused to answer a question about …, and didn't say why (…).

Some requests get a reply with no body, so a refusal arrives without the code that would say
why. s3cab can't tell a missing permission from a bad key here, so it lists the likely causes,
missing permission first. Running a command that reads, such as `s3cab list photos --remote`,
usually gets a refusal with its reason in it. See
[the server rejects your credentials](auth.md#the-server-rejects-your-credentials).

### Couldn't reach the cloud — the request didn't get through.

No reply came back at all. That's the connection, not your bucket or credentials: a dropped
Wi-Fi, a VPN coming up, a laptop waking from sleep, or an endpoint name that doesn't resolve.
Run the command again: whatever was already uploaded is skipped. If it fails straight away
every time, check the set's endpoint with `s3cab provider photos`
([checking what's set](auth.md#checking-whats-set)).

### Set up the keyless Roles Anywhere identity before pointing a set at it.

`s3cab provider --roles-anywhere` needs the certificate identity this machine signs in with,
and it doesn't exist yet. The message prints the steps that create it. See
[Roles Anywhere](aws.md#--roles-anywhere--keyless-certificate-based-access).

### The Roles Anywhere identity at … is incomplete (missing …).

Some of the identity's files are gone. s3cab won't make new ones by itself, because a new
certificate authority would no longer match the trust anchor you deployed. Remove the
directory, as the message shows, and set the identity up again. See
[Roles Anywhere](aws.md#--roles-anywhere--keyless-certificate-based-access).

### Set one way to sign in, not … — they are alternatives, not layers.

`s3cab provider` was given two ways to sign in at once, say `--profile` and `--keys`. A set
uses one. Run it again with just the one you mean; it replaces whatever the set used before.
See [the four ways a set signs in](auth.md#the-four-ways-a-set-signs-in).

### Give the endpoint as a full URL

`--endpoint` takes the address with its scheme, such as `https://`, as your provider shows it.
See [non-AWS providers](aws.md#non-aws-providers).

### Both an access key ID and a secret are needed

`s3cab provider --keys` asks for two things and got one. When you pipe the keys in, send the
ID and the secret as two lines.

## Backup sets

### Unknown backup set: …

There is no set by that name on this machine. The message lists the ones there are. A set made
on another machine has to be attached here first: `s3cab reattach photos --bucket my-backups`.

### No backup sets yet.

This machine has no sets, so there is nothing for the command to work on. Create one with
`setup`, as the message shows, or attach an existing one with `reattach`. The
[quick start](../README.md#quick-start) walks through it.

### Several backup sets exist — name one:

The command can pick the set by itself only when there is exactly one. Name the set, from the
list the message prints.

### Invalid set name: …

Set names use lowercase letters, digits and hyphens only. The message suggests a name that
fits.

### Backup set '…' already exists on this machine.

`setup` makes new sets and doesn't change old ones. To change what a set backs up, edit its
`dirs.txt` and `exclude.txt`, which the message names. To back up something else, make a new
set with another name. See [what a set backs up](backup.md#what-a-set-backs-up).

### Backup set '…' already exists in bucket '…'

The bucket already has a set with that name, made from this machine or another. If it's yours,
attach it with `reattach`, as the message shows. If it's a different set, pick another name.

### No backup set '…' in bucket '…'.

`reattach` found no set with that name in the bucket. The message lists the sets it does hold;
check the spelling, and that you named the right bucket.

### Set '…' isn't on this machine yet: name the bucket holding it

`reattach` needs `--bucket` the first time, to know where to find the set:
`s3cab reattach photos --bucket my-backups`. After that the set remembers its bucket.

### Set '…' on this machine is attached from bucket '…', not '…'.

The set is already attached here, from a different bucket. To refresh it from its own bucket,
leave out `--bucket`.

### Backup set '…' has no bucket to back up to (no S3CAB_BUCKET in …).

The set's `env` file has lost its `S3CAB_BUCKET` line, usually through a hand edit. Put the
line back, or remove the set's directory and run `setup` again, as the message shows.

### No bucket name given.

`--bucket` was given an empty value, as an unset shell variable does.

### Invalid bucket name: …

A bucket is named by its name alone: not an `s3://` URL, a path or a prefix. The line under the
heading says which rule the name broke. `s3cab aws` also refuses dots and very long names,
because it names AWS resources after the bucket.

### Directory not found: …

`setup` checks each directory before it creates anything. Check the spelling, or connect the
drive the directory is on.

### Not a directory: …

A set backs up directories, and this is a file. Name the directory it's in.

## Who holds a set

### Backup set '…' … This machine can't back it up or forget its snapshots, only list and restore it.

Only one machine at a time backs up a set: its holder. Any other machine with the set attached
can list it and restore from it, but its backups and forgets are refused. The middle of the
line says why this machine isn't the holder: the set "is held by …, not this machine", "has
been taken over by …" when another machine took it from this one, or "has no holder in its
bucket" or "no longer has a holder in its bucket" when nothing holds it. To make this machine
the holder, run `s3cab takeover photos`. See
[restoring onto a fresh machine](restore.md#restoring-onto-a-fresh-machine) and
[who holds a set](format.md#who-holds-a-set).

### Another machine claimed '…' while this one was taking it over.

Two machines ran `takeover` on the same set at the same moment, and the other won. Run
`takeover` again if this machine should hold it.

## Backing up

### Backup set '…' has no directories to back up.

The set's `dirs.txt` lists no directories. Add one full path per line to the file the message
names. See [what a set backs up](backup.md#what-a-set-backs-up).

### These directories in backup set '…' aren't available:

A directory in `dirs.txt` is missing or can't be read: an unplugged drive, or a folder that was
renamed or deleted. The backup doesn't run at all rather than quietly back up less than you
asked for. Reconnect the drive, or edit `dirs.txt`.

### These entries in backup set '…' aren't full paths to folders on this computer:

Every line of `dirs.txt` has to be a full path. A set first made on another kind of computer
reads this way too: `C:\Users\me\Photos` isn't a full path on Linux. To get files from such a
backup, restore with `--output`, as the message shows. See
[restoring somewhere else](restore.md#restoring-somewhere-else).

### File found under more than one of the set's directories: …

One of the set's directories is inside another, so its files would be backed up twice. Remove
the inner one from `dirs.txt`, or exclude it from the outer one. See
[what a set backs up](backup.md#what-a-set-backs-up).

### Can't back up '…': the folder is there, but this computer won't say where it really is

The folder exists, but the system can't give its real path. s3cab records every file under its
folder's real path, so it can't back this one up. This is usually a protected vault, such as
OneDrive's Personal Vault, or a drive with no letter or mount point. `setup` refuses such a
folder the same way, as "Can't add '…' to backup set '…'". Back up a folder with an ordinary
path instead.

### … be backed up, because the name can't be written into a snapshot:

It opens "This file can't" or "These … files can't". A snapshot is text with one line per file
and tabs between its columns, so it can't hold a file name with a tab or a line break in it,
or one that isn't valid Unicode. Rename the files, or keep them out with an exclude pattern.
See [the format spec](format.md#no-row-holds-a-tab-or-a-line-ending).

### Can't use the set's exclude file, because … a tab or a carriage return (…):

A pattern in `exclude.txt` has a tab or a carriage return in it, which a snapshot can't record.
Write `?` in place of each, as the message shows; it still matches it. See
[exclude rules](exclude.md).

### A snapshot of this set is already in progress — or a previous one was interrupted and left its work file behind.

Either a snapshot, backup or upload of this set is running right now, or one was killed without
a chance to tidy up. s3cab can't tell which. Once you're sure nothing is running, run the same
command again with `--resume` to carry on from the file hashes already worked out. To start
over instead, delete the work file the message names. See
[stopping part way](backup.md#stopping-part-way).

### Couldn't finish backing up — sending your files to the cloud stopped part-way (…).

The snapshot of this computer was made, but uploading stopped; the reason is in the brackets.
Fix that first, then carry on with the `upload` command the message prints. Files already sent
aren't sent again.

### Couldn't back up '…' — …

The file changed, disappeared, or stopped being readable between being read and being
uploaded, so s3cab left it out rather than store something it can't vouch for. The rest of the
message says which: "it changed while the backup was running", "it was removed while the
backup was running", or "it could no longer be read while the backup was running". Run the
backup again. A file that does this every time, such as a live database, is better excluded.
See [files that change during a backup](exclude.md#files-that-change-during-a-backup).

### Couldn't record this backup as '…': the name was already taken when we wrote it (…).

Snapshot names are the time to the minute, so another machine backing up the same set can take
one first. Copied state can do it too, such as a cloned virtual machine or a restored
`~/.s3cab`. Your files were uploaded; only this backup's record wasn't written. Run the backup
again to record it under the next minute's name.

### Snapshot '…' already exists in '…'.

A snapshot of this set was already taken this minute, and s3cab won't overwrite it. Wait for
the next minute and run it again.

## Locks

### Can't … right now — a backup or upload is running on bucket '…'

A `cleanup` or `delete` won't run while a backup or upload holds a lock in the bucket. Try again
later, or add `--wait`. If the lock was left by a run that died, remove it with `unlock`. See
[locks](maintenance.md#locks-backups-and-clean-ups-take-turns).

### Can't … right now — a cleanup or delete is running on bucket '…'

A backup or upload won't run while a `cleanup` or `delete` holds a lock in the bucket. A
scheduled backup simply fails, and the next one tries again. See
[locks](maintenance.md#locks-backups-and-clean-ups-take-turns).

### Removing a lock needs a confirmation, and there is no terminal to ask on.

`unlock` asks before it removes a lock, and nothing can answer in a script. List the locks with
`--dry-run`, then name the ones to remove and add `--force`. See
[locks](maintenance.md#locks-backups-and-clean-ups-take-turns).

### --force removes locks without showing them first, so it needs their ids.

`unlock --force` only removes locks you name, so nothing removes a lock nobody looked at. List
them with `s3cab unlock --bucket my-backups`, then name the ids.

## Snapshots on this computer

### Snapshot '…' not found in '…'.

The command was given a snapshot name this machine doesn't have. The message lists the ones it
has, newest first. To see what's in the bucket, use `s3cab list photos --remote`.

### No snapshots to compare yet for set '…'.

`compare` needs at least one snapshot on this machine. Take one with `snapshot`, or run a
`backup`. See [reading a compare report](compare.md).

### No snapshot yet for set '…'.

`status` works from the set's last snapshot, and there isn't one yet. Take one with `snapshot`,
or run a `backup`.

## Getting files back

### No backups for set '…'.

The set exists here but has never been backed up, so there is nothing in the bucket to restore.
See [if there's nothing to restore](restore.md#if-theres-nothing-to-restore).

### Snapshot '…' not found for set '…'.

There is no backed-up snapshot by that name. The message lists the real ones. See
[choosing which version](restore.md#choosing-which-version).

### No files in snapshot '…' matched:

None of the paths you named are in the snapshot. A path has to be the full path the snapshot
recorded. `find` shows how the backup spells it, as the message suggests. See
[choosing what to restore](restore.md#choosing-what-to-restore).

### Name what to restore from set '…': files or folders, a list of them, or --all for everything.

`restore` given only a set restores nothing, so a forgotten path can never restore everything.
Name what you want, or add `--all`. See
[choosing what to restore](restore.md#choosing-what-to-restore).

### --all restores the whole snapshot, so it takes no paths and no --from-file.

Drop either `--all` or the paths.

### No paths to restore: … lists none.

The `--from-file` list holds no paths: it's empty, or every line is blank or a `#` comment.

### Can't read the paths to restore — there is no file '…' (--from-file).

Check the file name. The set's own `dirs.txt`, which the message names, works as a list too.

### --from-file - reads the paths to restore from a pipe, and nothing is piped in.

`--from-file -` reads the list from another command's output. Pipe one in, or name a file.

### Snapshot '…' has … that aren't absolute on this system

The backup was made on another kind of computer, so its paths can't go back where they came
from here. The same message reads "that isn't absolute" for a single path. Restore under a
folder you choose with `--output`:
`s3cab restore --set photos --all --output D:\recovered`. See
[restoring somewhere else](restore.md#restoring-somewhere-else).

### Extracting '…' would replace '…', which is already there.

`extract` never writes over something by mistake. Give the copy another name with `--name`,
put it in another folder with `--output`, or add `--overwrite`. See
[copying one item out](restore.md#copying-one-item-out).

### '…' isn't a full path: name the file or folder as it was backed up, from its root.

`extract` takes the full path the snapshot recorded. Copy it from `s3cab list photos` or
`s3cab tree photos`.

### extract copies one file or folder per run: run it once for each.

For several items, run `extract` once for each, or use `restore --output`.

## Forgetting, deleting and cleaning up

### Forgetting snapshots from set '…' needs a confirmation, and there is no terminal to ask on.

`forget` asks before it removes anything, and nothing can answer in a script. Add `--force`.
See [removing snapshots](maintenance.md#removing-snapshots-forget).

### Snapshot '…' is not backed up for set '…'.

A name you gave `forget` isn't a backed-up snapshot of this set. Nothing was removed. The
message lists the real ones, and says "Snapshots … are" when it's more than one.

### delete takes content hashes (64 hex characters), and these aren't:

`delete` takes the content hashes `find` writes, not paths or names. It reads "and this isn't
one" for a single entry. Search with `find`, check the list, and pass it with `--from-file`.
See [deleting files from every backup](maintenance.md#deleting-files-from-every-backup-delete).

### Can't read the hash list — there is no file '…' (--from-file).

Write the list with `find` first, as the message shows.

### No hashes to delete — '…' has none in column one.

The list has no hashes: it's empty, or every line is a comment. `find` writes each hash at the
start of its line.

### Refusing to delete … — that is the empty file's hash

Every empty file in every backup shares that one object, so `delete` won't take it. Remove it
from the list and run again.

### Deleting backed-up content needs a confirmation, and there is no terminal to ask on.

`delete` asks you to type the bucket name, and nothing can answer in a script. Preview it with
`--dry-run`, then add `--force`.

### Reclaiming storage deletes objects, and there is no terminal to confirm on.

`cleanup` asks before it deletes, and nothing can answer in a script. Preview it with
`--dry-run`, then add `--force`. See [reclaiming storage](maintenance.md#reclaiming-storage-cleanup).

### Refusing to delete: the repository is missing … — it is already losing data, so this is not the moment to reclaim.

Some content your snapshots need is already gone from the bucket, so `cleanup` won't delete
anything more. Run `verify` to see what is missing. See
[the safety rules](maintenance.md#the-safety-rules).

## Using a command

### Missing required argument: …

The command needs that argument, and the message says what it's for. `--help` after the
command shows them all.
