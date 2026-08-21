# `find` + `purge` — locate content, then delete it by hash

Captured 2026-08-21. A **major change to `delete`**: replace it with a hash-operand command
(working name `purge`), fed by a new search command (working name `find`). Both names are
provisional — `find` is the one worth keeping. **Not decided; needs a grilling session before
anything is built**, because it would displace a large body of settled design
([ADR-0063](../docs/adr/0063-forget-snapshots-delete-paths.md) /
[0064](../docs/adr/0064-path-scoped-delete-deletion-record.md) /
[0087](../docs/adr/0087-deletion-record-suffix-on-collision.md)).

The point of the operation is unchanged from `delete`: **remove all remnants of a file from the
repository** — the uploaded secret key is the classic case, but there are lots of other reasons.
What changes is how you get there.

## `find` — search snapshots for a path

Find files matching a pattern across all snapshots in a set. Scope is **one set** for now;
multi-set or bucket scope is possible but a single set fits the brief.

Matching uses **the same matcher as exclude patterns**. Output is essentially the **TSV rows of
the snapshots that matched**:

```
$ s3cab find --set myset secretsdir/ */junkfile.dat
myset/2007-10-11T2333
abc123feg456  223234  2006-11-01T1020  secretsdir/secret1
…
```

So you see every hash that matched, across snapshot time.

**`find` is orthogonal to the `delete`-vs-`purge` argument — it is useful in itself**, and could
be built on its own.

## `purge` — delete objects by hash

Supply the hashes you want gone. Bucket-scoped:

```
s3cab purge --bucket mybucket abc123feg456 …
```

That does an S3 delete of `mybucket/objects/abc123feg456`. Nothing else — no reference scan, no
per-set resolution.

**Yes, this instantly leaves dangling pointers** in any snapshot in any set, including sets
managed by other machines. That is intended: *deleting the file regardless of name — you could
say by contents — is exactly what I want.* It follows that `find` only ever needs to cover **your
own** sets: since `purge` never consults references, there is nothing to learn from anyone
else's.

**"This is more how I'd work than what `delete` does, and less complicated."**

## The purge record — one bucket-wide list

Instead of recording lots of little delete instances, keep **one bucket-wide list**, e.g.
`mybucket/objects.purged`. Details to be decided, but basically **a hash and some metadata per
row**, where the metadata is who / when / why. A purge just appends to it.

**The list isn't forever expanding** — a `cleanup` run can trim it.

## What this would displace

Stated as fact about today's code, not as an argument either way:

- Today's `delete` takes **paths**, resolves them within the sets attached on this machine, and
  **an outside reference protects the object** — `--everywhere` is the explicit content-scoped
  override for exactly the leaked-secret case (ADR-0064). `purge` makes the override the only
  mode and drops the resolution step out of the command entirely.
- The deletion record today is **one TSV per run** under `deletions/`, minute-named, written
  *before* any object is deleted, with `hash<TAB>path` rows and a `#` header
  (ADR-0064/0087). `objects.purged` is one appended list instead, and S3 has no atomic append.
- Four consumers already read that record — `verify` (expected- vs unexplained-missing),
  `restore` (graceful per-file skip), `backup` (baseline subtraction), `cleanup` (missing-object
  interlock). Any record change carries all four.
- It is documented in [guide/format.md](../guide/format.md) as part of the
  [ADR-0002](../docs/adr/0002-no-lock-in-hard-constraint.md) recover-from-stored-files contract,
  and in CONTEXT.md as **Deletion record**.

## Questions to grill

- **Is `purge` the right verb?** It sits on CONTEXT.md's Cleanup `_Avoid_` list, and ADR-0063
  rejected it for this operation precisely because it evokes routine janitorial sweeping.
- **Hashes as the operand** — does making the user carry hashes between two commands hold up
  (composability, copy-paste, "did I paste the right one"), or does it move a safety-critical
  step out of the tool and into the user's shell?
- **What confirmation does `purge` take**, given ADR-0064 gave `delete` the strongest in the tool
  (type the bucket name) and a dry-run/force pattern shared with `cleanup` and `forget`?
- **Trimming the list** — on what rule can `cleanup` drop a row, and what happens to the audit
  trail (who/when/why) when it does? What does a consumer do with a hash whose record was
  trimmed?
- **Append without atomic append** — read-modify-write on one key loses a concurrent purge; what
  covers that?
- **Does `find` overlap `tree`/`list`/`hashes`**, and is "search snapshots" its own command or a
  mode of one of those?
- **`find` output shape** — raw snapshot TSV, or a rendered view? Raw rows are pipeable but pin
  the stored format into a command's output contract.
- **Does the exclude matcher fit a search?** Exclude patterns are written to *drop* things;
  reusing them to *select* things may read backwards for some patterns.
- **Is `--set` the right scope for `find`**, given the workflow described is "find on a set or
  all my sets"?
