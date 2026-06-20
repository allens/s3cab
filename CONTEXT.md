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

**Object**:
A single stored file's contents, named by its hash, living at `objects/<hash>` in a
repository.
_Avoid_: blob, chunk, block.

**Object store**:
The `objects/<hash>` half of a repository — the flat content-addressed pool every snapshot
points into.
_Avoid_: blob store, CAS pool.

**Repository**:
One S3 bucket holding the whole backup: the `objects/` object store plus the `snapshots/`
tree. **One bucket is exactly one repository** — the layout is fixed by convention, not an
arbitrary prefix.
_Avoid_: repo (the git sense), archive, vault.

### Snapshots & sets

> _Redesign settled, implementation pending ([ADR-0024](docs/adr/0024-set-name-is-the-whole-identity.md)):
> the set **name** is now the whole identity — there is no `user@machine` component. The code
> still uses the old form until the change lands; the definitions below are the language going
> forward._

**Backup set** (**set**):
A named list of directories that is the unit of snapshot, backup, and restore. Its **name** (a
`[a-z0-9-]+` label, e.g. `work-laptop`) is its whole identity — at once the local handle, the
local folder under `~/.s3cab/sets/<name>/`, and the remote namespace. Unique within a bucket
(first-come).
_Avoid_: profile, job, project, config.

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

**Setup**:
The command that creates and configures a backup set; a bucket is required.
_Avoid_: init, config, register.
