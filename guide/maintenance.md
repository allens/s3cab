# Looking after a backup

Three commands keep a repository healthy over the years: **`verify`** checks your backups are
still restorable, **`delete`** removes a snapshot you no longer want, and **`cleanup`**
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

## Removing a snapshot (`delete`)

A snapshot is a point in time. When you don't want to keep one any more:

```console
> s3cab delete photos --snapshot 2026-05-01T0800
Delete snapshot '2026-05-01T0800' from set 'photos' (bucket my-backups)? This cannot be undone. [y/N]
Snapshot '2026-05-01T0800' deleted from set 'photos'.
```

`delete` removes only the snapshot itself — **the files it referenced stay stored**. That's
deliberate: other snapshots probably reference the same content, and working out what's now
unreferenced is a whole-repository question. Reclaiming it is `cleanup`'s job, which `delete`
reminds you of when it finishes.

It asks first, at a terminal, naming exactly what it's about to remove. In a script (no
terminal) it proceeds — naming `--snapshot` is explicit enough, and blocking a script on a
prompt would be worse. Like `restore`, it always takes the set name: a destructive command
should never guess its target. A snapshot name that doesn't exist is an error listing the real
ones, so a typo can't quietly do nothing.

Local snapshots need no command at all — the files are the API. Delete the file.

## Reclaiming storage (`cleanup`)

Deleting snapshots doesn't free space by itself. Once nothing references a piece of content,
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

Orphans come from exactly two places: snapshots you deleted, and backups that crashed
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

With versioning on, both `delete` and `cleanup --delete` issue **soft** deletes: S3 writes a
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
| When space matters | `s3cab delete` old snapshots, then `s3cab cleanup <bucket> --delete` | drop what you don't want, then reclaim it |

Automatic retention rules — keep-last, daily/weekly/monthly — aren't built yet. They'll be
built on top of `delete` and `cleanup` once real usage shows the shapes people actually want.
Until then, retention is you deciding which snapshots to drop.
