# s3cab

[![status: WIP · pre-release](https://img.shields.io/badge/status-WIP%20%C2%B7%20pre--release-orange)](#status)
[![license: GPL-3.0-or-later](https://img.shields.io/badge/license-GPL--3.0--or--later-blue)](LICENSE)
[![node: ≥26.3.0](https://img.shields.io/badge/node-%E2%89%A526.3.0-brightgreen)](package.json)

**S3 Content Addressable Backup** — a command-line tool for backing up files to S3 (or
any S3-compatible object storage), storing data by the **hash of its contents** so that
identical files are never stored twice, in a format that will never lock you in.

> ⚠️ **Pre-release (v0.0.1), under active development.** Today s3cab builds and compares
> **local** content-addressable snapshots. Uploading to S3 is the next milestone — see
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

s3cab is currently a **local content-addressable snapshot engine**. These commands work
today (no cloud involved yet):

| Command    | What it does                                                                  |
| ---------- | ----------------------------------------------------------------------------- |
| `snapshot` | Take a snapshot of a directory: hash every file and write a manifest.         |
| `compare`  | Show what changed between two snapshots (added / moved / modified / deleted). |
| `list`     | List the snapshots taken for a directory.                                     |
| `tree`     | List the files in a directory, honouring exclude rules.                       |
| `prop`     | Show the hash, size, and modified time of a single file.                      |

**Planned:** uploading and downloading content to S3 / S3-compatible storage — the
content-addressed object store (`objects/<hash>`) and remote snapshots — which will turn
s3cab from a local snapshotting engine into a full backup tool.

## How it works

Running `snapshot` on a directory writes an immutable manifest under a `.s3cab/` folder
beside your files:

```
my-photos/
  .s3cab/
    exclude.txt                  # optional: glob patterns for files to skip
    snapshots/
      2025-11-10T2104.tsv.zst    # one snapshot per run (zstd-compressed TSV)
      2025-11-11T0830.tsv.zst
  2024/
  2025/
```

Each manifest is a tab-separated table of `hash`, `size`, `modified-time`, and `path` —
fixed-width leading columns so it stays readable, with the variable-length (and
platform-native, absolute) path last:

```
#SNAPSHOT                                                            2025-11-11T08:30   C:\Users\me\my-photos
3b8e...c0a1                                                  4915200  2025-06-01T12:00:00.000Z  C:\Users\me\my-photos\2025\beach.jpg
e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855           0  2024-01-01T00:00:00.000Z  C:\Users\me\my-photos\2024\empty.txt
```

To inspect a compressed snapshot by hand, decompress it with any zstd tool
(`zstd -d snapshot.tsv.zst`) and open the resulting `.tsv`. That's the whole recovery
story — no s3cab required.

> s3cab is developed primarily for **Windows**; Linux and macOS support is a best-effort
> goal for later. Snapshot paths are absolute and use the native OS path style.

Exclude rules live in `.s3cab/exclude.txt`; see [doc/exclude.md](doc/exclude.md) for the
glob syntax.

## Installation & usage

📌 Full installation, AWS setup, and command walkthroughs will be documented here as the
tool approaches its first real release. For now it runs from source on a recent Node.js
(see `engines` and `scripts` in [package.json](package.json)):

```
node src/s3cab.mjs <command> [options] [args]
```

## License

[GPL-3.0-or-later](LICENSE) © Allen Shiels

---

_Contributors: see [CLAUDE.md](CLAUDE.md) for architecture, design philosophy, and
conventions._
