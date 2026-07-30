# Timestamps: UTC inside files, local wall clock in names

**Status:** accepted, not yet implemented. Settles the timezone/precision question the
snapshot-format proposal carried. Extends [0004](0004-tsv-snapshot-manifests.md) (the row
grammar) and applies [0012](0012-consumer-vocabulary-naming.md) (who the user surface is for).

## Context

s3cab minted "now" in **five different spellings**, all from
`Temporal.Now.plainDateTimeISO()` and none of them recording a zone:

| Where | Example | Form |
| --- | --- | --- |
| Snapshot name, deletion-record name | `2026-06-12T0915` | local, naive, minute, colon dropped |
| `#SNAPSHOT` header, set marker `CREATED` | `2026-06-12T09:15` | local, naive, minute, with colon |
| Forget audit stamp | `2026-05-01T080213` | local, naive, second, colon dropped |
| File mtime in snapshot rows | `2026-06-01T12:00:00.000Z` | **UTC, milliseconds** |

So a snapshot file already carried a local-time header above thousands of Zulu mtimes, with
nothing saying so — and the `#SNAPSHOT` datetime was *derived from the filename* by re-inserting
the colon, meaning it carried **no information the name didn't**. Nothing in the repository could
resolve a snapshot to an actual instant.

Two faults follow from naive local names, because `snapshotNames` sorts them **lexically** to
mean "newest first", and that sort is load-bearing in four places that resolve with nobody
looking: `--latest`, `restore`'s default snapshot, `backup`'s baseline, and `compare`'s default
"previous".

- **DST fold** — twice a year, for one hour, two snapshots can collide (refused loudly) or invert.
- **A timezone move** — a laptop carried across zones can mint a name that sorts *before*
  yesterday's, so `restore` with no `--snapshot` silently hands back the older backup.

## Decision

**Split by kind, not one rule for everything.**

- **Instants — UTC, unchanged.** File mtime stays `…Z` at millisecond precision. It is *data*:
  compared against the filesystem, stored, and re-applied via `utimes`, so a file backed up in
  London and restored in New York must land on the same instant.
- **Records inside files — UTC, full precision.** The `#SNAPSHOT` header, the deletion record's
  `# generated:`, the forget audit's `# generated:`, and the set marker's `CREATED=` all become a
  full UTC instant. They are never typed and never sorted, so a fully-qualified form costs no UX.
- **Names — local wall clock, naive, minute precision, unchanged.** `2026-06-12T0915`.

Precision is chosen per artifact and is independent of the zone question: minute for names (the
collision unit, and a same-minute repeat is already a loud refusal), milliseconds for mtime
(compared against the filesystem), seconds for the forget audit file.

### The `#SNAPSHOT` line

**The row keeps its four columns** — they are repurposed, not added to, so every line in the
file still has exactly four fields. Extra columns *were* on the table (the header's own
alignment doesn't matter, and a spreadsheet splits each row independently, so a wider metadata
row would not disturb the data rows); they simply turned out not to be needed once the local
time and its zone shared one cell. What was rejected outright is a **new tag type** such as a
`#ZONE` row: that costs a concept in the spec, a branch on read, and something for a recovery
reader to learn, where a column costs none of that.

```
#SNAPSHOT	photos	2026-06-12T08:15:32.123Z	2026-06-12T0915 Europe/London
#DIR			C:\Users\me\Photos
3b8e…c0a1	4915200	2026-06-01T12:00:00.000Z	C:\Users\me\Photos\beach.jpg
```

- **col2** — the set name (its whole identity, [0024](0024-set-name-is-the-whole-identity.md)),
  moved into the previously-empty size column.
- **col3** — the full UTC instant the snapshot **started**. `padEnd(24)` already fits it exactly,
  because a millisecond ISO instant is 24 characters — which is why the column is 24 wide for
  mtime. So column C is "the time" on metadata and data rows alike.
- **col4** — the snapshot's **own name plus the clock that name was minted from**. Not "the local
  time": minute precision here is not an approximation, it *is* the name, so a file that gets
  renamed or copied still says what it was called. The zone is what makes the name interpretable,
  and names it rather than merely recording an offset (`Europe/London` explains a DST shift;
  `+01:00` only records one).

One clock read produces all of it: capture the instant once, derive the name from it in local
time and col3 from it in UTC, so the filename and the header still cannot disagree.

Free-form comment lines take the same shape — the machine instant, then the artifact's own name
and zone:

```
# generated:  2026-07-19T13:22:04.881Z  (2026-07-19T1422 Europe/London)
```

### Both layouts are read, forever

Snapshots are **immutable and never rewritten**, so changing the `#SNAPSHOT` row does not migrate
anything — every file written before this keeps the old row, and a reader must handle both for
good. That is the coexistence cost this whole ADR was weighed against, and it is paid here rather
than avoided.

The two are told apart by **whether col2 holds anything**. A set name is `[a-z0-9-]+` and so is
never empty; the pre-0072 writer always left col2 blank (`#SNAPSHOT<TAB><TAB>datetime<TAB>set`).
No version marker is needed, and none is added — the layouts are self-distinguishing.

An old header yields `identity` as before, with `instant` and `zone` **absent** rather than
guessed, so `Snapshot` types them as optional and a consumer has to decide what to do without
them. That is what keeps the warn-only checks below honest: they simply do not fire on a snapshot
that cannot answer.

## Why names stay local

- **They are read and typed by humans**, and clock times are what humans think in. `forget`
  requires exact names (a required variadic positional with no default), and names appear in
  `list`, in Explorer, and in the S3 console.
- **s3cab controls only some of those surfaces.** Rendering a friendly local time in `list` would
  not reach Explorer, the AWS console, or `zstd -d` — which are exactly the manual-recovery
  surfaces the no-lock-in promise exists for.
- **Zulu names would file night backups under the wrong date.** At UTC+2, a 01:00 backup becomes
  `…T2300Z` on the *previous* day — "Monday night's backup" appearing under Sunday, in the very
  surfaces we cannot caption.
- **Retention will bucket by local day.** Keep-last / daily / weekly / monthly is the one planned
  feature that must *compute* with snapshot times, and it will read the **name** (cheap, from a
  LIST) rather than headers (a GET per snapshot). "One per day" means the user's day, which a
  naive local name yields directly from its date prefix; UTC names would need converting first,
  using a zone we would have to choose — the reader's, or the writer's.
- **The ambiguity objection is now answered.** A name is no longer orphaned: open the file and
  col3/col4 give the instant and the zone.

## The accepted consequence

**In the DST fold, or across a timezone move with two backups a few hours apart, the lexical name
sort can invert** — affecting `restore`'s default snapshot, `compare`'s default previous, and
`--latest`. This is knowingly accepted, not overlooked. It is now *explicable* (the zone is in
the file) rather than mysterious, and two checks catch it where it is created:

- **A. Clock-went-backwards, in `snapshot`/`backup`.** The baseline is already read and its header
  now carries a true instant, so if "now" is earlier than it, the clock has moved back and the
  snapshot about to be written will sort before its predecessor. **Warn, never block** — a clock
  oddity must not stop a backup.
- **B. Ordering sanity, in `compare`.** It reads both headers, so it can confirm `since` really is
  older than `until` and say so when the names disagree with the instants, rather than silently
  rendering a backwards diff. (Not available on `snapshot`'s fused fast path, where the baseline
  arrives as pre-parsed entries with no header — check A already covers that run.)

Both are free: `readBaseline` and `restore` already parse the full header and discard it. The
enabling change is `parseSnapshotStream` surfacing the instant and zone onto `Snapshot`, which
today keeps only `identity` and `dirs`.

## Considered and rejected

- **UTC names (`2026-06-12T0815Z`)** — correct ordering unconditionally, and initially
  recommended. Rejected: the cost lands on every read of every surface forever, against a fault
  that bites twice a year plus travel, and it loses the retention-by-local-day property.
- **Local time with an offset in the name (`2026-06-12T0915+01:00`)** — unambiguous *and*
  wall-clock-first, and would let the sort be made correct by parsing the name alone. Rejected on
  UX: it is a mouthful to type and to read for a consumer tool.
- **Sorting by reading headers** — correct, but turns one `LIST` into a ranged `GET` per snapshot
  on the remote path `restore` and `backup` use, growing with history, plus partial zstd frame
  decoding. Far too much machinery for a rare fault ([0006](0006-minimal-code.md)).
- **Sorting by file mtime / S3 `LastModified`** — free from the listing, but `reattach` downloads
  snapshots, so their mtimes all become download time and the order scrambles exactly when it
  matters most.
- **A `#ZONE` metadata row** — rejected in favour of widening `#SNAPSHOT`, per the reasoning
  above.
- **`#SNAPSHOT:photos` sub-syntax inside col1** — packing the set name into the 64-wide marker
  column (set names are `[a-z0-9-]+`, so a delimiter is safe, and the column is close to the name
  length limit anyway). Not taken, because there is no shortage to solve: col2 is unused on every
  metadata row, so the set name simply moves there. **Kept in the bag against a shortage** — if
  col2 is later wanted for something else, this is how col1's spare characters buy the space back.
  Any candidate for that slot carrying a hostname or user name is the same question
  proposals/metadata-privacy.md is open on, and should be settled there rather than twice.
- **Seconds precision in names** — with a same-minute repeat already refused loudly, it buys only
  longer names.

## Consequences

- **The set marker's `CREATED=` is displayed**, in the set-collision error at `setup`. A full
  millisecond instant reads badly mid-sentence and against
  [0030](0030-error-message-guidelines.md), so the error **renders just the date** (`created
  2026-06-12`) while the file keeps the full instant.
- **The third spelling of naive local time is retired** — `CREATED` and the `#SNAPSHOT` datetime
  no longer use the colon-bearing minute form.
- **Deletion-record and forget-audit *filenames* keep aliasing the snapshot-name convention**, so
  the format spec tells one story for every timestamped artifact.
- **guide/format.md changes**, since the `#SNAPSHOT` line and the record headers are part of the
  recovery contract.
