# Looking after a backup

Four commands keep a repository healthy over the years: **`verify`** checks your backups are
still restorable, **`forget`** removes a snapshot you no longer want, **`delete`** removes a
file or folder you no longer want from *every* backup, and **`cleanup`** reclaims the
storage that frees up. Alongside them sits the thing that makes all of it safe to get wrong
— **bucket versioning**.

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
    C:\Users\me\Photos\beach.jpg    missing      (in snapshot 2026-06-12T0915)
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

One absence is *not* a finding: files you removed with `delete` (below). Those are reported
separately, with the date they were deleted, and don't affect the exit code — a decision you
made on purpose shouldn't ring the alarm forever:

```console
> s3cab verify my-backups
my-backups: 3 sets, 47,913 objects checked — all verified ✓

  photos   312 files deleted from backups (s3cab delete — deleted 2026-07-19; expected, not damage)
```

## Removing snapshots (`forget`)

A snapshot is a point in time. When you don't want to keep one any more:

```console
> s3cab forget --set photos 2026-05-01T0800
Unrestorable preview — what you could no longer restore once these are gone:

  snapshot            files    size
  2026-05-01T0800     3,201  12.4GB
                      ─────────────
  total unrestorable  3,201  12.4GB

Full list:
  C:\Users\me\.s3cab\forget-unrestorable-preview.txt
Forget snapshot '2026-05-01T0800' from set 'photos' (bucket my-backups)? This cannot be undone. [y/N] y
Forgetting removes snapshots, not the objects they point at; reclaim unreferenced ones with:
  s3cab cleanup my-backups
Record of this removal:
  C:\Users\me\.s3cab\sets\photos\forget-unrestorable-2026-05-01T080213.txt
Snapshot '2026-05-01T0800' forgotten from set 'photos'.
```

Before it asks, `forget` works out **what you'd be the last to hold** — files that, once
these snapshots are gone, no surviving snapshot anywhere in the bucket holds, so `restore`
could never produce them again. That's what **unrestorable** means here. The counts go on
screen and the full list of files goes in a file, always, whose path is the last line before
the question. It's written first, so answering **no** still leaves you the list to read — fix
your selection and run again without waiting for the check twice.

Careful with what that list is, though: it's what you could no longer *restore* — and so
what becomes **reclaimable** — not what's about to be deleted. `forget` removes snapshots and nothing else, so every file on it stays
stored — and stays on your bill — until a `cleanup`.

Name as many as you like in one run — it's one question, not one per snapshot, and the
preview covers the whole selection:

```console
> s3cab forget --set photos 2026-05-01T0800 2026-05-08T0800 2026-05-15T0800
Unrestorable preview — what you could no longer restore once these are gone:

  snapshot                   files     size
  2026-05-01T0800            3,201   12.4GB
  2026-05-08T0800              118  412.0MB
  2026-05-15T0800                0       0B
  shared across 3 snapshots    842    3.1GB
                             ──────────────
  total unrestorable         4,161   15.9GB

Full list:
  C:\Users\me\.s3cab\forget-unrestorable-preview.txt
Forget 3 snapshots ('2026-05-01T0800', '2026-05-08T0800', '2026-05-15T0800') from set 'photos' (bucket my-backups)? This cannot be undone. [y/N] y
Forgetting removes snapshots, not the objects they point at; reclaim unreferenced ones with:
  s3cab cleanup my-backups
Record of this removal:
  C:\Users\me\.s3cab\sets\photos\forget-unrestorable-2026-05-20T141807.txt
3 snapshots forgotten from set 'photos'.
```

The **shared** line is content that more than one of the snapshots you named holds, and
nothing else does — it's only lost because they're all going together. Forget any one of
them alone and it stays referenced. That's why the check looks at the whole list at once
rather than one snapshot at a time.

Two things worth knowing about the numbers. They're **bucket-wide**: if another backup set
stores the same file, it isn't counted, because forgetting this snapshot still leaves it
restorable from there. And **files and sizes don't scale together** — s3cab stores one copy
of identical content however many files point at it, so a thousand lost copies of one file
free the space of one.

Working the list out means reading every snapshot in the bucket, which takes a moment on a
large repository. That's the reason to name several snapshots in one run: it's one read for
the batch, not one per snapshot. If you don't want it — you know what you're deleting, or
you're in a script (where it's required: there's no terminal to answer the prompt) —
**`--force`** skips the check and the confirmation together:

```console
> s3cab forget --set photos 2026-05-01T0800 --force
```

### The two files it leaves behind

The preview above is `~/.s3cab/forget-unrestorable-preview.txt`, and it's replaced every time
you run a check — it's there to help you answer the question in front of you, and it's of no
use once you have.

Once you say **yes**, though, s3cab also keeps a permanent copy in the set's own folder:

```
~/.s3cab/sets/photos/forget-unrestorable-2026-05-01T080213.txt
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
terminal) it refuses unless you pass `--force` — the same explicit-intent rule the other
destructive commands follow, since blocking a script on a prompt would be worse. Like
`restore`, it always takes `--set`: a destructive command should never guess its target. Every name is checked against what's really backed up
**before anything is removed**, so a typo is an error listing the real ones — never a
half-finished run that already removed the names before it.

Local snapshots need no command at all — the files are the API. Delete the file.

## Deleting files from every backup (`delete`)

`forget` drops a *moment*; `delete` drops a *thing*. When a file or folder turns out to be
something you'll never want back — raw footage you've finished with, a huge download that
slipped into a backed-up folder, a file with a leaked password in it — excluding it only
stops *future* backups. `delete` removes its content from the backups you've already taken.

It's a two-step job, on purpose: something this destructive deserves an exact list, not a
pattern match. [`find`](find.md) is the search — it turns a name into the **content
hashes** that back it, one per line, with everything it knows about them in comments. You
review that file, cut anything you want to keep, and hand it back:

```console
> s3cab find raw-footage\ > footage.txt
> s3cab delete --bucket my-backups --from-file footage.txt
Deleting 297 objects (48.1GB) from every backup in 'my-backups'.

This permanently removes the content above from every backup in 'my-backups'.
Type the bucket name to proceed: my-backups
Record of this removal — verify and restore read it to tell deliberate removal from damage:
  s3://my-backups/objects.deleted-1.tsv
my-backups: deleted 297 objects (48.1GB). Snapshots were not modified.
```

Hashes can also go straight on the command line (`s3cab delete --bucket my-backups
<hash>...`) when there are only a few. Either way the operands must *be* hashes — a path or
anything else is an error pointing you at `find`, never a guess.

This is the most destructive thing s3cab can do — it removes content that your snapshots
still reference, from **every backup, every set, every machine sharing the bucket** — so it
has the strongest confirmation in the tool: you type the bucket name back, not just `y`.
`--dry-run` (`-n`) shows what would go and stops; scripts must state their intent with
`--force` (there's no prompt to answer without a terminal).

Three things to understand about what it does:

- **Your snapshots are not rewritten.** Every snapshot file stays exactly as it was — an
  accurate record of what the disk looked like that day. The *content* behind the hashes is
  what's removed, and a **deletion record** is written into the bucket
  (`objects.deleted-1.tsv` at the root) saying so. That record is why the rest of the tool
  stays calm: `verify` reports the gap as expected rather than as damage, and `restore`
  skips those files gracefully, telling you when they were deleted.
- **A hash is the content, wherever it lives.** Backups store one copy of identical
  content however many names, sets and machines share it — so deleting a hash removes that
  content from all of them. `find` warns when an object also backs files *outside* what you
  searched for, and prints every path; the review is where you catch the copy you still
  want. (One refusal is built in: the hash of the *empty file* backs every zero-byte file
  in the repository, and `delete` won't take it.)
- **It frees space directly.** Unlike `forget`, there's nothing left for `cleanup` to sweep
  — the objects themselves are deleted (softly: versioning keeps them recoverable for the
  usual window, below).

A hash the bucket doesn't hold — already deleted, or pasted from the wrong bucket — is
reported and skipped, never a failure. And if you back the file up again later, it simply
re-uploads on the next `backup`: deleting is never a ban, just a removal.

### Under the hood

What a `delete` run actually does, in order:

1. Checks the list: every operand (and every column-one entry of `--from-file`) must be a
   64-character hash, and the empty file's hash is refused outright.
2. Asks the store about each hash — one cheap HEAD per object, nothing downloaded. Hashes
   it doesn't hold are reported and skipped; the sizes that come back are the real figure
   in the summary.
3. Prints the summary and asks for the typed confirmation (`--dry-run` stops here).
4. Writes the deletion record — a new `objects.deleted-<n>.tsv`, never overwriting an
   existing one — *before* deleting anything, so even a run that dies halfway leaves every
   gap explained.
5. Deletes the objects. Snapshots, as ever, untouched.

## Reclaiming storage (`cleanup`)

Forgetting snapshots doesn't free space by itself. Once nothing references a piece of content,
it becomes an **orphan** — still stored, paid for, pointed at by nothing. `cleanup` finds
them:

```console
> s3cab cleanup my-backups
Delete 312 orphaned objects (1.4GB) from bucket 'my-backups'? This cannot be undone. [y/N] y
Don't run cleanup while a backup is running.
my-backups: deleted 312 orphaned objects, reclaimed 1.4GB.
```

**It asks before it acts.** At a terminal the question itself carries the count and the
space it holds, so there is nothing to scroll back for — a plain `y/N`, because everything
it removes is content nothing references any more. Afterwards it names the one race the
counts can't show you (the grace window, below), and its own report lands last. To look
without touching anything, `-n` (`--dry-run`) reports and stops:

```console
> s3cab cleanup my-backups --dry-run
Dry run — nothing deleted. Re-run without --dry-run to reclaim (add --force when there's no terminal).
my-backups: 48,210 objects stored, 312 orphaned (1.4GB reclaimable)
```

In a script — no terminal to answer the prompt — state the intent with `--force`, which
reclaims without asking:

```console
> s3cab cleanup my-backups --force
```

Orphans come from exactly two places: snapshots you forgot, and backups that crashed
part-way (uploads that landed before the run stopped). Both are harmless — they only cost
storage.

An acting run (never a dry run) also does one piece of quiet housekeeping: it **compacts
the deletion record** that `delete` writes (above), merging the `objects.deleted-*` files
into one and dropping entries no snapshot references any more — once the last snapshot
listing a deleted file is forgotten, nothing can ever ask why it's absent. It tells you on
the way out when it did.

### The safety rules

`cleanup` removes file content (it and `delete` are the only two commands that do), so it's
hedged:

- **Recent objects are never touched.** Any object younger than **7 days** is left alone, even
  if nothing references it. A backup uploads content *before* the snapshot that references it,
  so a young unreferenced object may belong to a backup that's running right now. The window
  is fixed — there's no flag to shorten it, because that's a foot-gun that buys nothing.
- **An unreadable snapshot stops the run** — both modes, even the dry run. If a snapshot won't
  read, its references are unknown, so everything it alone referenced would *look* orphaned.
  Rather than report numbers that are lies, `cleanup` stops and sends you to `verify`.
- **Missing objects make reclaiming refuse.** If verify-style faults are already present, the
  repository is losing data and this is not the moment to reclaim. A `--dry-run` still reports.
  (Content removed by `delete` doesn't count — its absence is recorded and deliberate.)
- **Don't run cleanup while a backup is running.** The grace window covers the ordinary race,
  but this is the one rule it can't enforce for you.

Everything it deletes is an orphan — content some live snapshot needs is never a candidate, so
`cleanup` cannot break a restorable backup.

## Versioning: why any of this is safe

**Turn on bucket versioning.** `s3cab aws` does it for you; if you made the bucket by hand,
do it yourself. It is the single thing that converts every mistake on this page from permanent
to recoverable.

With versioning on, `forget`, `delete`, and `cleanup` all issue **soft** deletes:
S3 writes a delete marker and the bytes live on as a noncurrent version. So a `cleanup`
you regret, a `delete` that took more than you meant, a snapshot you shouldn't
have dropped — even a leaked key used maliciously — can be recovered. The least-privilege identity `s3cab aws` generates is deliberately allowed to
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
| When space matters | `s3cab forget` old snapshots (several at once), then `s3cab cleanup <bucket>` | drop what you don't want, then reclaim it |
| When one thing is the space | `s3cab find <path> > list.txt`, review, then `s3cab delete --bucket <bucket> --from-file list.txt` | drop that thing from every backup, keeping the snapshots |

Automatic retention rules — keep-last, daily/weekly/monthly — aren't built yet. They'll be
built on top of `forget` and `cleanup` once real usage shows the shapes people actually want.
Until then, retention is you deciding which snapshots to drop.
