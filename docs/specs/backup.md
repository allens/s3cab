# `s3cab` Backup Sets and Remote Repository Format Spec

## Status

Designed (2026-06-12), **implementation in progress**. Slices 1–3 and the restore half of
slice 4 are built. Slice 1 gave the set store (`src/lib/sets.mjs`), `setup`, `sets`, and
the set env layer in auth; slice 2 moved the local engine onto sets —
`snapshot`/`list`/`compare`/`tree` take `[<set>]`, walk every member dir with the set's
`exclude.txt`, write one snapshot (with `#SNAPSHOT` identity + `#DIR` headers) into
`~/.s3cab/sets/<set>/snapshots/`, and `<dir>/.s3cab/` has retired. Slice 3 (PR #39) built
the `snapshots/` remote half and the cloud porcelain: the remote repository engine
(`src/lib/remote.mjs` — remote-snapshot listing/read, the upload-set diff
`uploadCandidates`, the snapshot-last `uploadSnapshot`), plus `backup`, `status`, and
`list --remote`. The `objects/<sha256>` half of the remote layout — `putObject` / verified
`getObject` / `listObjectHashes` and the per-bucket objects cache — is owned by
`src/lib/objects.mjs` (extracted 2026-06-17 from where it had been scattered across
`remote.mjs`/the plumbing commands; its lister is the `hashes` command — renamed from
`objects` to free the name — and `upload` its writer). Slice 4's restore path (PR #44)
added `restore` (`src/commands/restore.mjs`, on the verified `getObject` + `remote.mjs`'s
`listRemoteNamespaces`) and `setup --from` **adoption** for fresh-machine
recovery. `restore --output` re-rooting is now built too (`parseSnapshotStream` surfaces the
`#DIR`/`#SNAPSHOT` headers it used to drop; `reroot` in `restore.mjs` maps each member dir
under `<output>/<basename>/…`). Remaining target: `compare --remote`, and slice 5
(`verify`/`delete`/`cleanup`).

> **History:** the first cut of this spec (same day) namespaced remote snapshots by a
> per-directory stored label, keeping the local engine per-directory. It was superseded
> within hours by the **backup set** model below, because a set name solves the identity
> problem outright: directories become the *contents* of a set rather than its identity,
> so renaming a machine or moving a folder edits a config file instead of forking the
> backup history. Decisions that survived unchanged: byte-identical snapshots, the
> snapshot-last invariant, and the diff-vs-latest-remote upload set.

> **⚠️ Redesign settled (2026-06-20), not yet implemented.** A reshape of the **identity
> model, local/remote layout, env layering, and `setup`** is agreed and recorded in
> [ADR-0024](../adr/0024-set-name-is-the-whole-identity.md) (the set **name** becomes the whole
> identity — no `user@machine`), [ADR-0025](../adr/0025-drop-per-bucket-env-layer.md) (drop the
> per-bucket env layer), and [ADR-0026](../adr/0026-bucket-required-at-setup.md) (bucket required
> at setup; no local-only sets), with the full design in
> [proposals/local-config-and-remote-storage-structure.md](../../proposals/local-config-and-remote-storage-structure.md).
> **Everything below still describes what the code does *today* (the `user@machine` model).** The
> redesign supersedes the identity, on-disk-layout, remote-layout, env-layering, and
> `setup`/adoption sections; the format invariants (byte-identical snapshots, objects-first /
> snapshot-last, the upload-set diff, `verify`/`cleanup`) are unaffected. This spec is rewritten
> to the new model when the change lands.

## Purpose

Define s3cab's unit of backup (the **backup set**), its on-disk configuration, the
remote repository format, and the behaviour of the `setup`/`backup` commands. Format
decisions are commitments: per [ADR-0002](../docs/adr/0002-no-lock-in-hard-constraint.md) (no lock-in), the stored layouts —
local *and* remote — are the contract a hand-recoverer or replacement tool relies on.

Guiding instinct throughout: **simple, obvious, accessible, discoverable.** Every config
artifact is a self-evident plain-text file a user can find by listing a folder and
understand by opening it.

## The backup set

A **backup set** is a named list of directories that snapshot, back up, and restore as
one unit — the consumer mental model ("my photos" = two folders on two drives). It is
the operand of every porcelain command.

A set's full identity is **`user@machine:set-name`** (e.g. `allen@allen-pc:photos`):

- The **whole identity is captured once, at set creation** — `user@machine` sanitized
  from the OS username and hostname, plus the set name — stored in the set's `env`
  (e.g. as the remote namespace value `allen@allen-pc/photos`) and never recomputed.
  Renaming the machine therefore cannot fork the backup history, and neither can
  renaming the set: the folder name under `~/.s3cab/sets/` is a purely **local handle**,
  while the pinned namespace is what appears in the bucket. The `user@machine` part
  exists to keep multiple users/machines distinct inside a shared bucket.
- **Charset (decided):** the canonical form for every namespace part is lowercase
  `a-z`, `0-9`, and `-` — nothing else, so nothing downstream ever needs escaping. Set
  names are **validated**: `setup` rejects a non-conforming name with the rule and a
  suggested kebab-case form (user-chosen, so teach the rule). The captured user/machine
  parts are **sanitized** automatically (lowercase; anything else → `-`; collapse runs;
  trim) — the user never typed them, so silent normalization is fine (Windows usernames
  may contain spaces/unicode). A part the charset can't express at all (an all-non-Latin
  username sanitizes to "") falls back to a **short stable hash** of the raw value, so
  identities stay distinct in a shared bucket even when recognisability is unsalvageable
  (settled in PR #33 review).
- The identity is informational for recovery, not load-bearing: snapshots internally
  record the identity *and* their member directories (see header), so a recoverer can
  always learn what a namespace is by opening one snapshot.

### On disk: one folder per set

```
~/.s3cab/
  env                    # per-user defaults            (existing auth layer)
  env.<bucket>           # per-bucket auth              (existing auth layer)
  sets/
    photos/
      dirs.txt           # member directories, one absolute path per line
      env                # S3CAB_BUCKET=… + the pinned identity + overrides
      exclude.txt        # optional; patterns applied relative to each member dir
      snapshots/
        2026-06-12T0915.tsv.zst
```

- **The files are the API.** Editing a set = opening `dirs.txt`/`env`/`exclude.txt` in
  any editor; deleting the folder deletes the set. No structured config format, no
  management subcommands to keep honest with the files.
- The set's `env` is a new **set layer** in the auth/env layering, replacing the
  never-wired per-dir layer (`<dir>/.s3cab/env`) from [auth.md](auth.md): precedence
  becomes set → bucket → user → shell. (auth.md is updated when this is implemented.)
- **`<dir>/.s3cab/` retires entirely** — snapshots and excludes no longer live inside
  backed-up directories. (Pre-release; no migration machinery, just doc updates.)
- `exclude.txt` keeps today's pattern semantics (see guide/exclude.md), applied relative
  to **each** member directory.

## CLI surface

Porcelain is **set-first**: `snapshot`, `list`, `compare`, `backup`, `restore`,
`status`, `verify`, and `tree` all take `[<set>]`, which **defaults to the only set**
when exactly one exists — so after setup, plain `s3cab backup` just works. When several
sets exist and none is named, the error lists them. `tree [<set>]` becomes "exactly what
a snapshot of this set would include", sharpening its diagnostic role. The file/bucket
diagnostics (`prop`, `hashes`, `upload`) are unchanged.

### `setup` — the front door

```
s3cab setup <set> <dir>... [--bucket <bucket>]
```

Creates `~/.s3cab/sets/<set>/`, writes `dirs.txt`, pins `user@machine` into the set's
`env`, and binds the bucket if given. Re-running updates whatever pieces are passed.

**The bucket is optional on purpose:** a bucket-less set is a fully working *local*
snapshot engine (`snapshot`/`list`/`compare`/`tree`), preserving the try-it-first path.
`backup` on such a set stops with the exact command to run
(`s3cab setup photos --bucket <bucket>`). An interactive wizard may later wrap this
one-shot form; it is not part of v1.

**Adoption (disaster recovery / replacement machine):**
`setup <set> --bucket <bucket> --from <user@machine>/<set>` creates a local set whose
pinned namespace is the existing **remote** one — *not* derived from this machine —
seeding `dirs.txt` from the latest remote snapshot's `#DIR` lines. After adoption,
`restore`/`list`/`compare` just work, and `backup` continues the same history (exactly
right for a rebuilt PC).

### `sets` — the lister

Shows every set with its directories and bucket binding — the discoverability
counterpart of "files are the API", and what error messages point at:

```
> s3cab sets
photos   → s3://my-backup-bucket   (2 folders)
           C:\Users\me\Photos
           D:\Pics
docs     (no bucket — local only)   (1 folder)
           C:\Users\me\Documents
```

### `backup` — porcelain semantics

`s3cab backup [<set>]` means "back up my stuff now": take a fresh snapshot of the set,
then upload it. `--snapshot <name>` skips the snapshotting and uploads that existing
snapshot instead. Internally `backup` coordinates `snapshot()` and a lower-level
snapshot-uploader (given an existing snapshot + bucket: compute upload set, upload
objects, upload snapshot). The uploader function is the library surface regardless;
whether it also gets its own registry entry (Advanced group) is decided at
implementation.

### `restore` — put files back, never destructively by default

`s3cab restore [<set>] [paths…]` restores to **original locations** (the snapshot's
absolute paths) but **never touches an existing file** — existing files are reported as
skipped; `--overwrite` replaces them. So the disaster-recovery case (empty disk) and the
"I deleted a folder" case both just work, and a careless restore can't destroy newer
work. `--snapshot <name>` picks the source snapshot (default: the latest remote);
positional `paths…` filter what is restored. Restored files get their snapshot **mtime**
(required — the snapshot diff depends on mtimes).

`--output <dir>` re-roots instead: each member dir's contents restore relative to it
under `output\<root-basename>\` — shallow and human-readable. Two roots sharing a
basename is detected up front and errors with guidance (rare, actionable).

### `delete` — remove one remote snapshot

`s3cab delete <set> --snapshot <name>` removes a single remote snapshot — the retention
*primitive*. It deletes only the snapshot; reclaiming the objects only it referenced is
`cleanup`'s job (the command's output says so, and reminds the user to refresh any
objects cache). Retention *policy* (keep the last 12 monthlies, …) comes later, on top
of this primitive. (Local snapshots need no command: the files are the API — delete the
file.)

## Snapshot files

**One snapshot per set per run** — all member directories in a single TSV (the existing
line format is already multi-root-safe: paths are absolute). This buys cross-directory
move/dedup detection in `compare` and makes the snapshot-last invariant a **set-level**
atomicity guarantee. The header records the identity and the member dirs as captured at
snapshot time, so the file is self-describing even when found alone in a bucket:

```
#SNAPSHOT   2026-06-12T09:15   allen@allen-pc:photos
#DIR        C:\Users\me\Photos
#DIR        D:\Pics
3b8e…c0a1   4915200   2026-06-01T12:00:00.000Z   C:\Users\me\Photos\beach.jpg
…
```

### Scope: regular files only (decided 2026-06)

Snapshots record **regular files and nothing else** — no symlinks/junctions, no
hardlink identity, no empty directories, no permissions/ACLs. This is a deliberate
product-scope decision, not an accident of implementation: s3cab is **not a system
backup tool** (commercial tools, OS built-ins, and git all serve that need). It exists
for a user to back up their documents, pictures, and video efficiently, where the thing
that matters is that **the content is recoverable**. File content, size, and mtime are
the contract; everything else is out of scope and documented to users as such.

### Snapshot names: collisions error, snapshots never overwrite

Snapshot names stay minute-precision local timestamps. A second snapshot of the same set
in the same minute is an **error**, not an overwrite — unlikely in real use, and an
accidental double-run (a scheduler firing twice) must not destroy a snapshot. The same
rule holds remotely: `backup` uploads snapshots with the no-clobber conditional PUT, so
an existing remote name is an error. Snapshots are immutable everywhere. One pragmatic
exception: under `S3CAB_DEBUG` the *local* writer may overwrite — re-running within a
minute while debugging is otherwise maddening.

## Remote repository layout

One repository is one bucket, holding **multiple sets** (from any number of users and
machines). `objects/` is shared — content-addressing dedups across everything in the
bucket. The identity's `:` becomes a path level, so browsing groups by who-and-where,
then by set:

```
s3://my-backup-bucket/
  objects/<sha256>                              # every file, stored once, by content hash
  snapshots/<user>@<machine>/<set>/<name>.tsv.zst
```

```
  snapshots/
    allen@allen-pc/
      photos/
        2026-06-12T0915.tsv.zst
      docs/…
    kim@kim-laptop/
      photos/…
```

(`@` is legal in S3 keys; it sits in the "may require special handling" class, which is
accepted — it only surfaces as percent-encoding in URL contexts.)

**Remote snapshot files are byte-identical local snapshot files** — the `.tsv.zst` uploaded as-is.
One format everywhere; the upload is trivially verifiable; the recovery story is
identical to the local one (`zstd -d`, read the TSV).

### Non-goal: client-side encryption (decided 2026-06)

s3cab will **not** encrypt objects client-side. Encrypted objects are exactly the
opaque blobs the no-lock-in principle forbids, and encryption breaks content-addressed
dedup. The documented answer is server-side encryption (already sent on AWS), bucket
access policy, and provider trust — stated openly in user docs so it reads as a
decision, not a gap.

### Format invariant: objects first, snapshot last

**A snapshot's presence under `snapshots/` guarantees every object it references is
already present under `objects/`.** `backup` uploads all missing objects first and the
snapshot last, so the guarantee holds inductively from an empty bucket. Consequences:

- Any snapshot found in a bucket is trustworthy for `restore` and hand-recovery, and —
  because a snapshot spans its whole set — it certifies a **complete backup run of the
  set**, not of one directory.
- A crash mid-backup leaves only **orphan objects** (uploaded, referenced by no snapshot
  yet). Orphans are harmless: content-addressed, picked up by the retry (which skips
  re-uploading them), costing only their storage.
- `verify` polices the invariant after the fact (below).

This is a **repository-format guarantee**, documented to users, not a private
implementation detail.

## How `backup` computes the upload set

`backup` operates on a snapshot file, so **all hashes are already known — `backup`
never hashes a file**. (The snapshot-aware *hashing* skip — `upload.mjs`'s
`--if-modified-from` TODO — is `snapshot`-time machinery via `prop`'s `lookup`, not
`backup`'s concern.) The upload set scales with change size, not repo size:

1. Fetch **this set's latest remote snapshot** (one LIST of
   `snapshots/<user>@<machine>/<set>/`, one GET of a small file).
2. Candidates = hashes in the target snapshot **not** in the latest remote snapshot.
   (First backup of a set: no remote snapshot, everything is a candidate.)
3. Drop candidates found in the **per-bucket objects cache**: a local hash-per-line
   file in exactly the format `hashes -f` writes (it *is* that command's output put to
   work — composability again). The point is request arithmetic: per-object existence
   checks (HEAD, or the conditional PUT itself) cost one request *each*, which at
   millions of objects mounts up badly, while LIST pages 1,000 keys per request — so
   the listing is fetched rarely, cached locally, and consulted for free. `backup`
   appends every hash it uploads to the cache; refresh any time with `hashes -f`.
   `--skip-cache` skips this cache lookup entirely (when in doubt about sync) and falls
   through to the conditional PUT below. (The flag is named `--skip-cache`, not the
   `--force` this spec first used: it only skips the cache and never overwrites, unlike
   `upload --force`.)
4. Upload the remaining candidates with the conditional-PUT / no-clobber skip as the
   safety net — it silently no-ops objects that exist but were in neither the latest
   snapshot nor the cache (older snapshots, other sets/users/machines, a stale cache).
5. Upload the snapshot (the invariant's last step).

Cache staleness is **asymmetric**, and the design leans on that: an object *missing*
from the cache but present remotely is harmless (one redundant conditional PUT, which
no-ops). An object *present* in the cache but deleted remotely would let `backup` skip
a needed upload and break the invariant — but objects are only ever deleted by
`delete` + `cleanup`, which are manual, rare, and documented to refresh the cache
(`verify` catches any slip).

The diff trusts the invariant (latest remote snapshot ⇒ its objects exist). Ground-truth
checking is deliberately **not** `backup`'s job — it belongs to the admin pair below.
**`status`** is steps 1–2 run read-only ("what would a backup upload"), sharing the
machinery. It is **remote-only — there is no `--remote` flag** (decided at
implementation): `status` always compares the set's latest *local* snapshot against its
latest *remote* snapshot, so the flag would have no second mode to point at.

## Composability: porcelain composes plumbing

A deliberate design property, worth preserving as commands are added: every high-level
command is a thin coordination of lower-level pieces that are independently useful —
`backup` = `snapshot` + the snapshot-uploader; `status` = the uploader's diff with the
writes removed; `tree` = the snapshot's walk without the hashing. The composition
*medium* is the flat **hash-per-line stream** the `hashes` plumbing already emits: line
streams compose with each other and with ordinary Unix tools, which extends the
no-lock-in principle ([ADR-0002](../docs/adr/0002-no-lock-in-hard-constraint.md)) from recovery to *administration* — see below.

## `verify` and `cleanup` — two differences of the same two sets

Both admin commands compose the same two bucket-wide enumerations:

- **stored** — the hashes under `objects/` (exactly what the `hashes` command lists);
- **referenced** — the union of hashes in **every snapshot under `snapshots/`** (all
  sets, all users, all machines — objects are shared bucket-wide, so the *bucket*, not
  the set, is always the domain for both commands).

Then they are opposite set-differences:

| Command   | Computes            | A finding means                                          |
| --------- | ------------------- | -------------------------------------------------------- |
| `verify`  | referenced − stored | broken invariant: a snapshot references a missing object |
| `cleanup` | stored − referenced | orphaned objects: storage no snapshot needs              |

Because both inputs are hash-per-line streams, the whole computation is reproducible by
hand with `sort` and `comm` — even s3cab's heaviest maintenance operation needs no
s3cab. (Whether *referenced* gets its own plumbing command alongside `hashes` is
decided at implementation.)

### `cleanup` (object garbage collection)

`cleanup` deletes orphaned objects. It is deliberately heavy (reads every snapshot,
lists all of `objects/`) and deliberately rare — the everyday commands never delete
anything. Rules, several of which are **repository-format contract**, not implementation
choice:

- **Dry run by default.** `cleanup` *reports* the orphans and the space they hold; an
  explicit flag (e.g. `--delete`) is required to remove anything.
- **Grace window (format contract):** cleanup must never delete an object whose
  `LastModified` is younger than a generous threshold (e.g. 7 days). Under
  snapshot-last, an in-flight backup's uploaded-but-not-yet-referenced objects are
  indistinguishable from orphans; the grace window is what makes concurrent backups
  safe without locks. Any tool that deletes from `objects/` must honour it.
- **Known residual race (documented, accepted):** an *old* orphan (from a long-ago
  crashed backup) that a concurrently-running backup is relying on via the
  conditional-PUT skip can be deleted between the skip and the snapshot upload. The
  grace window does not cover it (the object is old). Locking would be over-engineering
  for this audience; instead: **don't run cleanup while a backup is running**, and
  cleanup's output says so. Do not "optimize away" the grace window or this warning.
- **Retention is the real driver.** The deletion *primitive* ships with this milestone
  (the `delete` command above); retention *policy* automation is deferred and will sit
  on top of it. Until snapshots get deleted, the only garbage is crash orphans —
  negligible. The name `cleanup` is consumer vocabulary on purpose (not `gc`/`prune`).
- **First command to need `DeleteObject`.** Everything else needs only Put/Get/List —
  keep it that way. Everyday backup credentials should not carry delete rights (limits
  the ransomware blast radius); cleanup runs under elevated ones. `setup`'s eventual
  policy helper should encode this split.
- **Versioned buckets (document only — decided):** s3cab neither requires nor manages
  bucket versioning / Object Lock. User docs will recommend enabling versioning as
  ransomware protection, and note the interplay: on a versioned bucket
  `delete`/`cleanup` create delete markers, so true reclamation needs a lifecycle rule.
  Revisit when cleanup is built.

**`verify` (decided):** the completeness check above plus a **size cross-check** against
the LIST metadata — list-requests only, no egress, safe to run routinely. A
download-everything `--deep` mode was considered and **rejected as impractical** (the
egress cost and time on a real backup rule it out). The practical route to "undamaged"
is server-side stored checksums (`GetObjectAttributes` against a checksum set at upload
time) — recorded as an open item.

## Open items (deferred, recorded here so they aren't lost)

- **Egress-free integrity for `verify`** — investigate S3 stored checksums: upload with
  a checksum algorithm, compare via `GetObjectAttributes`, no download. (Wrinkle:
  SHA-256 checksums are *composite* for multipart uploads; a full-object algorithm such
  as CRC64NVME may be the workable variant.)
- **Retention policy automation** — keep-last/daily/weekly/monthly rules on top of the
  `delete` primitive; design after real usage shows the shapes people need.
- **Interactive `setup` wizard** — explicitly post-milestone; the one-shot form plus
  good error messages is v1.
- **auth.md update** — the dir env layer becomes the set layer when implemented.
- **Doc updates at implementation** — README "How it works" (local layout moves to
  `~/.s3cab/sets/`), guide/exclude.md (per-set file), help topics; plus the
  versioning/ransomware recommendation and the encryption non-goal statement.

## Implementation plan

Five slices, in dependency order. Each slice is **one PR on its own branch, one commit
per step**, with tests and doc updates riding along; the tool stays fully working after
every slice. Within a slice the order is always: pure functions → filesystem/store →
commands → shared-machinery wiring.

### Slice 1 — Set primitives (local-only, no S3)

1. **`src/lib/sets.mjs`.** Pure parts first: `validateSetName` (reject + suggest a
   kebab form), `sanitizeNamePart` (user/machine). Then the store: paths under
   `~/.s3cab/sets/` via `homedir()` (testable with the auth tests' temp-home pattern:
   point `USERPROFILE`/`HOME` at a temp dir before import), read/write `dirs.txt` + the
   set `env`, namespace capture-and-pin, `resolveSet(name?)` (sole-set default; error
   listing sets). Co-located `sets.test.mjs`.
2. **`setup`** — promote the registry stub to `src/commands/setup.mjs`: create/update
   semantics, `--bucket`, the validation error UX (tests encode the agreed transcripts).
3. **`sets`** — new registry entry + command; its output formatter is shared with the
   several-sets error body.
4. **Set env layer** — `loadEnv({ set })` replaces the never-wired dir layer in
   `auth.mjs`; update its tests, this repo's auth docs (docs/specs/auth.md layer table +
   History note, [ADR-0015](../docs/adr/0015-standard-aws-credential-chain.md)).
5. **e2e + docs** — setup→sets round-trip in `test/e2e.test.mjs`; README status update
   (`setup`/`sets` become working local commands).

### Slice 2 — Local engine moves to sets

`snapshot`/`tree`/`list`/`compare` take `[<set>]`: multi-root walk; per-set
`exclude.txt`; `#DIR` header lines; snapshots into the set folder; the same-minute
error (+ `S3CAB_DEBUG` overwrite). `<dir>/.s3cab/` retires — the biggest user-visible
change, so README "How it works", guide/exclude.md, help topics, the repo's own dogfood
config, and test fixtures all move in this PR.

### Slice 3 — `backup` + `status` (the milestone) — **built (2026-06-13, PR #39)**

S3 test strategy (decided): S3-touching code is covered by **gated integration tests
against a real bucket** (`S3CAB_TEST_BUCKET`, skipped with a message when unset) rather
than by mocking the `s3.mjs` boundary; the pure diff/cache logic gets ordinary unit
tests. (Standing up the test bucket + CI credentials is a separate task.) Built
bottom-up: remote-snapshot listing for a namespace → the snapshot-diff function
(`uploadCandidates`) → the per-bucket objects cache (read/append/`--skip-cache`) → the
uploader loop (conditional PUTs, snapshot-last) → `backup` porcelain (snapshot + upload)
→ `status` (read-only diff, remote-only — no `--remote` flag) → `list --remote`. Plus
fail-fast bucket-name validation in `setup` (a plain single-segment name, not an `s3://`
URL or path — deferred from PR #33 review). The cache-skip flag is `--skip-cache`, not
the `--force` first written above (clearer, and it never overwrites like `upload --force`).

### Slice 4 — `restore` + adoption

Restore semantics as specified (skip-existing default, `--overwrite`, `--output`
per-root-basename mapping with clash detection, `paths…` filters, mtime restoration);
`setup --from` adoption; `compare --remote`.

**Built (PR #44):** `restore` to original locations — skip-existing default + `--overwrite`,
`--snapshot <name>`, `paths…` prefix filters (`selectEntries`), per-object SHA-256
verification on download (`getObject`, in `objects.mjs`), download-once/copy for repeated content, and
mtime restoration. `setup --from` adoption pins a given remote namespace and binds the
bucket, verifying the namespace has a backup (listing the bucket's namespaces on a typo via
`listRemoteNamespaces`); `setup` is now uniformly async. `--output` re-rooting **is now
built** (`parseSnapshotStream` surfaces the `#DIR`/`#SNAPSHOT` headers it used to drop;
`readRemoteSnapshot` returns the whole `Snapshot`, and `reroot` maps each member dir
under `<output>/<basename>/…`, rejecting basename clashes up front). **Still deferred from
this slice:** `compare --remote` (still a `notImplemented()` stub).

### Slice 5 — Admin pair

`verify` (completeness + size cross-check), `delete` (snapshot removal + cache-refresh
reminder), `cleanup` (dry-run default, `--delete`, grace window, the documented race
warnings), and the versioning/ransomware + encryption-non-goal doc notes.

**Why this order:** slices 1–2 keep the tool fully working locally at every point;
3 delivers the README's promise; 4 makes it trustworthy (a backup you can't restore
isn't one); 5 makes it maintainable long-term. Starting anywhere else builds against
machinery that doesn't exist yet (slice 2 needs the set store; slice 3 needs sets to
upload; slice 4 needs backups to restore).
