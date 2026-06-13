# s3cab

[![npm](https://img.shields.io/npm/v/s3cab)](https://www.npmjs.com/package/s3cab)
[![status: WIP · pre-release](https://img.shields.io/badge/status-WIP%20%C2%B7%20pre--release-orange)](#status)
[![license: GPL-3.0-or-later](https://img.shields.io/badge/license-GPL--3.0--or--later-blue)](LICENSE)
[![node: ≥26.3.0](https://img.shields.io/badge/node-%E2%89%A526.3.0-brightgreen)](package.json)

**S3 Content Addressable Backup** — a command-line tool for backing up files to S3 (or
any S3-compatible object storage), storing data by the **hash of its contents** so that
identical files are never stored twice, in a format that will never lock you in.

> ⚠️ **Pre-release, under active development.** Today s3cab takes and compares **local**
> snapshots of your files. Backing up to the cloud is the next milestone — see
> [Status](#status). Expect things to change.

## Why s3cab?

Most backup tools bury your data in a proprietary or hard-to-decode format. If the tool
dies, your backups can die with it. s3cab is built on the opposite premise — **your data
is never locked in**:

- **🔓 No lock-in, by design.** Snapshots are plain tab-separated text. Backed-up files
  are stored as ordinary objects named by their SHA-256 hash. If s3cab disappeared
  tomorrow, you could recover everything by hand — or write a replacement in an
  afternoon. Easy recovery is a first-class feature, not an afterthought.

- **🧮 Content-addressable deduplication.** Files are identified by the SHA-256 of their
  contents, not their name or path. Move a folder of photos, or back up the same file in
  two places, and it costs **zero** extra storage. Deduplication is whole-file, which
  keeps the stored format simple and transparent.

- **📄 Manifests you can actually read.** Every snapshot is a tab-separated file — open
  it in a text editor, or load it into Excel to sort, filter, and explore your backup.
  No special viewer required.

- **🔁 Real change detection.** Comparing two snapshots shows exactly what was **added,
  moved, renamed, modified, or deleted**. Because it matches on content hashes, a moved
  or renamed file is recognised as the _same_ file — not a delete plus an add.

- **🧱 Modern, open building blocks.** Standard SHA-256 hashing, zstd compression, and a
  current Node.js runtime. Deliberately modern — but never proprietary.

## Status

s3cab records and compares the state of your files, organised into **backup sets** (a
named list of folders that snapshot as one unit), and **backs them up to S3**. (Restoring
_through s3cab_ is the next milestone — until then, the open, self-describing format means
you can always recover by hand; see [Cloud repositories](#cloud-repositories).) You create
a set once, then the commands act on it:

| Command                       | What it does                                                                  |
| ----------------------------- | ----------------------------------------------------------------------------- |
| `s3cab setup <set> <folder>…` | Create or update a **backup set** (`--bucket` binds its cloud destination).   |
| `s3cab sets`                  | List your backup sets, their folders, and where they back up to.              |
| `s3cab snapshot [<set>]`      | Take a snapshot of a set, then show what changed since the previous one.      |
| `s3cab list [<set>]`          | List a set's snapshots — or its cloud backups with `--remote`.                |
| `s3cab compare [<set>]`       | Show what changed between two snapshots (added / moved / modified / deleted). |
| `s3cab backup [<set>]`        | Take a fresh snapshot and upload it (and the files it references) to S3.       |
| `s3cab status [<set>]`        | Show what is backed up and what a backup would upload.                        |
| `s3cab tree [<set>]`          | List the files a snapshot of the set would include, honouring exclude rules.  |
| `s3cab prop <file>`           | Show the hash, size, and modified time of a single file.                      |

A set's configuration is plain files you can open and edit (`~/.s3cab/sets/<set>/`). When
you have only one set you can leave the name out — plain `s3cab snapshot` just works.

Run any command with `--help` to see its options. (Two cloud plumbing commands, `objects`
and `upload`, also work already — advanced building blocks covered under
[Cloud repositories](#cloud-repositories).)

### Coming next

Backing up already works (see [Status](#status)); these remaining commands complete the
round-trip — getting your files **back** — and are **not yet functional** (they exit with
a "not yet implemented" message):

| Command                          | Will do                                                                |
| -------------------------------- | ---------------------------------------------------------------------- |
| `s3cab restore [<set>] [paths…]` | Restore files from a backup.                                           |
| `s3cab verify [<set>]`           | Check that a backup is complete and undamaged.                         |

(`compare` will also gain a `--remote` flag to work against the cloud copy; `list --remote`
already works.)

### Cloud repositories

A cloud backup lives in **its own S3 bucket** — _one repository is one bucket_, not a
folder inside a shared one. Inside, the structure is fixed and well-known, so anything
(s3cab, another tool, or you by hand) can find everything by convention:

```
s3://my-backup-bucket/
  objects/<sha256>                       # your files, each stored once under its content hash
  snapshots/<user>@<machine>/<set>/…     # the manifests that say which objects make up each snapshot
```

One bucket can hold backups from **several people and machines** — they all share
`objects/` (so duplicate content is still stored once across everything in the bucket),
while each backup set keeps its own manifests under a prefix like
`snapshots/allen@allen-pc/photos/`. A manifest only ever appears in `snapshots/` after
every file it references is safely in `objects/`, so any manifest you find is complete
and restorable.

That fixed layout is the no-lock-in promise in practice: to recover a file by hand you
look up its hash in a snapshot and download `objects/<that-hash>`.

The `objects` command lists a repository's stored object hashes, **one per line**. It's an
advanced/diagnostic command — most people never run it directly; its real job is to produce
a lookup file (the per-bucket objects cache) so `backup` can skip re-uploading files already
stored:

```console
> s3cab objects my-backup-bucket               # one sha256 per line, to stdout
> s3cab objects my-backup-bucket -f have.txt   # …or written to a file
```

Its write counterpart, `upload`, puts a single file into the store at `objects/<sha256>`.
Content already in the store is skipped automatically — identical bytes always map to the
same key — unless you `--force` a re-upload:

```console
> s3cab upload my-backup-bucket C:\Users\me\Photos\beach.jpg
```

(`<bucket>` is a plain S3 bucket name — one repository is one bucket. Like `objects`,
`upload` is plumbing: a lower-level building block beside the snapshot-driven `backup`.)

### Authentication

s3cab talks to S3 with your **existing AWS credentials** wherever possible, and never
edits `~/.aws/config` or `~/.aws/credentials`. It resolves credentials in this order:

1. s3cab's own **env files**, if present (handy for `AWS_*` keys, a profile, an endpoint, or a
   default bucket — including some S3-compatible providers). Highest precedence first, a file
   always beating the shell:
   - **`~/.s3cab/sets/<set>/env`** — per-backup-set (where `s3cab setup` records the set's
     bucket; add per-set overrides here). It takes effect as the set-based commands arrive
     with `backup`;
   - **`~/.s3cab/env.<bucket>`** — per-bucket (how to authenticate to that bucket); used by
     commands that take a bucket, like `upload`/`objects`;
   - **`~/.s3cab/env`** — your per-user defaults; the base layer under the others.

   (s3cab does **not** read a `.env` from the current directory.)
2. the **standard AWS credential chain** — `AWS_PROFILE`, shared profiles (including SSO
   sessions from `aws sso login` and `credential_process`), and `AWS_*` environment variables.

If neither is configured, s3cab stops and tells you what to do. Run **`s3cab help auth`**
for the full details. s3cab has no sign-in flow of its own and stores no credentials: AWS
IAM Identity Center (SSO) users sign in with the AWS CLI's `aws sso login`, and s3cab picks
the session up automatically through the standard chain.

## Quick start

```console
# Create a backup set (a name plus the folders it contains):
> s3cab setup photos C:\Users\me\Photos

# Snapshot the set. With only one set, you can leave its name out:
> s3cab snapshot
Generating new snapshot: 2025-11-11T0830

# ...add, move, or edit some files, then snapshot again —
# s3cab reports what changed since last time (as JSON):
> s3cab snapshot
Generating new snapshot: 2025-11-12T0915
{
  "added": [
    "2025\\new.jpg"
  ],
  "moved": [
    "2024\\IMG_001.jpg →→ 2024\\sorted\\IMG_001.jpg"
  ],
  "modified": [],
  "deleted": []
}

# List every snapshot you've taken of the set:
> s3cab list
[
  "2025-11-12T0915",
  "2025-11-11T0830"
]

# Compare any two snapshots (defaults to the latest two; --since picks an older one):
> s3cab compare --since 2025-11-11T0830
```

How to read the report — the four categories and the `→→` / `==` notations — is
covered in [doc/compare.md](doc/compare.md).

## How it works

Running `snapshot` walks every folder in the set and writes one immutable manifest into
the set's own folder under your home directory — never inside your backed-up files:

```
~/.s3cab/sets/photos/
  dirs.txt                       # the folders that make up the set
  env                            # the set's identity + (optional) cloud bucket
  exclude.txt                    # optional: glob patterns for files to skip
  snapshots/
    2025-11-10T2104.tsv.zst      # one snapshot per run (zstd-compressed TSV)
    2025-11-11T0830.tsv.zst
```

Each manifest is a tab-separated table of `hash`, `size`, `modified-time`, and `path` —
fixed-width leading columns so it stays readable, with the variable-length (and
platform-native, absolute) path last. It opens with a header naming the set's identity
(`user@machine:set`) and each member folder, so a manifest is self-describing even found
on its own:

```
#SNAPSHOT                                                            2025-11-11T08:30          allen@allen-pc:photos
#DIR                                                                                           C:\Users\me\Photos
3b8e...c0a1                                                  4915200  2025-06-01T12:00:00.000Z  C:\Users\me\Photos\2025\beach.jpg
e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855           0  2024-01-01T00:00:00.000Z  C:\Users\me\Photos\2024\empty.txt
```

To inspect a compressed snapshot by hand, decompress it with any zstd tool
(`zstd -d snapshot.tsv.zst`) and open the resulting `.tsv`. That's the whole recovery
story — no s3cab required.

Exclude rules live in `~/.s3cab/sets/<set>/exclude.txt`, applied relative to each of the
set's folders; run `s3cab help exclude` for a quick reference, or see
[doc/exclude.md](doc/exclude.md) for the full guide.

> s3cab is developed primarily for **Windows**; Linux and macOS support is a best-effort
> goal for later. Snapshot paths are absolute and use the native OS path style.

## Installing & running

Pick whichever suits you — all three run the same tool:

- **npm** (needs [Node.js](https://nodejs.org) ≥ 26.3.0):

  ```console
  > npm install -g s3cab
  > s3cab snapshot C:\Users\me\Photos
  ```

- **Prebuilt binary** — download the archive for your platform from the
  [Releases](https://github.com/allens/s3cab/releases) page and run `s3cab`. No Node.js
  required. (See the macOS note below.)

- **From source** (needs Node.js ≥ 26.3.0) — clone the repo and run the entry point
  directly:

  ```console
  > node src/s3cab.mjs snapshot C:\Users\me\Photos
  ```

### macOS note

The prebuilt macOS binary on the [Releases](https://github.com/allens/s3cab/releases) page
is ad-hoc signed, so it runs, but it is **not notarized** (that needs a paid Apple Developer
account). If you download the archive in a **web browser**, macOS may block it ("Apple could
not verify…"). Clear the quarantine flag and run it:

```console
> xattr -dr com.apple.quarantine ./s3cab
```

Downloading via the terminal (`curl`/`wget`), installing with `npm`, or running the portable
`s3cab.js` bundle on your own Node all sidestep this entirely — the latter two work on Intel
Macs too.

## License

[GPL-3.0-or-later](LICENSE) © Allen Shiels

---

_Contributors: see [CONTRIBUTING.md](CONTRIBUTING.md) to get started (it links the
[CLA](CLA.md)), and [CLAUDE.md](CLAUDE.md) for architecture, design philosophy, and
conventions._
