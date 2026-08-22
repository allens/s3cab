# `find`, and a hash-operand `delete`

Replace today's path-scoped `delete` with one that takes **hashes**, fed by a new **`find`**
that searches snapshots for a path. **Settled in a grilling session 2026-08-22** — the design
below is complete and argued, not a sketch. It stays here rather than in
[docs/adr/](../docs/adr/) because nothing is built yet and two parked questions could still move
it; it becomes ADRs when it lands (superseding
[0063](../docs/adr/0063-forget-snapshots-delete-paths.md)'s rationale,
[0064](../docs/adr/0064-path-scoped-delete-deletion-record.md) and
[0087](../docs/adr/0087-deletion-record-suffix-on-collision.md)).

The operation's purpose is unchanged: **remove all remnants of a file from the repository** — the
uploaded secret key is the classic case, but there are lots of other reasons. What changes is the
operand, and everything that follows from it.

## Why a hash, and why nothing narrower than "everywhere"

Two things settled together, and they are the whole argument for the split:

- **No mode narrower than `--everywhere` is wanted.** Today's `delete` resolves named paths
  within the sets attached on this machine and lets any outside reference *protect* an object,
  with `--everywhere` as the deliberate content-scoped override. In practice the override is the
  only mode anyone reaches for, so the protection scan — and the machinery behind it — goes.
- **But doing that by path is not safe.** A name-match decides which *content* gets destroyed
  bucket-wide, so one over-matching pattern nukes bytes nobody ever looked at, irreversibly, for
  everyone. **An irreversible bucket-wide delete must not take a fuzzy operand.** Splitting the
  command moves the fuzzy step into a read-only one where a mistake costs nothing, and gives the
  destructive step the exact identity of the thing it destroys.

Dangling pointers are the accepted consequence: snapshots in any set, on any machine, may list
content that is deliberately gone. Deleting the file regardless of name — by contents — is the
point, and the record (below) is what tells a reader the absence is deliberate.

## `find`

Its own command, and **useful on its own** — "which snapshot has my file, and what did it hash
to" has no answer in the tool today. It ships first and independently of the delete rework.

1. **Local snapshots only, no `--remote`.**
   [ADR-0027](../docs/adr/0027-compare-local-only-adoption-syncs-manifests.md) already settled
   this shape: `reattach` pulls a set's *entire* snapshot history down, precisely so
   `compare`/`list`/`restore` stay local-only "instead of growing a remote-reading variant of
   every browse command". `find` joins them. It costs zero S3 calls.
2. **Searches every attached set**, `--set` narrows. No `--bucket` flag: a set is bound to one
   bucket, so the output names each result's bucket and says so when results span more than one —
   the only case where feeding the file to a single `delete --bucket` would drop rows, and the
   preflight (below) catches that at the other end too.
3. **Matching follows POSIX `find`, not `exclude`.** A pattern with **no separator** matches the
   **basename** (`junkfile.dat`, `*.jpg`); a pattern **with** one matches the full path, floating
   (an implicit `**/` on the front; a trailing `/` means everything beneath). Same token compiler
   as `compileExclude` (`*`, `?`, `**`), different anchoring — exclude patterns are root-relative
   and anchored, which is right for pruning a subtree and wrong for finding a file. Under
   exclude's rules `secretsdir/` would match nothing at all (snapshots have no directory rows)
   and `*/junkfile.dat` would match only one level down. Case-sensitivity keys on `isWindowsPath`
   (the path's shape), never `process.platform` — searching a Windows snapshot from Linux is real.
4. **Two passes.** Pass 1 matches paths and collects their hashes (typically one to five). Pass 2
   re-scans for exactly those hashes and collects every *other* path they back. That second pass
   is the dedup warning, and it is why `delete` needs no scan of its own. One pass would mean a
   ~27M-entry hash→paths map on a large set; two passes stay bounded by the tiny hash set.
5. **Identical consecutive snapshots collapse to a range** — a file unchanged for five years is
   one entry with a span, not 900 identical lines. `--all` prints every snapshot.
6. **Output is one hash per line, all context in `#` comments** — readable in a terminal without
   wrapping (a 64-char hash plus size, mtime and a Windows path does not fit), redirectable,
   editable, and feedable straight back to `delete`. It *is* the flat hash-per-line stream
   `hashes` already establishes as the composition medium, so `delete` reads the same thing from
   either command and the comments are garnish a lenient parse skips.

```
# s3cab find · 2 patterns · 3 files · 4 objects
# searched myset (943 snapshots), work (211) — local history
#
# C:\Users\me\secretsdir\secret1
#   1,204 bytes   modified 2019-04-02 07:55Z
#   myset  2019-04-02T0810 … 2021-11-30T2201   (612 snapshots)
a3f9c21e8b04d5c7e2019f8ab34d6e57190c2f8ba4e31d05c8f7a2b93e14c60d
#
# C:\Users\me\secretsdir\aws-keys.txt
#   892 bytes   modified 2019-03-28 14:02Z
#   myset  2019-03-28T0812 … 2026-08-14T0930   (943 snapshots)
#   ⚠ also backs 3 other paths — deleting this removes all of them
5e21ab7fc0b1e83d276af59104cc7e2b8d3610fa94e7b25c0d81f36ae9b40c93
```

The columnar scan across files is the thing this layout gives up; a table of TSV rows reads
better side-by-side but wraps in any real terminal. Most searches return one file or a few, and
an editor greys the comment lines, so editing the file down to the hashes you want is easy —
not Excel-easy, but that is not a workflow worth designing for.

## `delete`

```
s3cab delete --bucket <bucket> <hash>... [--from-file <file>] [-n|--dry-run] [-f|--force]
```

7. **Hashes, positional or `--from-file`.** No piping: it is not cross-platform, and a pipe means
   nobody read the rows. `--from-file` takes `find`'s output (or anything with hashes in column
   one) — the destructive command operating on a file a human has reviewed and edited.
8. **Preflight `HeadObject` per hash**, before anything is deleted. Hashes the bucket does not
   have are **reported and skipped**, not fatal — a hash pasted from the wrong bucket, a stale
   `find` file, or something already deleted is silent today. `ContentLength` comes back with it,
   which is what fills the record's size column and gives the prompt a real figure ("deleting 5
   objects, 4.2 MB").
9. **Hard refusal on the empty-file hash** (`e3b0c442…b855`). It backs every zero-byte file in
   the repository, so deleting it is never what anyone means. The general dedup hazard needs no
   special case — `find` already prints the path count, and the size column makes the pathological
   ones obvious.
10. **Confirmation unchanged from ADR-0064**: type the bucket name, non-interactive runs refuse
    without `--force`, `-n` previews, and the record is written **before** any object is deleted.
    The operand got safer; the consequence did not.

## The deletion record

11. **It is a tombstone, not a ledger.** Its only job is to tell a reader that an absence is
    **deliberate** — someone restoring `photo123.jpg` from snapshot X hits a missing object and
    needs to know it was deleted on purpose, not that the repository is damaged. That reader
    already has the path in front of them, so **the record carries no paths**; after "this was
    deliberate", the useful facts are *who* and *when*.
12. Which is also why it can be trimmed, and why s3cab should not grow an audit trail: keeping a
    note of every temp file that ever got caught in a backup, forever, is out of the tool's lane.
13. **Rows are `hash / size / instant / user@machine`**, matching a snapshot row's column *types*
    positionally (col1 hash-or-`#TAG`, col2 size, col3 timestamp, col4 the ragged textual end) —
    the first real use of the column-grammar item in [misc.md](misc.md). When and who live in the
    **rows**, not the filename, because compaction destroys filenames.

```
#DELETED		2026-08-22T11:04:55.120Z	These objects were removed on purpose. Absence here is not damage.
a3f9c21e8b04…60d	1204	2026-08-14T09:31:07.412Z	allen@DESKTOP
5e21ab7fc0b1…c93	892	2026-08-19T22:10:41.006Z	allen@LAPTOP
#END
```

14. **`#END` is bare, deliberately.** [guide/format.md](../guide/format.md) already defines the
    trailer as "first field, trimmed, equals `#END`" and states a bare one is valid (the snapshot
    trailer was bare before ADR-0085). It carries no `COMPLETE`/`PARTIAL`: a snapshot needs that
    because zstd decompresses a cut-short file into a plausible smaller snapshot and because it is
    written incrementally to local disk, whereas a record is uncompressed and lands in one atomic
    PUT — `PARTIAL` cannot occur, and a status column with one possible value implies a
    distinction that does not exist. The marker stays for consistency; the columns do not carry
    over.
15. **Root-level, indexed, never overwritten**: `objects.deleted-1.tsv`, `-2.tsv`, … A run LISTs,
    takes the next free index, conditional-PUTs (`IfNoneMatch: *`), and walks upward if it loses
    a race — ADR-0087's mechanism, retained purely as a slot allocator with no timestamp
    pretending to be information. Safe on `objects/`'s LIST because that prefix carries its
    trailing slash.
16. **`cleanup` compacts and trims in one operation** — union every row, drop those no snapshot
    anywhere references, write the merge to a *fresh* index, then delete the ones it absorbed. The
    steady state after any cleanup is a single file, which is the "one record" this started as,
    reached without a read-modify-write. Writing before deleting makes every crashed intermediate
    state correct, since a duplicated row is still just "deliberately gone". Gated by `cleanup`'s
    existing unreadable-snapshot interlock: an unknown reference must protect a row.
17. **Trimming is provably safe.** Every consumer reaches the record *through a snapshot that
    references the hash* — `verify` computes `referenced − stored`, `restore` is reading a
    snapshot when it hits the absence, `cleanup` subtracts from its missing-object interlock, and
    `backup`'s `storedHashes` trusts a baseline **only while `matchRemoteSnapshot` confirms it
    still exists remotely and byte-identical**, which makes that baseline itself a live reference.
    So "no snapshot in the bucket references H" ⟹ nothing can ever ask about H ⟹ the row is dead.

A rejected alternative worth keeping: a **single** `objects.deleted.tsv` that `cleanup` rolls up
into. Nicer to look at, but rewriting one fixed key is a read-modify-write, and two overlapping
cleanups can lose rows — which is *not* safe-direction, because `backup` subtracts record hashes
from a trusted baseline, so a lost row means it keeps trusting a baseline that vouches for deleted
content and publishes a snapshot referencing a missing object. Fixing that needs `If-Match` on
PUT, the newest and least universally implemented S3 conditional, and s3cab is
S3-*compatible*, not S3-only. It is a two-line change on top of the indexed scheme if `If-Match`
ever proves universal across the providers we care about.

## Naming

**`delete` keeps the verb**, working differently. POSIX pairs `find` with `-delete` and we are
already borrowing `find`'s matching semantics wholesale, so taking the search rules but not the
verb leaves the coherence on the table; [ADR-0012](../docs/adr/0012-consumer-vocabulary-naming.md)
says the plainest word wins, and CONTEXT.md's Delete entry already reads `_Avoid_: purge,
expunge, remove (say delete)`.

`purge` was the working name throughout the session and is the defensible runner-up — a distinct
word for a distinctly more severe operation. What decided against it: the safety argument does not
discriminate. Stale muscle memory (`delete --set X <snapshot>`, `delete secretsdir/`) fails
loudly under *both* spellings — a path is not 64 hex characters, and under `purge` the command
would not exist — so neither can lose data, and severity is carried by the bucket-name
confirmation rather than the verb. `destroy` is the strongest danger signal but is Terraform's
word for tearing down infrastructure, ambiguous about whether the *bucket* goes.

## What this supersedes

- **[ADR-0063](../docs/adr/0063-forget-snapshots-delete-paths.md)**: the verb table survives
  (`forget` snapshots, `delete` content); its *rationale* for `delete` — "delete `foo` from my
  backups is the plainest reading of the plainest verb" — was built on a path operand and is
  replaced by the argument above.
- **[ADR-0064](../docs/adr/0064-path-scoped-delete-deletion-record.md)**: mostly superseded —
  participating-set scope, the protection model, `--everywhere`, per-run `deletions/<timestamp>.tsv`
  records and their `hash<TAB>path` rows all go. The confirmation tier, record-first ordering and
  the destructive-command pattern stand.
- **[ADR-0087](../docs/adr/0087-deletion-record-suffix-on-collision.md)**: fully superseded. Its
  *mechanism* is retained as a slot allocator, but its whole subject — minute-precision naming,
  same-minute collisions, "one story for both timestamped artifacts" — evaporates once the
  filename makes no time claim. Blocking same-minute runs is **not** an option: that was
  ADR-0064's original design and 0087 reversed it after two people sharing a bucket hit it
  routinely and CI hit it for real.
- **Code**: `commands/delete.mjs` and `lib/delete.mjs` are rewritten and the participating-set
  protection machinery goes with them; `readDeletionRecords`' filename regex becomes an index
  match and its oldest-first name sort is replaced by comparing row instants. Scope the rest from
  a fresh grep at build time.
- **Docs**: [guide/format.md](../guide/format.md)'s deletion-record section and its layout tree
  (which gains its first root-level key); CONTEXT.md's **Delete** entry rewritten in place, plus
  a **Find** entry — and while there, its Cleanup entry still says "deleting takes an explicit
  flag", stale since `cleanup --delete` was removed in PR #223.
- **Pre-1.0, no compatibility code**: existing `deletions/<timestamp>.tsv` files get **no
  reader**. The old shape is deleted outright, not branched on.

## Parked

- **Should a set be usable from only one machine?** The multi-machine door is held open for one
  edge case — two machines synced to the same OneDrive — which probably works fine with a set
  each, since the dedup (the real value) is bucket-wide either way. Closing it would remove a
  recurring thorn: it retires `list --remote`, makes `reattach`'s one-time pull complete by
  construction, and narrows the cross-set race in
  [concurrency-and-locking.md](concurrency-and-locking.md). **Needs its own session**; nothing
  above depends on the answer.
- **On-demand snapshot sync** — "any command that relies on snapshots should sync with the
  remote". Today `reattach` pulls once, so a set backed up from two machines leaves each with
  history the other never sees. It dissolves entirely if one-machine-per-set lands, which is why
  it is not a `find` flag.

## Build order

`find` first and alone — it is fully settled, depends on nothing parked, and answers a question
the tool cannot answer today. The `delete` rework and the record format follow together, since
the record's shape is what a hash operand forces.
