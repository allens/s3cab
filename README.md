# s3cab

[![npm](https://img.shields.io/npm/v/s3cab)](https://www.npmjs.com/package/s3cab)
[![status: WIP · pre-release](https://img.shields.io/badge/status-WIP%20%C2%B7%20pre--release-orange)](#status)
[![license: GPL-3.0-or-later](https://img.shields.io/badge/license-GPL--3.0--or--later-blue)](LICENSE)
[![node: ≥26.3.0](https://img.shields.io/badge/node-%E2%89%A526.3.0-brightgreen)](package.json)

**S3 Content Addressable Backup** — a command-line tool for backing up files to S3 (or
any S3-compatible object storage), storing data by the **hash of its contents** so that
identical files are never stored twice, in a format that will never lock you in.

**What it's for, day to day:** getting back files you deleted by accident, or pulling back
an earlier version of something — long after a sync service like OneDrive or Dropbox has
stopped keeping its short-lived version history. That everyday "I need that file back" is the
job s3cab is built around. Restoring an _entire_ dataset after a disaster works too, but it's
the rare backstop — the day-to-day use is recovering one file, or one old version.

> ⚠️ **Pre-release, under active development.** The full command set works today —
> snapshotting, comparing, backing up to S3, restoring, verifying, deleting snapshots, and
> reclaiming storage (see [Status](#status)). What's left before 1.0 is polish and
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

- **🧱 Modern, open building blocks.** Standard SHA-256 hashing, zstd compression, and a
  current Node.js runtime. Deliberately modern — but never proprietary.

## Status

s3cab records and compares the state of your files, organised into **backup sets** (a
named list of directories that snapshot as one unit), **backs them up to S3**, and **restores
them back**. You create a set once, then the commands act on it:

| Command                       | What it does                                                                  |
| ----------------------------- | ----------------------------------------------------------------------------- |
| `s3cab aws <bucket>`          | Write a CloudFormation template (+ print the steps) to stand up an **AWS** S3 bucket + locked-down identity as a backup destination ([guide](guide/aws.md)). |
| `s3cab provider`              | Set, clear, or show how s3cab connects to your storage provider — an AWS profile, or a custom endpoint/region/keys for any S3-compatible provider ([non-AWS setup](guide/aws.md#non-aws-providers)). |
| `s3cab setup <set> <directory>…` | Create a **backup set** (`--bucket` binds its cloud destination); its directories then live in an editable `dirs.txt`. |
| `s3cab reattach <set>`       | Attach this machine to a set that already exists in the cloud — a replacement/recovery machine (`--bucket` holds it). Pulls its config + history, not the files (that's `restore`). |
| `s3cab snapshot [<set>]`      | Take a snapshot of a set, then show what changed since the previous one.      |
| `s3cab list [<set>]`          | List your backup sets and their snapshots — a named set in detail, or its cloud backups with `--remote`. |
| `s3cab compare [<set>]`       | Show what changed between two snapshots (added / moved / modified / deleted). |
| `s3cab backup [<set>]`        | Take a fresh snapshot and upload it (and the files it references) to S3.       |
| `s3cab status [<set>]`        | Show what is backed up and what a backup would upload.                        |
| `s3cab restore <set> [paths…]` | Recover from a set's cloud backup — specific paths or the whole set; skips existing files. |
| `s3cab verify <bucket>`       | Check a repository's backups are complete and undamaged — every referenced file is stored, at the right size (findings reported per set). |
| `s3cab delete <set> --snapshot <name>` | Delete one snapshot from a backup (confirms first; leaves the files it referenced for `cleanup` to reclaim). |
| `s3cab cleanup <bucket>`      | Reclaim storage held by objects no snapshot references — a dry run by default; `--delete` actually removes them. |
| `s3cab tree [<set>]`          | List the files a snapshot of the set would include, honouring exclude rules.  |
| `s3cab prop <file>`           | Show the hash, size, and modified time of a single file.                      |

A set's configuration is plain files you can open and edit (`~/.s3cab/sets/<set>/`). When
you have only one set you can leave the name out — plain `s3cab snapshot` just works.
(`restore` is the deliberate exception: it always takes the set name.)

The everyday use is **getting specific files back**: pass `paths…` to restore just part of a
set, and `--snapshot <name>` to pull an _older_ version instead of the latest. By default
`restore` leaves files that still exist untouched — your accidental deletions come back while
everything else stays put — so pass `--overwrite` when you actually want to replace what's
there.

With no `paths…` it restores the **whole set** — the disaster-recovery backstop. Files go
back to the locations they were backed up from; pass `--output <dir>` to recover under a
directory you choose instead (each backed-up directory lands as `<dir>/<directory-name>/…`), which is
how you restore a backup whose original paths don't fit this machine — a different drive
layout, or another OS. To recover onto a **fresh machine**, attach it to the existing backup —
`s3cab reattach <set> --bucket <bucket>` — then `restore`.

Run any command with `--help` to see its options. (Two cloud plumbing commands, `hashes`
and `upload`, also work already — advanced building blocks covered under
[Cloud repositories](#cloud-repositories).)

### Coming next

The full command set now works — snapshot, compare, backup, restore, verify, delete, and
cleanup (see [Status](#status)). What's next is **retention-policy automation** (keep-last /
daily / weekly / monthly rules, built on top of the `delete` and `cleanup` primitives) — the
shape will be designed once real usage shows what people need.

(`list --remote`, `restore --output`, and `verify` already work. `compare` is local-only by
design — adopting a set on a new machine pulls its snapshot history down, so a plain local
`compare` covers the cloud copy too.)

### Cloud repositories

A cloud **repository** lives in its own S3 bucket — _one repository is one bucket_, not a
directory inside a shared one. Inside, the structure is fixed and well-known, so anything
(s3cab, another tool, or you by hand) can find everything by convention:

```
s3://my-backup-bucket/
  objects/<sha256>                       # your files, each stored once under its content hash
  snapshots/<set>/…                      # the snapshot files that say which objects make up each snapshot
```

One bucket can hold **many backup sets** — your own, and other people's or machines' — all
sharing `objects/`, so duplicate content is stored once across everything in the bucket. Each
set keeps its own snapshot files under its own prefix, `snapshots/<set>/` (a set name is
unique within a bucket: claimed first-come, and taken over on a new machine with
`reattach`). A snapshot file only ever appears in `snapshots/` after every file it
references is safely in `objects/`, so any snapshot file you find is complete and restorable.

That fixed layout is the no-lock-in promise in practice: to recover a file by hand you
look up its hash in a snapshot and download `objects/<that-hash>`. The full contract —
the repository layout, the snapshot-file grammar, and a recover-by-hand walkthrough — is
written down in [guide/format.md](guide/format.md), **the format spec**.

**Turn on bucket versioning** — it is your ransomware and fat-finger backstop. With versioning
on, `s3cab delete` (drop a snapshot) and `s3cab cleanup` (reclaim unreferenced objects) issue
only _soft_ deletes: they write a delete marker and the bytes live on as a recoverable
noncurrent version, so a mistake — or a leaked key — can add to your backup but can never
permanently destroy its history. `s3cab aws` turns versioning on for you; if you set a bucket
up by hand, enable it yourself. The trade-off is that reclaimed space frees only once a
lifecycle rule expires those noncurrent versions — [guide/aws.md](guide/aws.md) walks through
the full model.

The `hashes` command lists a repository's stored object hashes, **one per line**. It's an
advanced/diagnostic command — most people never run it directly; its real job is composition:
the flat hash-per-line stream pipes into ordinary shell tools, so you can reproduce s3cab's
own maintenance by hand (it's the same enumeration `verify`/`cleanup` diff):

```console
> s3cab hashes my-backup-bucket               # one sha256 per line, to stdout
> s3cab hashes my-backup-bucket > have.txt    # …or redirect to a file
```

Its write counterpart, `upload`, is set-scoped and does the same two jobs `backup` composes
(ADR-0044): put **a single file** into the store at `objects/<sha256>`, or upload **a whole
snapshot's** objects then its snapshot file. Content already in the store is skipped
automatically — identical bytes always map to the same key — unless you `--force` a
single-file re-upload:

```console
> s3cab upload photos --file C:\Users\me\Photos\beach.jpg   # one object into the set's bucket
> s3cab upload photos --snapshot 2026-06-12T0915            # that snapshot's objects, snapshot file last
> s3cab upload --bucket my-backup-bucket --file beach.jpg   # raw bucket, no set (ambient credentials)
```

(Like `hashes`, `upload` is plumbing: a lower-level building block beside the snapshot-driven
`backup`, which is just `snapshot` + `upload`. A set supplies its own bucket; `--bucket` is the
raw escape hatch for seeding a file into a bucket that isn't one of your sets.)

### Authentication

s3cab talks to S3 with your **existing AWS credentials** wherever possible, and never
edits `~/.aws/config` or `~/.aws/credentials`. It resolves credentials in this order:

1. the active backup **set's env file**, `~/.s3cab/sets/<set>/env`, if present (handy for
   `AWS_*` keys, a profile, or an endpoint — including some S3-compatible providers). It's the
   one s3cab config layer — where `s3cab setup` records the set's bucket, and where its auth
   lives — applied over your shell (a file value always beats the shell). s3cab does **not**
   read a `.env` from the current directory, and there is no per-user s3cab file: your
   machine-wide default is your ordinary AWS setup (step 2). The **`provider`** command writes a
   set's file for you: `s3cab provider --profile <name>` for an AWS profile,
   `--endpoint <url> --region <r>` for an S3-compatible provider, and `--keys` for an access
   key + secret (prompted or piped — never flags). `s3cab setup` takes the **same** knobs, so a
   new set can be pointed at its provider in one command. A set signs in **one** way — a profile,
   access keys, *or* keyless Roles Anywhere (below), not several — so setting one clears the
   others. Long-lived provider keys needn't sit in plaintext — the
   [cloud-bucket guide](guide/aws.md#keeping-the-secret-out-of-plaintext) shows how to serve
   them from a secret manager through a `credential_process` profile.
2. the **standard AWS credential chain** — `AWS_PROFILE`, shared profiles (including SSO
   sessions from `aws sso login` and `credential_process`), and `AWS_*` environment variables.

If neither is configured, s3cab stops and tells you what to do. Run **`s3cab help provider`**
for the full details. s3cab has no sign-in flow of its own and stores no credentials: AWS
IAM Identity Center (SSO) users sign in with the AWS CLI's `aws sso login`, and s3cab picks
the session up automatically through the standard chain.

**Keyless access with IAM Roles Anywhere (AWS, recommended).** Instead of a long-lived
access key, a set can authenticate with an X.509 client certificate and receive **short-lived**
session credentials. `s3cab aws <bucket> --roles-anywhere` generates a machine-level CA + client
certificate under `~/.s3cab/roles-anywhere/` (the private key never leaves your machine) and
writes a CloudFormation template to `~/.s3cab/<bucket>.yaml`; after deploying it and capturing the ARNs
(`--save --from-stack`), point a set at it with `s3cab setup … --roles-anywhere` or
`s3cab provider --roles-anywhere <set>`. The durable secret never travels, only a ~1-hour token
flows to AWS, and the trust anchor gives you central revocation. It's a best-effort win, not a
vault: a leaked `0600` key file is about as exposed as a leaked access key against file theft —
the real backstop is the soft-delete-only policy, so even a stolen identity can't destroy backup
history. The [cloud-bucket guide](guide/aws.md#--roles-anywhere--keyless-certificate-based-access)
has the full model.

## Quick start

```console
# Create a backup set (a name, the directories it contains, and the bucket to back up to):
> s3cab setup photos C:\Users\me\Photos --bucket my-backups

# Snapshot the set. With only one set, you can leave its name out:
> s3cab snapshot
Generating new snapshot: 2025-11-11T0830

# ...add, move, or edit some files, then snapshot again —
# s3cab reports what changed since last time:
> s3cab snapshot
Generating new snapshot: 2025-11-12T0915
photos: ~/Pictures  2025-11-11T0830 → 2025-11-12T0915

Added (1)
  2025/new.jpg

Moved (1)
  2024/IMG_001.jpg → 2024/sorted/IMG_001.jpg

1 added, 0 renamed, 1 moved, 0 modified, 0 deleted · 812 KB changed

# List your backup sets and their snapshots:
> s3cab list
photos:
  2025-11-12T0915
  2025-11-11T0830

# Compare any two snapshots (defaults to the latest two; --since picks an older one):
> s3cab compare --since 2025-11-11T0830
```

How to read the report — the sections and the `(duplicate of …)` note — is
covered in [guide/compare.md](guide/compare.md). Add `--json` to any command for
machine-readable output ([guide/output.md](guide/output.md)).

## How it works

Running `snapshot` walks every directory in the set and writes one immutable snapshot file into
the set's own directory under your home directory — never inside your backed-up files:

```
~/.s3cab/sets/photos/
  dirs.txt                       # the directories that make up the set
  env                            # the set's identity + (optional) cloud bucket
  exclude.txt                    # optional: glob patterns for files to skip
  snapshots/
    2025-11-10T2104.tsv.zst      # one snapshot per run (zstd-compressed TSV)
    2025-11-11T0830.tsv.zst
```

Each snapshot file is a tab-separated table of `hash`, `size`, `modified-time`, and `path` —
fixed-width leading columns so it stays readable, with the variable-length (and
platform-native, absolute) path last. It opens with a header naming the set and each member
directory, so a snapshot file is self-describing even found on its own:

```
#SNAPSHOT                                                            2025-11-11T08:30          photos
#DIR                                                                                           C:\Users\me\Photos
3b8e...c0a1                                                  4915200  2025-06-01T12:00:00.000Z  C:\Users\me\Photos\2025\beach.jpg
e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855           0  2024-01-01T00:00:00.000Z  C:\Users\me\Photos\2024\empty.txt
```

To inspect a compressed snapshot by hand, decompress it with any zstd tool
(`zstd -d snapshot.tsv.zst`) and open the resulting `.tsv`. That's the whole recovery
story — no s3cab required. (The complete stored format is specified in
[guide/format.md](guide/format.md).)

Exclude rules live in `~/.s3cab/sets/<set>/exclude.txt`, applied relative to each of the
set's directories; run `s3cab help exclude` for a quick reference, or see
[guide/exclude.md](guide/exclude.md) for the full guide.

> s3cab is developed primarily for **Windows**; Linux and macOS support is a best-effort
> goal for later. Snapshot paths are absolute and use the native OS path style.

## Installing & running

Pick whichever suits you — all three run the same tool:

- **npm** (needs [Node.js](https://nodejs.org) ≥ 26.3.0):

  ```console
  > npm install -g s3cab
  > s3cab setup photos C:\Users\me\Photos --bucket my-backups
  > s3cab snapshot
  ```

- **Prebuilt binary** — download the archive for your platform from the
  [Releases](https://github.com/allens/s3cab/releases) page and run `s3cab`. No Node.js
  required. (See the macOS note below.)

- **From source** (needs Node.js ≥ 26.3.0) — clone the repo and run the entry point
  directly:

  ```console
  > node src/s3cab.mjs setup photos C:\Users\me\Photos --bucket my-backups
  > node src/s3cab.mjs snapshot
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
[CLA](CLA.md)); [CLAUDE.md](CLAUDE.md) for working conventions and architecture orientation,
[docs/adr/](docs/adr/) for the design decisions, and [CONTEXT.md](CONTEXT.md) for the
vocabulary._
