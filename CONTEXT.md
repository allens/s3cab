# s3cab

The ubiquitous language of **s3cab** (**S3 C**ontent **A**ddressable **B**ackup): a
content-addressable backup tool that stores whole files by their hash and tracks them in
plain-text snapshots. This is a glossary, nothing else — design decisions live in
[docs/adr/](docs/adr/), designs in [docs/specs/](docs/specs/), and user-facing prose in
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
_Avoid_: deduplication (spell it the short way), compression (a separate concept).

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
object storage.
_Avoid_: garbage, dangling, unreachable (the precise term is orphan).

**Repository**:
One S3 bucket holding the whole backup: the `objects/` object store plus the `snapshots/`
tree. **One bucket is exactly one repository** — the layout is fixed by convention, not an
arbitrary prefix.
_Avoid_: repo (the git sense), archive, vault.

### Snapshots & sets

**Backup set** (**set**):
A named list of directories that is the unit of snapshot, backup, and restore. Its **name** (a
`[a-z0-9-]+` label, e.g. `work-laptop`) is its whole identity — at once the local handle, the
local directory under `~/.s3cab/sets/<name>/`, and the remote namespace. Unique within a bucket
(first-come).
_Avoid_: profile, job, project, config; folder (the user-facing word is **directory** — `#DIR` in
the snapshot file is just its abbreviation; "folder" collides with S3's pseudo-folders).

**Identity**:
What names a backup set: its **name**, and nothing more — there is no separate machine or user
component. (An advisory "created-on machine" is recorded for collision warnings only, never as
part of the identity.)
_Avoid_: owner, source, origin; `user@machine:set` (the retired form).

**Snapshot**:
A point-in-time record of every file in a backup set. Recorded on disk as a
tab-separated (TSV) **snapshot file** — one row per file
(`hash` → `size` → `mtime` → `path`).
_Avoid_: commit, version, generation; manifest (loses the point-in-time meaning), index, listing, catalog, metadata file.

**Namespace**:
The set name as the `snapshots/<set>/` path segment that isolates one set's snapshots from every
other set sharing the repository. Equal to the set name; no `user@machine` prefix.
_Avoid_: prefix, folder, scope.

### Cloud & commands

**Remote**:
The cloud (S3) side of a repository. The read commands point at it with a `--remote`/`-r`
flag rather than separate verbs.
_Avoid_: cloud, server, target, destination.

**Backup**:
The porcelain verb for uploading a snapshot's new objects and its snapshot file to the remote.
One-directional and archival.
_Avoid_: push, upload (that is the plumbing verb), sync.

**Restore**:
The porcelain verb for downloading files from a remote snapshot back to disk.
_Avoid_: pull, download (the plumbing verb), recover.

**Inherit**:
Taking over an existing remote set on a new machine when the old one is being retired,
replaced, or recovered after loss — machine **succession** (`s3cab setup <set> --inherit`). Not
a way to run two live machines off one set.
_Avoid_: adopt, clone, migrate, take-over.

**Setup** (the command):
The verb that *mutates* a backup set (ADR-0036): `s3cab setup <set> <directory>... --bucket <b>`
creates or updates a set, and `--inherit` adopts an existing remote set onto this machine. A
bucket is required to create, and every mode touches S3. Distinct from a **backup set**, the
noun it operates on.
_Avoid_: sets (the retired command name), init, config, register, create.

**List** (the command):
The verb that *shows* backup sets and their snapshots (ADR-0036): with no argument it lists
every set with its snapshot times; with a set named it shows that one in detail (bucket,
directories, exclude file) plus its snapshots. `--latest` narrows to the newest snapshot, `--remote`
shows one set's cloud backups. The read counterpart to **setup**.
_Avoid_: ls, show; sets (the retired command name).

**AWS profile**:
A named profile in the user's AWS shared config (`~/.aws/config` / `~/.aws/credentials`).
s3cab points at one by setting `AWS_PROFILE` in its *own* env files — written by the **profile**
command (`s3cab profile --profile <name>`), user-wide or scoped to a set. A pointer to AWS
credentials, never credential material itself, and **not** a backup set (the thing the
**Backup set** entry warns against calling a "profile").
_Avoid_: account, login, credentials (the profile names them; it is not them).
