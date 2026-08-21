# s3cab

The ubiquitous language of **s3cab** (**S3 C**ontent **A**ddressable **B**ackup): a
content-addressable backup tool that stores whole files by their hash and tracks them in
plain-text snapshots. This is a glossary, nothing else — design decisions live in
[docs/adr/](docs/adr/), designs in [docs/design/](docs/design/), and user-facing prose in
[README.md](README.md).

## Language

### Storage model

**Content-addressable storage**:
Storing data keyed by the hash of its own contents, so identical content — under any name,
anywhere — is stored exactly once.
_Avoid_: CAS (unexplained), key-value store.

**Dedup**:
The deduplication that content-addressing produces. In s3cab it is **file-level only** — a
whole file is the unit; there is no sub-file chunking, block packing, or delta encoding.
_Avoid_: deduplication (spell it the short way — the full word is fine once, on a first
user-facing mention that introduces the term), compression (a separate concept).

**Hash**:
The lowercase-hex SHA-256 of a whole file's contents. It is the file's identity and the
name of its object.
_Avoid_: digest, checksum, SHA.

**File properties** (**Props**):
The triple a snapshot records for one file — its content **hash**, byte **size**, and
modification time (**mtime**). Computed by `fileProps` (and the `prop` command over it) from
the file on disk; an unchanged file (same size and mtime as a previous snapshot) reuses its
stored hash rather than re-hashing. The per-file unit a **snapshot** row stores.
_Avoid_: stat, metadata, attributes, file info.

**Object**:
A single stored file's contents, named by its hash, living at `objects/<hash>` in a
repository.
_Avoid_: blob, chunk, block.

**Object store**:
The `objects/<hash>` half of a repository — the flat content-addressed pool every snapshot
points into.
_Avoid_: blob store, CAS pool.

**Orphan** (**orphaned object**):
An object in the object store that no snapshot references any more — reachable from nothing, so
safe to delete to reclaim space. An object becomes an orphan only once the last snapshot
pointing at it is gone, which is why pruning old snapshots is the precondition for reclaiming
object storage. Strictly **object-side** — `cleanup`'s word. The same state seen from the
user's side is **unrestorable**.
_Avoid_: garbage, dangling, unreachable (the precise term is orphan); using it of a *file*
(that is **unrestorable**).

**Unrestorable**:
A file **restore** can no longer produce, because no surviving snapshot holds its content.
The user-facing consequence of **orphan**, read through the Restore vocabulary rather than
`cleanup`'s storage accounting — one state, two vantage points: the *object* is orphaned, the
*file* is unrestorable. What `forget`'s pre-removal check reports, since the question a user
is answering is "am I about to lose the last copy of this file", not "what is the reference
count" ([ADR-0063](docs/adr/0063-forget-snapshots-delete-paths.md)).
_Avoid_: unreferenced, orphaned file (orphan is object-side only), lost, gone.

**Grace window**:
The 7-day immunity every stored object has from deletion, measured from its upload time:
a young object may be an in-flight backup's upload, not yet referenced by its snapshot,
so no tool may treat it as an orphan. A repository-format contract, stated in the format
spec.
_Avoid_: TTL, retention period (retention is about snapshots; the grace window is about objects).

**Repository**:
One S3 bucket holding the whole backup: the `objects/` object store plus the `snapshots/`
tree (and, once a **delete** has run, the `deletions/` record). **One bucket is exactly one
repository** — the layout is fixed by convention, not an arbitrary prefix.
_Avoid_: repo (the git sense), archive, vault.

**Deletion record**:
The repository-level record of deliberate content removal: one plain TSV per `delete` run
under `deletions/<timestamp>.tsv`, listing every reference the deleted objects had
([ADR-0064](docs/adr/0064-path-scoped-delete-deletion-record.md), format spec). It is what
lets the tooling tell *deliberately gone* from *corrupted*: `verify` reports a recorded hash
as **expected-missing** (context, exit 0) rather than damage, `restore` skips it gracefully
with its date, and `backup`/`cleanup` subtract recorded hashes from their baselines and
interlocks. One artifact, machine-parsed *and* the human audit trail; never overwritten.
_Avoid_: tombstone (jargon), audit log (it is also machine-consumed), manifest.

**Format spec**:
The user-facing contract for everything s3cab stores — the repository layout, the
snapshot-file grammar, and the local `~/.s3cab/` surface — written down in
[guide/format.md](guide/format.md). The only document called a "spec": recovery must stay
possible from the stored files alone, and the written spec eases it and keeps the project
honest (a human-readable mirror of the true format). Contributor design docs in
[docs/design/](docs/design/) are **designs**, not specs.
_Avoid_: spec (for a design doc), format documentation (it is a contract, not a description).

### Snapshots & sets

**Backup set** (**set**):
A named list of directories that is the unit of snapshot, backup, and restore. Its **name** (a
`[a-z0-9-]+` label, e.g. `work-laptop`) is its whole identity — at once the local handle, the
local directory under `~/.s3cab/sets/<name>/`, and the remote namespace. Unique within a bucket
(first-come).
_Avoid_: profile, job, project, config; folder as a word for the *set* or in format prose (the
format word is **directory** — `#DIR` in the snapshot file is just its abbreviation; "folder"
collides with S3's pseudo-folders). "Folder" *is* used, deliberately, in user-facing prose for
an on-disk directory the reader browses (a OneDrive folder, `upload --dir`'s "a folder's
objects") — the reader's Explorer word, earned only by something confirmed to be a real
directory.

**Identity**:
What names a backup set: its **name**, and nothing more — there is no separate machine or user
component. (An advisory "created-on machine" is recorded for collision warnings only, never as
part of the identity.)
_Avoid_: owner, source, origin; `user@machine:set` (the retired form).

**Snapshot**:
A point-in-time record of every file in a backup set. Recorded on disk as a
tab-separated (TSV) **snapshot file** — one row per file
(`hash` → `size` → `mtime` → `path`).
A snapshot name is unique only within its set, so anything spanning the whole bucket names one
as **`set/snapshot`** (`work-laptop/2026-07-30T1400`) — matching its place in the bucket, so the
name pastes straight after `s3://<bucket>/snapshots/`. Used where several snapshots across
several sets are listed together; a single one named in a sentence stays prose (`'work-laptop'
(snapshot …)`).
_Avoid_: commit, version, generation; manifest (loses the point-in-time meaning), index, listing, catalog, metadata file.

**Namespace**:
The set name as the `snapshots/<set>/` path segment that isolates one set's snapshots from every
other set sharing the repository. Equal to the set name; no `user@machine` prefix.
_Avoid_: prefix (for this concept — the literal S3 key-prefix sense in format prose is fine),
folder, scope.

**Online-Only File**:
A file in the set whose contents live in the cloud and not on this computer — a dehydrated
placeholder left by Windows Files On-Demand (OneDrive, Dropbox, Google Drive). Backing one up
means downloading it first, so s3cab leaves it online and records it as **skipped** until
`--include-online-only` says otherwise (ADR-0081). Written verbatim as the `#SKIPPED` row's type,
so it is capitalized like the other type names.
_Avoid_: OneDrive file, cloud file (names one vendor, or every remote object); stub, dehydrated,
placeholder, offline (implementer's words, and "offline" reads as the opposite of what it means).

**Exclude pattern**:
One glob line in a set's `exclude.txt`, matched against each file or directory's path relative
to **every** member directory (ADR-0050; the grammar is in
[guide/exclude.md](guide/exclude.md), also the one built-in help topic). A matched entry
becomes an `#EXCLUDED` row; `tree --excluded` shows what the patterns are leaving out.
_Avoid_: ignore rule/file (git's word), filter, blacklist.

**s3cab home**:
The local directory holding everything s3cab keeps on a machine — sets, their snapshots and
env files, written CloudFormation templates. `~/.s3cab` by default; the **`S3CAB_HOME`**
environment variable overrides it (printed in command output wherever a path under it is
named).
_Avoid_: config directory, app data, dotfolder.

**Work file**:
The fixed-name temp file a snapshot write builds under before its atomic rename into place
(`.snapshot.tsv.zst` in the set's snapshots directory). It doubles as the in-progress lock: a
leftover one means a run is
live or was interrupted, and the interrupted case's hashes are parked and reused (ADR-0067).
_Avoid_: lock file, temp file (each names only half its job).

**Partial snapshot**:
A snapshot file holding only the rows a run got through before the user stopped it, closed with
a `PARTIAL` `#END` trailer that says so (ADR-0082). The one s3cab writes is the parked lookup
left by Ctrl+C (`.snapshot.lookup.tsv.zst`), which the next run reads for its hashes; a partial
snapshot is never installed as a **snapshot** of the set and never uploaded. Its opposite in
that column is `COMPLETE`, which every finished snapshot carries.
_Avoid_: incomplete/truncated snapshot (truncation is *damage* — a partial snapshot is intact
and deliberate, and the trailer is precisely what tells them apart), cancelled snapshot,
half-snapshot.

### Cloud & commands

**Remote**:
The cloud (S3) side of a repository. A read command with both a local and a cloud mode
points at it with a `--remote`/`-r` flag rather than a separate verb — today only `list`
qualifies (`status` is inherently remote, `compare` deliberately local-only; ADR-0012).
_Avoid_: cloud, server, target, destination.

**Backup**:
The porcelain verb for uploading a snapshot's new objects and its snapshot file to the remote.
One-directional and archival.
_Avoid_: push, upload (that is the plumbing verb), sync.

**Drift**:
A file whose contents changed between being hashed and being uploaded — the upload pipeline
re-checks the props just before the PUT and reports the mismatch as data rather than storing
the current bytes under the stale hash (ADR-0069). What a drifted file *means* is the
caller's call: fatal where a snapshot is about to be published, a reportable skip where none
is.
_Avoid_: race, TOCTOU (implementer's words), change/modification (too generic — drift is
specifically change *during* the run).

**Restore**:
The porcelain verb for downloading files from a remote snapshot back to disk.
_Avoid_: pull, download (the plumbing verb), recover.

**Reattach** (the command):
Attaching *this machine* to a backup set that already exists in the cloud — machine
**succession**: the old machine is being retired, replaced, or recovered after loss
(`s3cab reattach <set> --bucket <b>`, ADR-0053). Pulls the set's config and snapshot
*history* down (**not** the backed-up files — that's **restore**), recreates it locally, and
re-stamps ownership to this machine. Meant for succession, not for running two live machines off
one set — though it never disables the prior machine, so that stays possible (a discouraged
power-user case). Split out of the old `setup --inherit`.
_Avoid_: reconnect (the runner-up — implies a live link; "attach" is the backup drive's own verb,
ADR-0053), inherit (the retired flag name), adopt, clone, migrate, take-over.

**Verify**:
The porcelain verb that checks backups are complete and undamaged without downloading
anything: every object a set's snapshots reference must exist in the object store, at its
recorded size. Takes the repository's *bucket* (`s3cab verify <bucket>`, ADR-0042) and checks
every set sharing it, answering "is this backup restorable?" with findings reported per set —
and it never writes to the remote.
_Avoid_: check, fsck, audit, scrub, validate.

**Forget** (the command):
The porcelain verb that removes named remote snapshots from a set
(`s3cab forget --set <set> <snapshot>...`, [ADR-0063](docs/adr/0063-forget-snapshots-delete-paths.md)).
It removes only the snapshot files — the content they referenced stays in the object store
until **cleanup** reclaims what nothing references any more. The repository forgets the
*moment*; the stuff remains until swept. Previews what the removal would orphan, then confirms
once for the whole run.
_Avoid_: delete (its retired name — **delete** is now the path-scoped content-removal
command), retire (**succession**'s word, see Reattach), prune, expire; drop (as a name for
the command — fine as a plain-language gloss in prose, "drop a snapshot").

**Delete** (the command):
The porcelain verb that removes named *paths'* content from the whole backed-up history —
"I have no use for this, stop paying to back it up", applied to backups already taken
(`s3cab delete --bucket <b> <path>...`,
[ADR-0063](docs/adr/0063-forget-snapshots-delete-paths.md)/[0064](docs/adr/0064-path-scoped-delete-deletion-record.md)).
Snapshots are never rewritten: the backing objects are removed and a **deletion record**
marks them deliberately gone — the removed content is simply **deleted** (not
**unrestorable**, which stays `forget`'s preview word for content a snapshot removal would
strand). Scope is the machine's participating sets; any outside reference protects an
object, and `--everywhere` lifts that protection for the matched content. The tool's most
destructive command — the strongest confirmation (type the bucket name).
_Avoid_: purge, expunge, remove (say delete); using it of snapshot removal (that is
**forget**).

**Cleanup**:
The porcelain verb that reclaims storage by deleting orphaned objects. It operates on the
*bucket* (an object is deletable only when no snapshot from any set references it) and
reports by default — deleting takes an explicit flag. One of exactly two commands that
remove **stored objects** — the janitorial one, sweeping what nothing references, where
**delete** removes content live snapshots still reference (deletion rights aren't unique to
them — `forget` removes a snapshot file, and the everyday identity deliberately carries
soft-delete, ADR-0033).
_Avoid_: gc, prune, purge, vacuum.

**Setup** (the command):
The verb that *creates a new backup set* on this machine (ADR-0036, ADR-0052, ADR-0053):
`s3cab setup --set <set> --bucket <b> <directory>...` claims the name and binds the set to its bucket.
(The directories are the bulk operand, so they take the positionals and the set is addressed by a
flag — [ADR-0062](docs/adr/0062-bulk-operands-positional-addressing-by-flag.md).)
A bucket is required, and it touches S3 (the collision check). There is no update mode — a set's
directories live in its public `dirs.txt`, edited directly (like `exclude.txt`), so re-running
`setup` on a set that already exists here is refused; adopting an existing *remote* set is
**reattach**. Distinct from a **backup set**, the noun it operates on.
_Avoid_: sets (the retired command name), init, config, register, create.

**List** (the command):
The verb that *shows* backup sets and their snapshots (ADR-0036): with no argument it lists
every set with its snapshot times; with a set named it shows that one in detail (bucket,
directories, exclude file) plus its snapshots. `--latest` narrows to the newest snapshot, `--remote`
shows one set's cloud backups. The read counterpart to **setup**.
_Avoid_: ls, show; sets (the retired command name).

**Provider**:
The storage service a backup talks to — AWS S3 or any S3-compatible service (Cloudflare R2,
Backblaze B2, Wasabi, …). Off AWS, a provider reduces to three strings — endpoint,
access key, secret key — plus a region label; these (and the AWS profile) are recorded in the
set's env file — at creation by `s3cab setup`, or later with the **provider** command
(ADR-0047/0055).
_Avoid_: vendor, backend, cloud (as a noun for the service), storage service.

**AWS profile**:
A named profile in the user's AWS shared config (`~/.aws/config` / `~/.aws/credentials`).
s3cab points at one by setting `AWS_PROFILE` in a set's *own* env file — written by the
**provider** command (`s3cab provider --profile <name>`, scoped to the set — ADR-0055). A
pointer to AWS credentials, never credential material itself, and **not** a backup set (the
thing the **Backup set** entry warns against calling a "profile").
_Avoid_: account, login, credentials (the profile names them; it is not them).

**Roles Anywhere** (credential mode):
A backup set's fourth credential mode (beside profile / keys / ambient — ADR-0055): the machine
authenticates to AWS with an X.509 **client certificate** and receives short-lived session
credentials, so there are no long-lived AWS keys. Set up with `s3cab aws <bucket> --roles-anywhere`;
a set opts in via `s3cab provider --roles-anywhere` (ADR-0056/0057).
_Avoid_: RA (in user-facing text), certificate auth, passwordless.

**Trust anchor**:
The AWS IAM Roles Anywhere object that holds your CA certificate and thereby establishes trust
between Roles Anywhere and your CA. Replacing the CA means a new trust anchor — AWS no longer trusts
certificates signed by the old CA.
_Avoid_: root, CA (the trust anchor *references* the CA; it is not the CA).

**Client certificate**:
The X.509 certificate (plus its private key) that identifies this machine to Roles Anywhere, signed
by the machine's CA. The private key is generated locally, stored owner-only, and never sent to AWS.
Long-lived and generate-and-forget (ADR-0057).
_Avoid_: key (the certificate is not the private key), token.

**Machine RA identity**:
The machine-level cluster a Roles Anywhere setup produces — the CA, the client certificate + key,
and the trust-anchor / role / profile ARNs — stored once under `~/.s3cab/roles-anywhere/`. Every set
in Roles Anywhere mode shares it, the way sets share a machine-level `AWS_PROFILE` (ADR-0057).
_Avoid_: certificate store, PKI.
