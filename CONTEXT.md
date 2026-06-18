# s3cab

The ubiquitous language of **s3cab** (**S3 C**ontent **A**ddressable **B**ackup): a
content-addressable backup tool that stores whole files by their hash and tracks them in
plain-text snapshots. This is a glossary, nothing else — design decisions live in
[docs/adr/](docs/adr/), designs in [specs/](specs/), and user-facing prose in
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

**Backup set** (**set**):
A named list of directories that is the unit of snapshot, backup, and restore. Configured
under `~/.s3cab/sets/<name>/` and pinned to an identity at creation.
_Avoid_: profile, job, project, config.

**Identity**:
The `user@machine:set` triple pinned when a set is created; it names who and where a
snapshot came from.
_Avoid_: owner, source, origin.

**Snapshot**:
A point-in-time record of every file in a backup set.
_Avoid_: commit, version, generation.

**Manifest**:
The tab-separated (TSV) file that *is* a snapshot on disk — one row per file
(`hash` → `size` → `mtime` → `path`).
_Avoid_: index, listing, catalog, metadata file.

**Namespace**:
The `<user>@<machine>/<set>` path segment under `snapshots/` that isolates one set's
manifests from every other set sharing the repository.
_Avoid_: prefix, folder, scope.

### Cloud & commands

**Remote**:
The cloud (S3) side of a repository. The read commands point at it with a `--remote`/`-r`
flag rather than separate verbs.
_Avoid_: cloud, server, target, destination.

**Backup**:
The porcelain verb for uploading a snapshot's new objects and its manifest to the remote.
One-directional and archival.
_Avoid_: push, upload (that is the plumbing verb), sync.

**Restore**:
The porcelain verb for downloading files from a remote snapshot back to disk.
_Avoid_: pull, download (the plumbing verb), recover.

**Setup**:
The command that creates and configures a backup set.
_Avoid_: init, config, register.
