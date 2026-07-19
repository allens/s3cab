# Looking after a backup

Three commands keep a repository healthy over the years: **`verify`** checks your backups are
still restorable, **`forget`** removes a snapshot you no longer want, and **`cleanup`**
reclaims the storage that frees up. Alongside them sits the thing that makes all of it safe to
get wrong — **bucket versioning**.

You can ignore this page for a long time. Backups just accumulate, and that's fine. Come back
when you want to know they're sound, or when the bill starts to matter.

## Is my backup still good? (`verify`)

```console
> s3cab verify my-backups
my-backups: 3 sets, 48,210 objects checked — all verified ✓
```

`verify` reads every snapshot in the repository and confirms that each file it references is
actually stored, at the size recorded for it. It answers the only question that matters of a
backup you haven't needed yet: **if I asked for this back, would I get it?**

It's cheap and safe to run often:

- **No downloads.** It compares listings, so there's no egress and no bill to speak of — it
  never fetches your file contents.
- **Read-only.** It never writes to the bucket, and needs only list + read permission.
- **Scriptable.** It exits non-zero if any set has findings, so `s3cab verify my-backups ||
  alert` is the whole cron job.

The operand is the **bucket**, not a set — one repository checked per run — because the cost
is one listing of the whole store either way. Findings are still reported per set:

```console
> s3cab verify my-backups
my-backups: 3 sets, 48,210 objects checked — 1 set with findings ✗

  photos   2 files with problems
    C:\Users\me\Photos\beach.jpg    missing      (in 1 snapshot 2026-06-12T0915)
    C:\Users\me\Photos\report.pdf   wrong size   (recorded 245,760 bytes, stored 0)
```

Two kinds of finding:

| Finding        | Meaning                                                                     |
| -------------- | --------------------------------------------------------------------------- |
| **missing**    | a snapshot references content that isn't in the store — that file won't restore |
| **wrong size** | the content is stored, but not at the size recorded for it — it's damaged    |

A third line reports a snapshot that **couldn't be read** at all. That one matters beyond the
set it names: if s3cab can't read a snapshot, it doesn't know what that snapshot referenced —
which is why `cleanup` refuses to run at all until it's resolved (see below).

Findings are rare and mean something genuinely went wrong — a bucket edited by another tool,
a lifecycle rule that expired live objects, or storage damage. Versioning is what gets you out
of it: the previous version of the object is usually still there.

## Removing snapshots (`forget`)

A snapshot is a point in time. When you don't want to keep one any more:

```console
> s3cab forget --set photos 2026-05-01T0800
Orphan preview — what no snapshot would reference once these are gone:

  2026-05-01T0800   3,201 files   12.4GB
                  ───────────────────────
  total orphaned    3,201 files   12.4GB

Full list:
  C:\Users\me\.s3cab\forget-orphans-preview.txt
Forget snapshot '2026-05-01T0800' from set 'photos' (bucket my-backups)? This cannot be undone. [y/N]
Snapshot '2026-05-01T0800' forgotten from set 'photos'.
```

Before it asks, `forget` works out **what you'd be the last to hold** — content that, once
these snapshots are gone, nothing anywhere in the bucket still references. The counts go on
screen and the full list of files goes in a file, always, whose path is the last thing
printed. It's written before the question, so answering **no** still leaves you the list to
read — fix your selection and run again without waiting for the check twice.

Careful with what that list is, though: it's what would become **reclaimable**, not what's
about to be deleted. `forget` removes snapshots and nothing else, so every file on it stays
stored — and stays on your bill — until a `cleanup`.

Name as many as you like in one run — it's one question, not one per snapshot, and the
preview covers the whole selection:

```console
> s3cab forget --set photos 2026-05-01T0800 2026-05-08T0800 2026-05-15T0800
Orphan preview — what no snapshot would reference once these are gone:

  2026-05-01T0800             3,201 files   12.4GB
  2026-05-08T0800               118 files    412MB
  2026-05-15T0800                 0 files       0B
  shared across 3 snapshots     842 files    3.1GB
                              ───────────────────────
  total orphaned              4,161 files   15.9GB

Full list:
  C:\Users\me\.s3cab\forget-orphans-preview.txt
Forget 3 snapshots ('2026-05-01T0800', '2026-05-08T0800', '2026-05-15T0800') from set 'photos' (bucket my-backups)? This cannot be undone. [y/N]
3 snapshots forgotten from set 'photos'.
```

The **shared** line is content that more than one of the snapshots you named holds, and
nothing else does — it's only orphaned because they're all going together. Forget any one of
them alone and it stays referenced. That's why the check looks at the whole list at once
rather than one snapshot at a time.

Two things worth knowing about the numbers. They're **bucket-wide**: if another backup set
stores the same file, it isn't counted, because deleting this snapshot doesn't leave it
unreferenced. And **files and sizes don't scale together** — s3cab stores one copy of
identical content however many files point at it, so a thousand orphaned copies of one file
free the space of one.

Working the list out means reading every snapshot in the bucket, which takes a moment on a
large repository. That's the reason to name several snapshots in one run: it's one read for
the batch, not one per snapshot. If you don't want it — you know what you're deleting, or
you're in a script where nothing reads the output — **`--force`** skips the check and the
confirmation together:

```console
> s3cab forget --set photos 2026-05-01T0800 --force
```

### The two files it leaves behind

The preview above is `~/.s3cab/forget-orphans-preview.txt`, and it's replaced every time
you run a check — it's there to help you answer the question in front of you, and it's of no
use once you have.

Once you say **yes**, though, s3cab also keeps a permanent copy in the set's own folder:

```
~/.s3cab/sets/photos/forget-orphans-2026-05-01T080213.txt
```

That one is a record of what you forgot and what it cost you, and it isn't overwritten or
tidied up — it's there for the day you wonder where a file went. They're small text files;
delete them yourself whenever you like. A `--force` run keeps a record too, saying plainly
that the check was skipped, so a bypass never leaves a silent gap.

`forget` removes only the snapshots themselves — **the files they referenced stay stored**. That's
deliberate: other snapshots probably reference the same content, and working out what's now
unreferenced is a whole-repository question. Reclaiming it is `cleanup`'s job, which `forget`
reminds you of when it finishes. The preview tells you what *would* be reclaimable; `cleanup`
is what actually frees it.

It asks first, at a terminal, naming exactly what it's about to remove. In a script (no
terminal) it proceeds — naming the snapshots is explicit enough, and blocking a script on a
prompt would be worse. Like `restore`, it always takes `--set`: a destructive command
should never guess its target. Every name is checked against what's really backed up
**before anything is removed**, so a typo is an error listing the real ones — never a
half-finished run that already removed the names before it.

Local snapshots need no command at all — the files are the API. Delete the file.

## Reclaiming storage (`cleanup`)

Forgetting snapshots doesn't free space by itself. Once nothing references a piece of content,
it becomes an **orphan** — still stored, paid for, pointed at by nothing. `cleanup` finds
them:

```console
> s3cab cleanup my-backups
my-backups: 48,210 objects stored, 312 orphaned (1.4 GB reclaimable)
Dry run — nothing deleted. Reclaim with: s3cab cleanup my-backups --delete
```

**It's a dry run by default.** It tells you what it would remove and removes nothing. Add
`--delete` to actually reclaim, which asks for confirmation at a terminal:

```console
> s3cab cleanup my-backups --delete
Delete 312 orphaned object(s) (1.4 GB) from bucket 'my-backups'? This cannot be undone. [y/N]
```

Orphans come from exactly two places: snapshots you forgot, and backups that crashed
part-way (uploads that landed before the run stopped). Both are harmless — they only cost
storage.

### The safety rules

`cleanup` is the only command that removes file content, so it's hedged:

- **Recent objects are never touched.** Any object younger than **7 days** is left alone, even
  if nothing references it. A backup uploads content *before* the snapshot that references it,
  so a young unreferenced object may belong to a backup that's running right now. The window
  is fixed — there's no flag to shorten it, because that's a foot-gun that buys nothing.
- **An unreadable snapshot stops the run** — both modes, even the dry run. If a snapshot won't
  read, its references are unknown, so everything it alone referenced would *look* orphaned.
  Rather than report numbers that are lies, `cleanup` stops and sends you to `verify`.
- **Missing objects make `--delete` refuse.** If verify-style faults are already present, the
  repository is losing data and this is not the moment to reclaim. The dry run still reports.
- **Don't run cleanup while a backup is running.** The grace window covers the ordinary race,
  but this is the one rule it can't enforce for you.

Everything it deletes is an orphan — content some live snapshot needs is never a candidate, so
`cleanup` cannot break a restorable backup.

## Versioning: why any of this is safe

**Turn on bucket versioning.** `s3cab aws` does it for you; if you made the bucket by hand,
do it yourself. It is the single thing that converts every mistake on this page from permanent
to recoverable.

With versioning on, both `forget` and `cleanup --delete` issue **soft** deletes: S3 writes a
delete marker and the bytes live on as a noncurrent version. So a `cleanup --delete` you
regret, a snapshot you shouldn't have dropped — even a leaked key used maliciously — can be
recovered. The least-privilege identity `s3cab aws` generates is deliberately allowed to
delete objects but **not** object *versions*, which means a stolen credential can add to your
backup and can never permanently destroy its history.

The trade-off is that **reclaimed space doesn't free immediately**. Those noncurrent versions
are still stored until a lifecycle rule expires them — 90 days in the generated template.
That deferral *is* the safety net, not a bug: it's your window to notice and undo. If you
reclaim a large amount and watch the bill, expect it to drop when the window elapses, not
today. [The cloud-bucket guide](aws.md) covers the full model, including how to change the
window.

## A routine, if you want one

There's no wrong answer, and none of this is required. A reasonable rhythm:

| When            | Do                                    | Why                                        |
| --------------- | ------------------------------------- | ------------------------------------------ |
| Every backup    | nothing                               | `backup` is the whole job                  |
| Occasionally    | `s3cab verify <bucket>`               | confirm it would actually restore          |
| When space matters | `s3cab forget` old snapshots (several at once), then `s3cab cleanup <bucket> --delete` | drop what you don't want, then reclaim it |

Automatic retention rules — keep-last, daily/weekly/monthly — aren't built yet. They'll be
built on top of `forget` and `cleanup` once real usage shows the shapes people actually want.
Until then, retention is you deciding which snapshots to drop.
