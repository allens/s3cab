# `s3cab` Backup Sets and Remote Repository Design

## Status

Designed (2026-06-12), **implementation in progress**. Slices 1–4 are built. Slice 1 gave the set store (`src/lib/sets.mjs`), the set-management
command (now split into `setup` + `list`, [ADR-0036](../adr/0036-setup-mutates-list-shows-drop-sets.md)),
and the set env layer in auth; slice 2 moved the local engine onto sets —
`snapshot`/`list`/`compare`/`tree` take `[<set>]`, walk every member dir with the set's
`exclude.txt`, write one snapshot (with `#SNAPSHOT` identity + `#DIR` headers) into
`~/.s3cab/sets/<set>/snapshots/`, and `<dir>/.s3cab/` has retired. Slice 3 (PR #39) built
the `snapshots/` remote half and the cloud porcelain: the remote repository engine
(`src/lib/remote.mjs` — remote-snapshot listing/read, the upload-set diff
`uploadCandidates`, the snapshot-last `uploadSnapshot`), plus `backup`, `status`, and
`list --remote`. The `objects/<sha256>` half of the remote layout — `putObject` / verified
`getObject` / `listObjectHashes` — is owned by
`src/lib/objects.mjs` (extracted 2026-06-17 from where it had been scattered across
`remote.mjs`/the plumbing commands; its lister is the `hashes` command — renamed from
`objects` to free the name — and `upload` its writer). Slice 4's restore path (PR #44)
added `restore` (`src/commands/restore.mjs`, on the verified `getObject`) and machine
succession (`setup --inherit`, via the remote `sets/<set>/` marker). `restore --output`
re-rooting is now built too (`parseSnapshotStream` surfaces the `#DIR`/`#SNAPSHOT` headers it
used to drop; `reroot` in `restore.mjs` maps each member dir under `<output>/<basename>/…`).
**Slice 5 is complete** — `verify` (`src/commands/verify.mjs` over `referencedObjects` in
`remote.mjs`, `listStoredObjects` in `objects.mjs`, and the pure diff in
`src/lib/verify.mjs`), `delete` (`src/commands/delete.mjs` over `deleteRemoteSnapshot`, with
`src/lib/prompt.mjs`'s TTY-gated y/N confirm), and `cleanup` (`src/commands/cleanup.mjs` over
`deleteStoredObject`, computing missing/damaged/orphan tallies directly from the same two
enumerations as `verify` — the opposite `stored − referenced` difference; it works at hash
level, so it needs none of verify's per-path problem model). Remaining are the
versioning/ransomware user-doc note and the everyday-vs-elevated delete-rights policy split
(both deferred, tracked in "Open items"). (`compare --remote` was *dropped*,
not built — [ADR-0027](../adr/0027-compare-local-only-adoption-syncs-manifests.md): `compare`
stays local-only, and `setup --inherit` instead syncs the set's manifests down so local
`compare` works on a fresh machine.)

On top of those original slices, the **2026-06-20 redesign has fully landed** (set name = whole
identity, flattened `snapshots/<set>/`, the `setup` collision check + `--inherit`, the
`sets/<set>/` marker, bucket-required set creation, and the single-tier set resolver) —
[ADR-0024](../adr/0024-set-name-is-the-whole-identity.md),
[ADR-0025](../adr/0025-drop-per-bucket-env-layer.md), and
[ADR-0026](../adr/0026-bucket-required-at-setup.md). The detail sections below describe that
landed model.

> **History:** the first cut of this design (same day) namespaced remote snapshots by a
> per-directory stored label, keeping the local engine per-directory. It was superseded
> within hours by the **backup set** model below, because a set name solves the identity
> problem outright: directories become the *contents* of a set rather than its identity,
> so renaming a machine or moving a directory edits a config file instead of forking the
> backup history. Decisions that survived unchanged: byte-identical snapshots and the
> snapshot-last invariant. (The upload set's baseline was later changed too — from
> diff-vs-latest-*remote* to diff-vs-**local**-previous plus the dropped objects cache —
> [ADR-0045](../adr/0045-change-detection-local-baseline-list-fallback.md).) A second reshape
> (2026-06-20) then made the set **name** the whole identity — dropping the `user@machine`
> component the sections below once carried — flattened the remote to `snapshots/<set>/`, and
> required a bucket at `setup`.

## Purpose

Define s3cab's unit of backup (the **backup set**), its on-disk configuration, the
remote repository format, and the behaviour of the `setup`/`list`/`backup` commands. Format
decisions are commitments: per [ADR-0002](../adr/0002-no-lock-in-hard-constraint.md) (no lock-in), the stored layouts —
local *and* remote — are the contract a hand-recoverer or replacement tool relies on,
written down as the **format spec**, [guide/format.md](../../guide/format.md). This design
doc carries the *why* behind that contract, and the command behaviour on top of it.

Guiding instinct throughout: **simple, obvious, accessible, discoverable.** Every config
artifact is a self-evident plain-text file a user can find by listing a directory and
understand by opening it.

## The backup set

A **backup set** is a named list of directories that snapshot, back up, and restore as
one unit — the consumer mental model ("my photos" = two directories on two drives). It is
the operand of every porcelain command.

A set's **name** is its entire identity (e.g. `photos`) — one user-chosen `[a-z0-9-]+`
label that is at once the local handle, the local directory name under `~/.s3cab/sets/`, and
the remote namespace under `snapshots/` and `sets/`. There is no `user@machine` component
([ADR-0024](../adr/0024-set-name-is-the-whole-identity.md)).

- The anchor is **"a user and their data,"** not a machine. Machine isn't how a person
  thinks about their backup, and baking it into the identity would fork the history on a
  host rename or replacement. Renaming a machine or moving a member directory edits `dirs.txt`
  — it never touches identity.
- **Bucket-wide uniqueness is "first person wins,"** enforced by a setup-time collision
  check against the remote `sets/<name>/` marker (see "Remote repository layout"). The
  marker carries an advisory "created-on `<machine>`" field, surfaced only in the collision
  error to help a human choose rename-vs-`--inherit` — advisory, never part of the identity.
- **Charset (decided):** a name is lowercase `a-z`, `0-9`, and `-` — nothing else, so
  nothing downstream ever needs escaping. `validateSetName` is the keystone guard: it
  rejects a non-conforming name with the rule and a suggested kebab-case form (the name is
  user-chosen, so teach the rule rather than silently normalize), which keeps the single
  name clean as handle, path segment, and remote key with zero escaping anywhere.
- The identity is informational for recovery, not load-bearing: snapshots internally
  record the set name *and* their member directories (see header), so a recoverer can
  always learn what a namespace is by opening one snapshot.

### On disk: one directory per set

(The layout is contract — stated in the [format spec](../../guide/format.md); the small
diagram is repeated here because the design points below lean on it.)

```
~/.s3cab/
  env                    # per-user defaults + auth      (existing auth layer)
  sets/
    photos/
      dirs.txt           # member directories, one absolute path per line
      env                # S3CAB_BUCKET=… + any per-set auth overrides
      exclude.txt        # optional; patterns applied relative to each member dir
      snapshots/
        2026-06-12T0915.tsv.zst
```

- **The files are the API.** Editing a set = opening `dirs.txt`/`env`/`exclude.txt` in
  any editor; deleting the directory deletes the set. No structured config format, no
  management subcommands to keep honest with the files.
- The set's `env` is the **set layer** in the env layering (env.mjs): precedence is
  **set → user → shell** ([ADR-0025](../adr/0025-drop-per-bucket-env-layer.md) dropped the
  former per-bucket layer). It pins `S3CAB_BUCKET` (the bound bucket — every set has one,
  [ADR-0026](../adr/0026-bucket-required-at-setup.md)) plus any per-set auth override; the
  name is the identity, so there is nothing else to pin.
- **`<dir>/.s3cab/` retires entirely** — snapshots and excludes no longer live inside
  backed-up directories.
- `exclude.txt` keeps today's pattern semantics (see guide/exclude.md), applied relative
  to **each** member directory.

## CLI surface

Porcelain is **set-first**: `snapshot`, `list`, `compare`, `backup`, `restore`,
`status`, and `tree` all take `[<set>]`, which **defaults to the only set**
when exactly one exists — so after setup, plain `s3cab backup` just works. When several
sets exist and none is named, the error lists them. `tree [<set>]` becomes "exactly what
a snapshot of this set would include", sharpening its diagnostic role. The **admin pair**
`verify` and `cleanup` sits *outside* the set-first surface — both take a `<bucket>`
operand (they operate on a whole repository; see their section and
[ADR-0042](../adr/0042-verify-bucket-operand.md)), as do the file/bucket diagnostics
(`prop`, `hashes`, `upload`).

### `setup` — create, update, inherit a set

`s3cab setup` is the set-**mutation** verb ([ADR-0036](../adr/0036-setup-mutates-list-shows-drop-sets.md)):
it creates, updates, or inherits a backup set. (Listing what you have is `list`'s job — the
read/write split that ADR-0036 made.)

```
s3cab setup <set> <dir>... --bucket <bucket>
s3cab setup <set> --inherit --bucket <bucket>
```

**`--bucket` is required** ([ADR-0026](../adr/0026-bucket-required-at-setup.md)): a set is
bound to its bucket at creation, and creating a set always touches S3 to run the collision
check — there are **no** bucket-less, local-only sets. (Offline `snapshot`/`compare`/`tree`/`list`
still work after a one-time online set-up; only creating or updating a set needs
connectivity.) The three modes:

- **Create** (`setup <name> <dir>... --bucket <b>`): collision-check the remote
  `sets/<name>/` marker; if it already exists, error naming the owning machine and
  suggesting `--inherit`; otherwise claim the marker (a conditional PUT — first writer wins),
  write the local set, and publish its `dirs.txt`/`exclude.txt` to the marker.
- **Inherit / succession** (`setup <name> --inherit --bucket <b>`): the path for a
  replacement or recovery machine. Requires `sets/<name>/` to exist remotely; pulls its
  `dirs.txt`/`exclude.txt`, recreates the local set, and re-stamps the owning machine. Takes
  no directories (they come from the remote). For machine retirement/replacement or DR only.
- **Update** (`setup <name> [<dir>...]` on a set you already have): refresh the member
  directories and re-publish the config; the bucket is fixed at creation (re-binding to a
  different bucket — migration — isn't supported yet). **Remote-first**, mirroring create:
  push the config *then* commit the local write, so a credentials failure mid-update leaves
  local no further ahead than the cloud. The guarantee is convergence (re-running `setup`
  reconciles), not strict transactional atomicity.

Two live machines on one set is a discouraged-but-tolerated power-user case (e.g. a
OneDrive-synced directory, where both hold the same content so the interleaving is benign):
`--inherit` never disables the prior machine — re-stamping the owner is its only remote
change. An interactive wizard may later wrap this one-shot form; it is not part of v1.

### `list` — show sets and their snapshots

`s3cab list` is the **read** counterpart ([ADR-0036](../adr/0036-setup-mutates-list-shows-drop-sets.md)) —
the discoverability counterpart of "files are the API", and what the resolve-a-set error
messages point at. With **no set named** it lists every set compactly (name + snapshot times),
so a single-set user's plain `s3cab list` is still their snapshots:

```
> s3cab list
docs:
  2026-05-12T0946
photos:
  2026-06-12T0915
  2026-06-11T0915
```

With a set **named** it switches to a detail view — the set's bucket, member directories, and
exclude file, each shown with the config-file path that holds it (so the listing doubles as
"where do I edit this set"), then its snapshots:

```
> s3cab list photos
name: photos
bucket: my-backup-bucket
dirs (~/.s3cab/sets/photos/dirs.txt):
  C:\Users\me\Photos
  D:\Pics
exclude file: ~/.s3cab/sets/photos/exclude.txt
snapshots:
  2026-06-12T0915
  2026-06-11T0915
```

`--latest` narrows the snapshot list to the newest. `--remote` lists one set's cloud backups
under `snapshots/<set>/` — a **single** set (the sole-set default), since it is a network call
carrying that set's auth, unlike the offline all-sets default.

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
"I deleted a directory" case both just work, and a careless restore can't destroy newer
work. `--snapshot <name>` picks the source snapshot (default: the latest remote);
positional `paths…` filter what is restored. Restored files get their snapshot **mtime**
(required — the snapshot diff depends on mtimes).

`--output <dir>` re-roots instead: each member dir's contents restore relative to it
under `output\<root-basename>\` — shallow and human-readable. Two roots sharing a
basename is detected up front and errors with guidance (rare, actionable).

### `delete` — remove one remote snapshot (**built**)

`s3cab delete <set> --snapshot <name>` removes a single remote snapshot — the retention
*primitive*. It deletes only the snapshot; reclaiming the objects only it referenced is
`cleanup`'s job (the command's output says so). It never touches `objects/`. On a TTY it confirms
with a y/N prompt naming the snapshot and set — the same confirmation pattern as
`cleanup --delete`; non-interactive runs proceed on the explicit flag. Retention
*policy* (keep the last 12 monthlies, …) comes later, on top of this primitive. (Local
snapshots need no command: the files are the API — delete the file.)

## Snapshot files

The file grammar — the `#SNAPSHOT`/`#DIR` header, the TSV rows, the metadata-row types —
is the format spec's to state ([guide/format.md](../../guide/format.md)). The decisions
behind it:

**One snapshot per set per run** — all member directories in a single TSV (the line
format is multi-root-safe: paths are absolute). This buys cross-directory move/dedup
detection in `compare` and makes the snapshot-last invariant a **set-level** atomicity
guarantee; the header naming the set and its member dirs as captured at snapshot time is
what makes the file self-describing even found alone in a bucket.

**Scope: regular files only (decided 2026-06).** A deliberate product-scope decision, not
an accident of implementation: s3cab is **not a system backup tool** (commercial tools, OS
built-ins, and git all serve that need). It exists for a user to back up their documents,
pictures, and video efficiently, where what matters is that **the content is recoverable**.
Content, size, and mtime are the contract; everything else is out of scope, stated to
users in the format spec.

**Snapshot names: collisions error, snapshots never overwrite.** Names stay
minute-precision local timestamps. A second snapshot of the same set in the same minute is
an **error**, not an overwrite — unlikely in real use, and an accidental double-run (a
scheduler firing twice) must not destroy a snapshot. Remotely the same rule is enforced by
the no-clobber conditional PUT. One pragmatic exception: under `S3CAB_DEBUG` the *local*
writer may overwrite — re-running within a minute while debugging is otherwise maddening.

## Remote repository layout

The layout itself — `objects/<sha256>`, `snapshots/<set>/`, `sets/<set>/` and what each
holds — is the format spec's to state ([guide/format.md](../../guide/format.md)). The
decisions behind its shape:

One repository is one bucket, holding **multiple sets** (from any number of users and
machines). `objects/` is shared — content-addressing dedups across everything in the
bucket. Each set name is a path level under `snapshots/` (its snapshots) and `sets/` (its
config + ownership marker), so browsing groups by set.

Snapshots are **directory-per-set** (`snapshots/<set>/…`), not a flat
`snapshots/<set>-<timestamp>` — a `-`-bearing key can't be split back into (set, timestamp)
and would prefix-collide with another set (`work-laptop` vs `work-laptop-backup`). The set
name is a single `[a-z0-9-]+` segment, so it needs no escaping anywhere in these keys.

The `sets/<set>/` marker is written when a set is created: `info` (the atomic claim token + advisory
owner/created fields) doubles as the collision-registration marker — a set with no snapshots
yet would otherwise be invisible — and `dirs.txt`/`exclude.txt` are pushed for the
**full-DR** story (point a fresh machine at the bucket, `--inherit`, and the set config comes
back; only credentials need re-entering). The set's `env` is **never** pushed (it holds
credentials); the bucket name is not stored (redundant once in the bucket).

**Remote snapshot files are byte-identical local snapshot files** — the `.tsv.zst` uploaded as-is.
One format everywhere; the upload is trivially verifiable; the recovery story is
identical to the local one.

### Non-goal: client-side encryption (decided 2026-06)

s3cab will **not** encrypt objects client-side. Encrypted objects are exactly the
opaque blobs the no-lock-in principle forbids, and encryption breaks content-addressed
dedup. The documented answer is server-side encryption (already sent on AWS), bucket
access policy, and provider trust — stated openly in the format spec so it reads as a
decision, not a gap.

### Format invariant: objects first, snapshot last

**A snapshot's presence under `snapshots/` guarantees every object it references is
already present under `objects/`** — a repository-format guarantee, stated to users in the
format spec, not a private implementation detail. `backup` uploads all missing objects
first and the snapshot last, so the guarantee holds inductively from an empty bucket.
Consequences the design leans on:

- Any snapshot found in a bucket is trustworthy for `restore` and hand-recovery, and —
  because a snapshot spans its whole set — it certifies a **complete backup run of the
  set**, not of one directory.
- A crash mid-backup leaves only **orphan objects** (uploaded, referenced by no snapshot
  yet). Orphans are harmless: content-addressed, picked up by the retry (which skips
  re-uploading them), costing only their storage.
- `verify` polices the invariant after the fact (below).

## How `backup` computes the upload set

`backup` operates on a snapshot file, so **all hashes are already known — `backup`
never hashes a file**. (The snapshot-aware *hashing* skip — `upload.mjs`'s
`--if-modified-from` TODO — is `snapshot`-time machinery via `prop`'s `lookup`, not
`backup`'s concern.) The change-detection model
([ADR-0045](../adr/0045-change-detection-local-baseline-list-fallback.md)) makes the
upload set scale with change size, not repo size. `backup` (porcelain) picks the
baseline and hands it to the `uploadSnapshot` plumbing:

1. **Baseline = the set's previous *local* snapshot.** The set-ownership model makes local
   history authoritative: a set is owned by exactly one machine (the `sets/<name>/` marker;
   `--inherit` *re-stamps* the owner, it never shares), so there is no other machine whose
   uploads the local history wouldn't already know about. Its objects were stored when it
   was uploaded (the snapshot-last invariant), so anything it references can be skipped with
   **no network read**.
2. Candidates = hashes in the target snapshot **not** in that baseline (content-keyed, so a
   file that only moved or was renamed is not re-uploaded).
3. **First backup (no previous local snapshot):** there is no baseline, so **LIST the
   object store once** (`objects/`) and diff the target against what is already there.
   Announced with `Scanning existing objects…` on stderr, since a large store can take a
   moment. This is the batch existence-check — one paged LIST (1,000 keys/request) instead
   of a per-object HEAD — done exactly when there is nothing local to diff against.
4. Upload the candidates with the **conditional-PUT / no-clobber** skip as the correctness
   backstop — it silently no-ops any object already present that the baseline missed (older
   snapshots, other sets/users in the shared bucket). **Correctness never rides on the
   baseline**; the baseline is purely a round-trip optimization.
5. Upload the snapshot (the invariant's last step).

**Why the local previous snapshot, and not a persistent objects cache?** An earlier design
narrowed the set with a **per-bucket objects cache** (`~/.s3cab/objects.<bucket>`) on top of
the diff-vs-latest-*remote* snapshot. That cache was **dropped**
([ADR-0045](../adr/0045-change-detection-local-baseline-list-fallback.md)): it never changed
*what* uploaded (the conditional PUT already prevents any wasted upload), only saved
round-trips; yet it was the one component that could be **poisoned** — a cached-but-absent
entry silently skips a needed upload — which is why `verify`/`cleanup` used to carry
cache-healing machinery. The single-owner model makes the local previous snapshot the
authoritative baseline with none of that risk, and its one real benefit (batch-checking many
objects at once) survives as the stateless first-backup LIST above.

The diff trusts the invariant (a prior snapshot ⇒ its objects exist). Ground-truth checking
is deliberately **not** `backup`'s job — it belongs to the admin pair below. **`status`** is
the read-only "what would a backup upload" estimate; it compares the set's latest *local*
snapshot against its latest *remote* snapshot (a property of the two snapshots that reads the
same on any machine, hence remote rather than the local baseline `backup` uses). It is
**remote-only — there is no `--remote` flag** (decided at implementation): the flag would
have no second mode to point at.

## Composability: porcelain composes plumbing

A deliberate design property, worth preserving as commands are added: every high-level
command is a thin coordination of lower-level pieces that are independently useful —
`backup` = `snapshot` + the snapshot-uploader; `status` = the uploader's diff with the
writes removed; `tree` = the snapshot's walk without the hashing. The composition
*medium* is the flat **hash-per-line stream** the `hashes` plumbing already emits: line
streams compose with each other and with ordinary Unix tools, which extends the
no-lock-in principle ([ADR-0002](../adr/0002-no-lock-in-hard-constraint.md)) from recovery to *administration* — see below.

## `verify` and `cleanup` — two differences of the same two sets

Both admin commands compose the same two enumerations:

- **stored** — the hashes under `objects/` (exactly what the `hashes` command lists),
  always bucket-wide: one LIST returns every key *and its size* far cheaper than per-key
  existence checks ever could, so even a single-set check enumerates the whole store;
- **referenced** — the union of hashes in snapshots under `snapshots/`, **bucket-wide**
  for both commands. For `cleanup` it **must** span every set, all users, all machines
  (objects are shared bucket-wide; deleting on less than the whole truth would eat another
  set's data). `verify` reads the same bucket-wide union — the `objects/` LIST is paid
  whichever way, so a bucket operand costs the same as a single set and is the honest unit
  ([ADR-0042](../adr/0042-verify-bucket-operand.md)) — but **groups it by set** so it can
  still answer "is *this backup* restorable?" per set in its report.

Then they are opposite set-differences:

| Command   | Computes            | A finding means                                          |
| --------- | ------------------- | -------------------------------------------------------- |
| `verify`  | referenced − stored | broken invariant: a snapshot references a missing object |
| `cleanup` | stored − referenced | orphaned objects: storage no snapshot needs              |

Because both inputs are hash-per-line streams, the whole computation is reproducible by
hand with `sort` and `comm` — even s3cab's heaviest maintenance operation needs no
s3cab. (*Referenced* is a lib function only, **not** a plumbing command — decided
2026-07-03: the hand-recovery contract is already met by the snapshot files themselves
(`zstdcat snapshots/*/*.tsv.zst | cut -f1 | sort -u`), and its two callers, `verify` and
`cleanup`, are internal. A CLI face is one registry entry away the day someone wants the
stream.)

### `cleanup` (object garbage collection) — settled 2026-07-03 (**built**)

`cleanup <bucket>` deletes orphaned objects. It is deliberately heavy (reads every
snapshot, lists all of `objects/`) and deliberately rare — the everyday commands never
delete anything. Rules, several of which are **repository-format contract** (stated in
the [format spec](../../guide/format.md)), not implementation choice:

- **The operand is the bucket, not a set.** Cleanup sits *beyond* sets: orphanhood is a
  repository-level fact, and — decisively — the per-set env layer deliberately carries
  the least-privilege everyday identity, exactly the credentials cleanup must *not* run
  under. Taking the bucket directly (the `hashes`/`upload` pattern) resolves credentials
  through user env / shell / standard chain, where the elevated identity lives. Consumer
  vocabulary governs the *name* ([ADR-0012](../adr/0012-consumer-vocabulary-naming.md));
  the operand follows the domain.
- **Dry run by default; `--delete` is single-pass.** Bare `cleanup <bucket>` *reports*
  the orphans and the space they hold. `--delete` computes once, prints the same report,
  confirms with y/N on a TTY (non-interactive runs proceed on the explicit flag), and
  deletes from memory — no second enumeration. These y/N confirmations (here and on
  `delete`) are **s3cab's first interactive prompts** — deliberate: the destructive pair
  earns them, and they follow clig.dev's rules — TTY-gated, never blocking a script, and
  never *required* (the explicit flag is the non-interactive answer). (A persisted
  **runlist** — dry-run saves
  the orphan list, a later run executes it — was considered and **rejected**: a new
  backup can re-reference an old orphan via the conditional-PUT skip, so a stale list
  deletes live data. A revalidation based on snapshot immutability — re-read only
  snapshots newer than the list — is sound but unnecessary once the prompt makes
  check-then-do a single pass.)
- **Grace window: 7 days, fixed (format contract):** cleanup must never delete an object
  whose `LastModified` is younger than 7 days (the [format spec](../../guide/format.md)
  states the rule). Under snapshot-last, an in-flight backup's
  uploaded-but-not-yet-referenced objects are indistinguishable from orphans; the grace
  window is what makes concurrent backups safe without locks. Any tool that deletes from
  `objects/` must honour it. No tuning knob: a `--grace` foot-gun buys nothing, and
  loosening a fixed floor later is additive.
- **Damage interlock:** an **unreadable snapshot aborts both modes** — its references
  are unknown, so every object only it references would masquerade as an orphan (the
  report's numbers would be lies). **Missing objects** (verify's core finding) are
  reported, and `--delete` **refuses**: the repository is already losing data — triage
  with `verify` first, then clean up. No `--force` override until a real need appears.
  (Wrong-size objects only warn and point at `verify`; orphanhood is hash-level.)
- **No local state to reconcile:** cleanup reclaims only orphans (`stored − referenced`
  across every set), so a valid snapshot's objects are never deleted — and with the
  per-bucket objects cache gone
  ([ADR-0045](../adr/0045-change-detection-local-baseline-list-fallback.md)), there is no
  local presence-cache left to poison or heal. Every machine's next `backup` re-derives what
  to skip from its own local snapshots (and, on a first backup, a fresh LIST), so cleanup
  needs no cross-machine "run verify first" reminder. `--delete`'s only stderr note is the
  race below.
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
  the ransomware blast radius); cleanup runs under elevated ones. The `aws` command's
  policy helper should encode this split.
- **Versioned buckets (document only — decided):** s3cab neither requires nor manages
  bucket versioning / Object Lock. User docs will recommend enabling versioning as
  ransomware protection, and note the interplay: on a versioned bucket
  `delete`/`cleanup` create delete markers, so true reclamation needs a lifecycle rule.
  Revisit when cleanup is built.

### `verify` (settled 2026-07-03, **built**)

The completeness check above plus a **size cross-check** against the LIST metadata —
list-requests only, no egress, safe to run routinely. A download-everything `--deep` mode
was considered and **rejected as impractical** (the egress cost and time on a real backup
rule it out). The practical route to "undamaged" is server-side stored checksums
(`GetObjectAttributes` against a checksum set at upload time) — recorded as an open item.

`verify <bucket>` takes the **bucket** as its operand — the read-only twin of
`cleanup`, checking a whole repository in one run under one credential resolved through
the standard chain (not per-set env). Set-scoping was considered and dropped
([ADR-0042](../adr/0042-verify-bucket-operand.md)): the `objects/` LIST is paid whichever
way (it is the only meaningful cost), so a set operand saves no work — only a few snapshot
GETs — while an all-sets default over sets in different buckets snags on the additive-env
/ single-client seam. The bucket operand dissolves both. Findings are still reported **per
set**: `referencedObjects` groups the bucket's snapshots by the set that owns them, so the
report answers "is *this backup* restorable?" per set even though you named a bucket.

**Findings are file-centric** — a flat, per-set **`problems`** list plus any
**unreadable snapshots**, all computed from the two enumerations already in hand (zero
extra requests). The check runs per referenced *path* (a hash under many paths yields many
rows) so the model is 1:1 with what a user restores; **hashes never surface**, and the
`--json` and human views share the one shape (ADR-0042, ADR-0043). Two
problem kinds:

1. **`missing`** — the file's content hash is absent from `objects/`: the broken
   objects-first/snapshot-last invariant, the serious one (that file can't be restored).
   Every path referencing a missing hash is a row — all affected files, no grouping.
2. **`wrong-size`** — the object is stored, but this file's recorded size ≠ the stored
   LIST `Size`: a truncated/overwritten object, or a torn manifest row. Checked **per
   file against the one real stored size** — so two files that share content but record
   different sizes (the old "conflicting rows") surface as a wrong-size problem on exactly
   the file(s) that disagree with storage. No ambiguous-size skip, no separate conflict
   category: a genuinely wrong recorded size can no longer hide. (Objects are stored raw,
   so recorded and stored sizes are directly comparable; both sizes ride the row.)

**Unreadable snapshots** stay *outside* `problems` (they aren't file-shaped — a corrupt
manifest has no file list to annotate, only a lost restore point). A snapshot that fails
to decompress or parse is a *finding*, and verify **continues** (dying on the first damage
would hide the rest); an S3 *request* failure (network/auth/throttle) is an ordinary
operational error and aborts.

**Report and exit:** the JSON result (ADR-0010 house style) is `{ bucket, sets }` — for each
set, snapshots and referenced objects checked, that set's `problems` list (path, problem
kind, referencing snapshot(s), and recorded/stored sizes for a wrong-size), and its
unreadable snapshots. **Orphans are not reported here.** Objects no snapshot references
(`stored − referenced`) are a *reclamation* concern, not an *integrity* one — they can't
threaten restorability — so orphan reporting lives in `cleanup`'s non-destructive mode
(above), where the unreadable-snapshot caveat is a hard safety gate rather than the
advisory `orphanObjectsExact` upper-bound flag it once was in verify. That move is why
verify's result no longer carries a stored-object total or an orphan count (ADR-0042,
`cloud-cleanup.md`). **Exit 1 when any set has findings** (0 = verified clean; 2 stays bad
input), so `s3cab verify <bucket> || alert` is the cron idiom — no dedicated exit code until
a script actually needs to distinguish "damaged" from "check failed".

**Remote read-only, no side effects:** verify never writes to the bucket — it runs on
List+Get credentials alone — and keeps no local state. (It used to rewrite a per-bucket
objects cache from the completed LIST; that cache was dropped with the change-detection
simplification, so there is nothing local left to heal —
[ADR-0045](../adr/0045-change-detection-local-baseline-list-fallback.md).) Its whole
result is the per-set findings report.

**Ordering invariant:** read the snapshots **before** LISTing `objects/`. In that order
a backup finishing mid-run only adds unreferenced objects (harmless — verify ignores
unreferenced storage); the reverse order would report its freshly-uploaded objects as
missing.

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
  versioning/ransomware recommendation. (The encryption non-goal statement is done —
  it lives in the format spec.)

## Implementation plan

Five slices, in dependency order. Each slice is **one PR on its own branch, one commit
per step**, with tests and doc updates riding along; the tool stays fully working after
every slice. Within a slice the order is always: pure functions → filesystem/store →
commands → shared-machinery wiring.

### Slice 1 — Set primitives (local-only, no S3)

1. **`src/lib/sets.mjs`.** Pure parts first: `validateSetName` (reject + suggest a
   kebab form), `sanitizeNamePart` (the name-suggestion helper). Then the store: paths under
   `~/.s3cab/sets/` via `homedir()` (testable with the auth tests' temp-home pattern:
   point `USERPROFILE`/`HOME` at a temp dir before import), read/write `dirs.txt` + the
   set `env` (which binds the bucket), `resolveSet(name?)` (sole-set default; error
   listing sets). Co-located `sets.test.mjs`. (The 2026-06-20 redesign later made the set
   name the whole identity, so the original `user@machine` capture-and-pin is gone.)
2. **`setup`** — promote the registry stub to `src/commands/setup.mjs`: create/update
   semantics, `--bucket`, the validation error UX (tests encode the agreed transcripts).
3. **`sets`** — new registry entry + command; its output formatter is shared with the
   several-sets error body.
4. **Set env layer** — `loadEnv({ set })` replaces the never-wired dir layer in
   `auth.mjs`; update its tests, this repo's auth docs (docs/design/auth.md layer table +
   History note, [ADR-0015](../adr/0015-standard-aws-credential-chain.md)).
5. **e2e + docs** — setup→sets round-trip in `test/e2e.test.mjs`; README status update
   (`setup`/`sets` become working local commands).

### Slice 2 — Local engine moves to sets

`snapshot`/`tree`/`list`/`compare` take `[<set>]`: multi-root walk; per-set
`exclude.txt`; `#DIR` header lines; snapshots into the set directory; the same-minute
error (+ `S3CAB_DEBUG` overwrite). `<dir>/.s3cab/` retires — the biggest user-visible
change, so README "How it works", guide/exclude.md, help topics, the repo's own dogfood
config, and test fixtures all move in this PR.

### Slice 3 — `backup` + `status` (the milestone) — **built (2026-06-13, PR #39)**

S3 test strategy (decided): S3-touching code is covered by **gated integration tests
against a real bucket** (`S3CAB_TEST_BUCKET`, skipped with a message when unset) rather
than by mocking the `s3.mjs` boundary; the pure diff/cache logic gets ordinary unit
tests. (Standing up the test bucket + CI credentials is a separate task.) Built
bottom-up: remote-snapshot listing for a namespace → the snapshot-diff function
(`uploadCandidates`) → the per-bucket objects cache (read/append/`--skip-cache`; **later
removed** — [ADR-0045](../adr/0045-change-detection-local-baseline-list-fallback.md)) → the
uploader loop (conditional PUTs, snapshot-last) → `backup` porcelain (snapshot + upload)
→ `status` (read-only diff, remote-only — no `--remote` flag) → `list --remote`. Plus
fail-fast bucket-name validation in `setup` (a plain single-segment name, not an `s3://`
URL or path — deferred from PR #33 review). The cache-skip flag is `--skip-cache`, not
the `--force` first written above (clearer, and it never overwrites like `upload --force`).

### Slice 4 — `restore` + adoption

Restore semantics as specified (skip-existing default, `--overwrite`, `--output`
per-root-basename mapping with clash detection, `paths…` filters, mtime restoration);
fresh-machine adoption; `compare --remote`.

**Built (PR #44):** `restore` to original locations — skip-existing default + `--overwrite`,
`--snapshot <name>`, `paths…` prefix filters (`selectEntries`), per-object SHA-256
verification on download (`getObject`, in `objects.mjs`), download-once/copy for repeated content, and
mtime restoration; `setup` is now uniformly async. `--output` re-rooting **is now
built** (`parseSnapshotStream` surfaces the `#DIR`/`#SNAPSHOT` headers it used to drop;
`readRemoteSnapshot` returns the whole `Snapshot`, and `reroot` maps each member dir
under `<output>/<basename>/…`, rejecting basename clashes up front). Fresh-machine adoption
first shipped as `setup --from` (pinning a remote namespace), then the 2026-06-20 redesign
replaced it with `setup --inherit` via the `sets/<set>/` marker (`listRemoteNamespaces`
retired with it). **`compare --remote` is dropped, not deferred** (PR #89,
[ADR-0027](../adr/0027-compare-local-only-adoption-syncs-manifests.md)): `compare` stays
local-only, and `setup --inherit` instead pulls the set's remote manifests down (verbatim
`.tsv.zst` copies, no objects), so a fresh machine's local `compare`/`list`/`restore` work on
full history. (The `--remote` flag + `notImplemented()` stub were removed and the inherit-time
manifest sync — `downloadRemoteSnapshots` in `remote.mjs` — added.)

### Slice 5 — Admin pair

All three admin commands are **built**: `verify` (completeness + size cross-check, `<bucket>`
operand, [ADR-0042](../adr/0042-verify-bucket-operand.md)), `delete` (snapshot removal,
TTY-gated y/N confirm), and `cleanup` (`<bucket>` operand, dry-run default, single-pass
`--delete` + y/N, 7-day grace window, damage interlock, local cache rewrite, the documented
race warnings). The encryption-non-goal note is done (in the format spec); the
versioning/ransomware user-doc note and the everyday-vs-elevated delete-rights policy split
remain (deferred — see "Open items").

**Why this order:** slices 1–2 keep the tool fully working locally at every point;
3 delivers the README's promise; 4 makes it trustworthy (a backup you can't restore
isn't one); 5 makes it maintainable long-term. Starting anywhere else builds against
machinery that doesn't exist yet (slice 2 needs the set store; slice 3 needs sets to
upload; slice 4 needs backups to restore).
