# s3cab

[![npm](https://img.shields.io/npm/v/s3cab)](https://www.npmjs.com/package/s3cab)
![status: WIP · pre-release](https://img.shields.io/badge/status-WIP%20%C2%B7%20pre--release-orange)
[![license: GPL-3.0-or-later](https://img.shields.io/badge/license-GPL--3.0--or--later-blue)](LICENSE)
[![node: ≥26.10.0](https://img.shields.io/badge/node-%E2%89%A526.10.0-brightgreen)](package.json)

**S3 Content Addressable Backup** — a command-line tool for backing up files to S3 (or
any S3-compatible object storage), storing data by the **hash of its contents** so that
identical files are never stored twice, in a format that will never lock you in.

**What it's for, day to day:** getting back files you deleted by accident, or pulling back
an earlier version of something — long after a sync service like OneDrive or Dropbox has
stopped keeping its short-lived version history. That everyday "I need that file back" is the
job s3cab is built around. Restoring an _entire_ dataset after a disaster works too, but it's
the rare backstop — the day-to-day use is recovering one file, or one old version.

**The kind of data it's for:** the files that make up your digital life — photos, videos,
documents, and the like, from a few kilobytes up to the multi-gigabyte video files a camera or
phone produces. s3cab backs up each file as it sits on disk, so it suits data that
holds still. For a live system — a database, a mail store, a running app — back up an _export_
of it (a dump, an archive) rather than the working files the application keeps open and
rewrites underneath you. If a file does change mid-backup, s3cab stops and names it rather than
store a half-written copy; a one-off clash just needs a re-run, but a file that's forever in
flux belongs in the set's [exclude](guide/exclude.md) list, not your backup.

> ⚠️ **Pre-release, under active development.** The full command set works today —
> snapshotting, comparing, backing up to S3, restoring, verifying, forgetting snapshots,
> deleting backed-up content, and reclaiming storage (see the
> [Command reference](#command-reference)). What's left before 1.0 is polish and
> retention-policy automation. Expect things to change.

## Why s3cab?

Most backup tools bury your data in a proprietary or hard-to-decode format. If the tool
dies, your backups can die with it. s3cab is built on the opposite premise — **your data
is never locked in**:

- **🔓 No lock-in, by design.** Snapshots are plain tab-separated text. Backed-up files
  are stored as ordinary objects named by their SHA-256 hash. If s3cab disappeared
  tomorrow, you could recover everything by hand — or write a replacement in an
  afternoon. Easy recovery is a first-class feature, not an afterthought.

- **🧮 Content-addressable deduplication.** Files are identified by the SHA-256 of their
  contents, not their name or path. Move a directory of photos, or back up the same file in
  two places, and it costs **zero** extra storage. Deduplication is whole-file, which
  keeps the stored format simple and transparent.

- **📄 Snapshot files you can actually read.** Every snapshot is a tab-separated file — open
  it in a text editor, or load it into Excel to sort, filter, and explore your backup.
  No special viewer required.

- **🔁 Real change detection.** Comparing two snapshots shows exactly what was **added,
  moved, renamed, modified, or deleted**. Because it matches on content hashes, a moved
  or renamed file is recognised as the _same_ file — not a delete plus an add.

- **🧊 Cheap storage, nothing to tune.** On AWS, objects go straight into S3 Glacier
  Instant Retrieval — the cheapest instant-access storage class, no lifecycle rules to set
  up and no thawing delay when you restore — and are encrypted at rest with SSE-S3. Other
  S3-compatible providers get plain uploads, since storage classes are AWS's own vocabulary.

- **🧱 Modern, open building blocks.** Standard SHA-256 hashing, gzip compression any
  machine can read with what it already has, and a current Node.js runtime. Deliberately
  modern — but never proprietary.

## Installing & running

Pick whichever suits you — all three run the same tool. Then head to the
[Quick start](#quick-start).

- **npm** (needs [Node.js](https://nodejs.org) ≥ 26.10.0):

  ```console
  > npm install -g s3cab
  ```

- **Prebuilt binary** — download the archive for your platform from the
  [Releases](https://github.com/allens/s3cab/releases) page and run `s3cab`. No Node.js
  required. Windows x64, Linux x64 and arm64, and macOS on Apple Silicon (see the
  [macOS note](#macos-note) below). Every release also carries `s3cab.js`, a portable
  single-file bundle that runs anywhere Node.js does.

- **From source** (needs Node.js ≥ 26.10.0) — clone the repo and run the entry point
  directly, substituting `node src/s3cab.mjs` for `s3cab` in any command:

  ```console
  > node src/s3cab.mjs --help
  ```

The test suite runs on Windows, Linux and macOS on every change, and no binary ships until it
has backed up and restored real files through a real S3 bucket **on its own platform** — that
round trip is a release gate, not a nightly.

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

## Quick start

You back up **directories**, grouped into a named **backup set**, to an **S3 bucket**.
First you need the bucket: on AWS, `s3cab aws my-backups` prints a ready-to-deploy
recipe (walkthrough in [guide/aws.md](guide/aws.md)); for Cloudflare R2, Backblaze B2,
Wasabi and the like, run `s3cab help provider`. With a bucket in hand:

```console
# 1. Create a backup set — a name, its directories, and the bucket to back up to.
#    --keys prompts for your access key + secret (never passed as flags).
> s3cab setup --set photos --bucket my-backups --keys C:\Users\me\Photos
Contacting the cloud…
Set 'photos' → bucket 'my-backups'
dirs (C:\Users\me\.s3cab\sets\photos\dirs.txt):
  C:\Users\me\Photos

# 2. Back it up to the cloud. With one set, you can leave its name out.
> s3cab backup
Contacting the cloud…
Backed up 'photos' → snapshot 20251112T0915
Scanned 1,312 files (4.2GB) in 2m 41s
Uploaded 1,240 objects (4.2GB) in 6m 08s

First backup — every file is new.

# 3. Deleted a file by accident? Get just that one back:
> s3cab restore --set photos C:\Users\me\Photos\beach.jpg
Contacting the cloud…
Restored 1 file from 'photos' (snapshot 20251112T0915).
```

That's the whole loop: set up once, `backup` whenever, `restore` when you need something
back. To pull an _older_ version, add `--snapshot <name>`; to recover everything (the
disaster-recovery case), run `restore --all`. By default `restore` leaves files that
still exist untouched — your accidental deletions come back while everything else stays put —
so pass `--overwrite` when you actually want to replace what's there.
[guide/restore.md](guide/restore.md) covers all of it, and
[guide/getting-started.md](guide/getting-started.md) walks through this loop on a folder
that doesn't matter, with what each step did and why.

Step 1 also drops a starter `exclude.txt` beside the set and lists what it will skip by
default — `node_modules`, `.git`, and the usual OS clutter. Edit that file to change it
([guide/exclude.md](guide/exclude.md), or `s3cab help exclude`).

### Seeing what changed

`s3cab snapshot` records the state of a set without touching the cloud, then shows what
changed since the previous snapshot. It matches on content, so a moved or renamed file reads
as the _same_ file, not a delete plus an add. `list` shows your sets and their snapshots, and
`compare` diffs any two; [guide/compare.md](guide/compare.md) shows the report and how to
read it. Add `--json` to any command for machine-readable output
([guide/output.md](guide/output.md)).

Going further: the [guides](guide/) cover backing up, getting files back, looking after a
backup over the years, and signing in to your storage, and
[guide/format.md](guide/format.md) is the format spec — your backup as it sits in the bucket,
written down so you can read it without s3cab. The files s3cab keeps on your own machine are
in [guide/backup.md](guide/backup.md#where-a-set-lives).

## Command reference

Every invocation takes the same shape — `s3cab <command> [options] [args]` — and the groups
below are the CLI's own: `s3cab --help` prints this same list, `s3cab <command> --help` adds
that command's flags, examples and a fuller description, and the [guides](guide/) are the
sit-down read.

When you have only one backup set you can leave its name out — plain `s3cab snapshot` just
works. The commands that reach into a backup and change it are the deliberate exceptions:
they always name what they act on, as `--set <set>` or a bucket.

### Snapshots

Recording what your files look like, and what changed since last time. All local — no
network, no bucket needed.

| Command                  | What it does |
| ------------------------ | ------------ |
| `s3cab snapshot [<set>]` | Take a snapshot of the set, then show what changed since the previous one. `--rehash` re-hashes every file instead of reusing unchanged files' hashes. |
| `s3cab list [<set>]`     | List your backup sets and their snapshots — name a set for its detail, `-r`/`--remote` for its cloud backups, `-l`/`--latest` for just the newest. |
| `s3cab compare [<set>]`  | Show what changed between two snapshots — added / renamed / moved / modified / deleted; `--since` and `--until` choose which two ([guide](guide/compare.md)). |
| `s3cab find <pattern>…`  | Search your backups for a file: which snapshots hold it and the hash it's stored under, ready to hand to `delete` ([guide](guide/find.md)). |
| `s3cab status [<set>]`   | Show what is backed up already, and what the next `backup` would upload. |

### Setup

Run once: a bucket to back up to, credentials to reach it, and the set itself.

| Command                                | What it does |
| -------------------------------------- | ------------ |
| `s3cab aws <bucket>`                   | Write a CloudFormation template — and print the steps — to stand up an **AWS** S3 bucket plus a locked-down identity; `--roles-anywhere` builds the keyless certificate identity instead ([guide](guide/aws.md)). |
| `s3cab provider [<set>]`               | Set, clear, or show how s3cab reaches your storage: `--profile` for an AWS profile, `--endpoint` + `--region` for any [S3-compatible provider](guide/aws.md#non-aws-providers), `--keys` to be prompted for an access key, `--unset` to remove one ([guide](guide/auth.md)). |
| `s3cab setup --set <set> <directory>…` | Create a **backup set** from one or more directories; `--bucket` binds its cloud destination, and it takes the same provider flags as `provider`. Its directories then live in an editable `dirs.txt`. |
| `s3cab reattach <set>`                 | Attach a set that already exists in the cloud to this machine, read-only, to browse and restore it (`--bucket` names its bucket the first time). Pulls its snapshot history, not the files (that's `restore`); run it again to pull newer snapshots. |
| `s3cab takeover <set>`                 | Make this machine the one that backs a set up — a replacement machine. Attaches the set if it isn't here, fills in its directory list and exclude rules where this machine has none, and from then on the old machine's backups are refused. |

### Backup & restore

The cloud round trip, plus the maintenance that keeps a repository healthy
([guide](guide/maintenance.md)).

| Command                                  | What it does |
| ---------------------------------------- | ------------ |
| `s3cab backup [<set>]`                   | Take a fresh snapshot and upload it — and the files it references — to the set's bucket. `--rehash` re-reads every file instead of trusting an unchanged size and modification time ([guide](guide/backup.md)). |
| `s3cab restore --set <set> <path>…`      | Recover from the set's cloud backup: name paths for specific files, `--from-file` for a list of them, or `--all` for the whole set. `--snapshot` pulls an older version, `--overwrite` replaces files that still exist, `-o`/`--output` restores under a directory you choose ([guide](guide/restore.md)). |
| `s3cab extract --set <set> <path>`       | Copy one file or folder out of the backup into the current folder, or `-o`/`--output`, under its own name or `--name` — never over something already there unless `--overwrite` ([guide](guide/restore.md#copying-one-item-out)). |
| `s3cab verify <bucket>`                  | Check a repository's backups are complete and undamaged — every referenced file stored, at the right size (findings reported per set). |
| `s3cab forget --set <set> <snapshot>…`   | Remove snapshots from a backup: previews what would become unrestorable, then confirms once (`-f`/`--force` for scripts). The files themselves are left for `cleanup` to reclaim. |
| `s3cab delete --bucket <bucket> <hash>…` | Permanently delete content from every backup, named by hash — for things you no longer want stored at all. `s3cab find` produces the hashes; `--from-file` reads a saved list, `-n`/`--dry-run` previews, `-f`/`--force` skips the typed confirmation. |
| `s3cab cleanup <bucket>`                 | Reclaim storage held by objects no snapshot references — confirms first (`-n`/`--dry-run` previews, `-f`/`--force` for scripts). |

### Advanced

Plumbing and diagnostics: the building blocks the everyday commands compose. Most people
never run these directly.

| Command                 | What it does |
| ----------------------- | ------------ |
| `s3cab hashes <bucket>` | List a repository's stored object hashes, one per line — the same enumeration `verify` and `cleanup` diff, ready to pipe into ordinary shell tools ([guide](guide/maintenance.md#the-building-blocks-hashes-and-upload)). |
| `s3cab upload [<set>]`  | Put objects into a set's store directly: `--file` for a single file, `--dir` to seed from a folder, `-s`/`--snapshot` for everything a snapshot references. `--bucket` targets a raw bucket with no set ([guide](guide/maintenance.md#the-building-blocks-hashes-and-upload)). |
| `s3cab tree [<set>]`    | List the files a snapshot of the set would include, honouring exclude rules; `--excluded` lists what the patterns dropped instead, each with the pattern that matched it ([guide](guide/exclude.md)). |
| `s3cab prop <file>`     | Show the hash, size, and modified time of a single file. |

### Global options

These work on every command, and on `s3cab` itself:

| Option            | What it does |
| ----------------- | ------------ |
| `--json`          | Print machine-readable JSON instead of text ([guide](guide/output.md)); the shape may still change. |
| `-v`, `--version` | Print the version and exit. |
| `-h`, `--help`    | Show help — the command list, or one command's arguments, options and examples. |

`s3cab help exclude` prints the exclude-pattern reference without leaving the terminal, and
setting the `S3CAB_DEBUG` environment variable turns on verbose debug output.

## License

[GPL-3.0-or-later](LICENSE) © Allen Shiels

---

_Contributors: see [CONTRIBUTING.md](CONTRIBUTING.md) to get started (it links the
[CLA](CLA.md)); [CLAUDE.md](CLAUDE.md) for working conventions and architecture orientation,
[docs/adr/](docs/adr/) for the design decisions, and [GLOSSARY.md](GLOSSARY.md) for the
vocabulary._
