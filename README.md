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

- **🧱 Modern, open building blocks.** Standard SHA-256 hashing, zstd compression, and a
  current Node.js runtime. Deliberately modern — but never proprietary.

## Installing & running

Pick whichever suits you — all three run the same tool. Then head to the
[Quick start](#quick-start).

- **npm** (needs [Node.js](https://nodejs.org) ≥ 26.3.0):

  ```console
  > npm install -g s3cab
  ```

- **Prebuilt binary** — download the archive for your platform from the
  [Releases](https://github.com/allens/s3cab/releases) page and run `s3cab`. No Node.js
  required. Windows x64, Linux x64 and arm64, and macOS on Apple Silicon (see the
  [macOS note](#macos-note) below). Every release also carries `s3cab.js`, a portable
  single-file bundle that runs anywhere Node.js does.

- **From source** (needs Node.js ≥ 26.3.0) — clone the repo and run the entry point
  directly, substituting `node src/s3cab.mjs` for `s3cab` in any command:

  ```console
  > node src/s3cab.mjs --help
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
Backed up 'photos' → snapshot 2025-11-12T0915
Scanned 1,312 files (4.2GB) in 2m 41s
Uploaded 1,240 objects (4.2GB) in 6m 08s
First backup — every file is new.

# 3. Deleted a file by accident? Get just that one back:
> s3cab restore --set photos C:\Users\me\Photos\beach.jpg
Contacting the cloud…
Restored 1 file from 'photos' (snapshot 2025-11-12T0915).
```

That's the whole loop: set up once, `backup` whenever, `restore` when you need something
back. To pull an _older_ version, add `--snapshot <name>`; to recover everything (the
disaster-recovery case), run `restore` with no paths. By default `restore` leaves files that
still exist untouched — your accidental deletions come back while everything else stays put —
so pass `--overwrite` when you actually want to replace what's there.
[guide/restore.md](guide/restore.md) covers all of it.

Step 1 also drops a starter `exclude.txt` beside the set and lists what it will skip by
default — `node_modules`, `.git`, and the usual OS clutter. Edit that file to change it
([guide/exclude.md](guide/exclude.md), or `s3cab help exclude`).

### Watching what changes between backups

`snapshot` records the current state of a set and shows what changed since the previous
snapshot. Because it matches on content, a moved or renamed file is recognised as the _same_
file, not a delete plus an add:

```console
> s3cab snapshot
Using s3cab home 'C:\Users\you\.s3cab'
Reading previous snapshot '~\.s3cab\sets\photos\snapshots\2025-11-11T0830.tsv.zst'
Snapshotting 'photos/2025-11-12T0915' ('~\.s3cab\sets\photos\snapshots\2025-11-12T0915.tsv.zst'):
Finding files in '~\Photos'… 1,204 in 3 sec
Comparing '2025-11-11T0830' → '2025-11-12T0915'
photos: ~\Photos  2025-11-11T0830 → 2025-11-12T0915

Added (1)
  2025\new.jpg

Moved (1)
  2024\IMG_001.jpg → 2024\sorted\IMG_001.jpg

1 added, 0 renamed, 1 moved, 0 modified, 0 deleted · 812.0kB changed
```

`list` shows your sets and their snapshots; `compare` diffs any two (`--since` picks an
older one). How to read the report — the sections and the `(duplicate of …)` note — is in
[guide/compare.md](guide/compare.md). Add `--json` to any command for machine-readable
output ([guide/output.md](guide/output.md)).

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
| `s3cab snapshot [<set>]` | Take a snapshot of the set, then show what changed since the previous one. `--rehash` re-hashes every file instead of reusing unchanged files' hashes; `--include-online-only` downloads online-only files (OneDrive and the like) instead of skipping them. |
| `s3cab list [<set>]`     | List your backup sets and their snapshots — name a set for its detail, `-r`/`--remote` for its cloud backups, `-l`/`--latest` for just the newest. |
| `s3cab compare [<set>]`  | Show what changed between two snapshots — added / renamed / moved / modified / deleted; `--since` and `--until` choose which two ([guide](guide/compare.md)). |
| `s3cab status [<set>]`   | Show what is backed up already, and what the next `backup` would upload. |

### Setup

Run once: a bucket to back up to, credentials to reach it, and the set itself.

| Command                                | What it does |
| -------------------------------------- | ------------ |
| `s3cab aws <bucket>`                   | Write a CloudFormation template — and print the steps — to stand up an **AWS** S3 bucket plus a locked-down identity; `--roles-anywhere` builds the keyless certificate identity instead ([guide](guide/aws.md)). |
| `s3cab provider [<set>]`               | Set, clear, or show how s3cab reaches your storage: `--profile` for an AWS profile, `--endpoint` + `--region` for any [S3-compatible provider](guide/aws.md#non-aws-providers), `--keys` to be prompted for an access key, `--unset` to remove one ([guide](guide/auth.md)). |
| `s3cab setup --set <set> <directory>…` | Create a **backup set** from one or more directories; `--bucket` binds its cloud destination, and it takes the same provider flags as `provider`. Its directories then live in an editable `dirs.txt`. |
| `s3cab reattach <set>`                 | Attach this machine to a set that already exists in the cloud — a replacement or recovery machine (`--bucket` holds it). Pulls its config and snapshot history, not the files (that's `restore`). |

### Backup & restore

The cloud round trip, plus the maintenance that keeps a repository healthy
([guide](guide/maintenance.md)).

| Command                                  | What it does |
| ---------------------------------------- | ------------ |
| `s3cab backup [<set>]`                   | Take a fresh snapshot and upload it — and the files it references — to the set's bucket. `--include-online-only` backs up online-only files too, rather than skipping them. |
| `s3cab restore --set <set> [<path>…]`    | Recover from the set's cloud backup: name paths for specific files, or none for the whole set. `--snapshot` pulls an older version, `--overwrite` replaces files that still exist, `-o`/`--output` restores under a directory you choose ([guide](guide/restore.md)). |
| `s3cab verify <bucket>`                  | Check a repository's backups are complete and undamaged — every referenced file stored, at the right size (findings reported per set). |
| `s3cab forget --set <set> <snapshot>…`   | Remove snapshots from a backup: previews what would become unrestorable, then confirms once (`-f`/`--force` for scripts). The files themselves are left for `cleanup` to reclaim. |
| `s3cab delete --bucket <bucket> <hash>…` | Permanently delete content from every backup, named by hash — for things you no longer want stored at all. `s3cab find` produces the hashes; `--from-file` reads a saved list, `-n`/`--dry-run` previews, `-f`/`--force` skips the typed confirmation. |
| `s3cab cleanup <bucket>`                 | Reclaim storage held by objects no snapshot references — confirms first (`-n`/`--dry-run` previews, `-f`/`--force` for scripts). |

### Advanced

Plumbing and diagnostics: the building blocks the everyday commands compose. Most people
never run these directly.

| Command                 | What it does |
| ----------------------- | ------------ |
| `s3cab hashes <bucket>` | List a repository's stored object hashes, one per line — the same enumeration `verify` and `cleanup` diff, ready to pipe into ordinary shell tools ([below](#cloud-repositories)). |
| `s3cab upload [<set>]`  | Put objects into a set's store directly: `--file` for a single file, `--dir` to seed from a folder, `-s`/`--snapshot` for everything a snapshot references. `--bucket` targets a raw bucket with no set ([below](#cloud-repositories)). |
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

## Status

s3cab records and compares the state of your files, organised into **backup sets** (a
named list of directories that snapshot as one unit), **backs them up to S3**, and **restores
them back**. You create a set once, then the commands above act on it; a set's configuration
is plain files you can open and edit (`~/.s3cab/sets/<set>/`).

The everyday use is **getting specific files back**: pass `paths…` to restore just part of a
set, and `--snapshot <name>` to pull an _older_ version instead of the latest. With no
`paths…` it restores the **whole set** — the disaster-recovery backstop. Files go back to the
locations they were backed up from; pass `--output <dir>` to recover under a directory you
choose instead (each backed-up directory lands as `<dir>/<directory-name>/…`), which is how
you restore a backup whose original paths don't fit this machine — a different drive layout,
or another OS. To recover onto a **fresh machine**, attach it to the existing backup —
`s3cab reattach <set> --bucket <bucket>` — then `restore`. The full walkthrough is in
[guide/restore.md](guide/restore.md).

### Coming next

The full command set now works — snapshot, compare, backup, restore, verify, forget, delete,
and cleanup (see the [Command reference](#command-reference)). What's next is
**retention-policy automation** (keep-last / daily / weekly / monthly rules, built on top of
the `forget` and `cleanup` primitives) — the shape will be designed once real usage shows what
people need.

(`compare` is local-only by design — attaching a set on a new machine pulls its snapshot
history down with it, so a plain local `compare` covers the cloud copy too.)

## How it works

Running `snapshot` walks every directory in the set and writes one immutable snapshot file into
the set's own directory under your home directory — never inside your backed-up files:

```
~/.s3cab/sets/photos/
  dirs.txt                       # the directories that make up the set — yours to edit
  env                            # S3CAB_BUCKET=… plus how this set signs in
  exclude.txt                    # glob patterns for files to skip — yours to edit
  snapshots/
    2025-11-10T2104.tsv.zst      # one snapshot per run (zstd-compressed TSV)
    2025-11-11T0830.tsv.zst
```

Editing a set _is_ editing these files, and deleting the directory deletes the set. Only
`env` is unrecoverable — everything else can be pulled back down from the bucket with
`s3cab reattach`.

Each snapshot file is a tab-separated table of `hash`, `size`, `modified-time`, and `path` —
fixed-width leading columns so it stays readable, with the variable-length (and
platform-native, absolute) path last. It opens with a header naming the set, when the
snapshot was taken and each member directory — so a snapshot file is self-describing even
found on its own — and closes with `#END`, so a truncated one can be told from a whole one:

```
#SNAPSHOT                                                       	    photos	2025-11-11T08:30:12.418Z	2025-11-11T0830 Europe/London
#DIR                                                            	          	                        	C:\Users\me\Photos
3b8e2f61c0f4b9d7a5e8c31d06fa47b2e9d0c85417ab3f6209d4e7c1b8a05c0a	   4915200	2025-06-01T12:00:00.000Z	C:\Users\me\Photos\2025\beach.jpg
e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855	         0	2024-01-01T00:00:00.000Z	C:\Users\me\Photos\2024\empty.txt
#END
```

Every line has the same four fields — hash (64), size (10), modified time (24), then the
path — space-padded to those widths _and_ separated by tabs, so it reads as a table in an
editor and parses as clean TSV in a script. The metadata lines pad the columns they don't
use, which is why `#DIR` looks indented.

To inspect a compressed snapshot by hand, decompress it with any zstd tool
(`zstd -d snapshot.tsv.zst`) and open the resulting `.tsv`. That's the whole recovery
story — no s3cab required. (The complete stored format is specified in
[guide/format.md](guide/format.md).)

Exclude rules live in `~/.s3cab/sets/<set>/exclude.txt`, applied relative to each of the
set's directories; run `s3cab help exclude` for a quick reference, or see
[guide/exclude.md](guide/exclude.md) for the full guide.

> The test suite runs on Windows, Linux and macOS on every change, and no binary ships until
> it has backed up and restored real files through a real S3 bucket **on its own platform** —
> that round trip is a release gate, not a nightly. Snapshot paths are absolute and use the
> native OS path style — `restore --output` is what carries a backup across the divide.

## Cloud repositories

A cloud **repository** lives in its own S3 bucket — _one repository is one bucket_, not a
directory inside a shared one. Inside, the structure is fixed and well-known, so anything
(s3cab, another tool, or you by hand) can find everything by convention:

```
s3://my-backup-bucket/
  objects/<sha256>                 # your files, each stored once under its content hash
  snapshots/<set>/<name>.tsv.zst   # the snapshot files saying which objects make up each backup
  sets/<set>/                      # each set's config + the marker claiming its name
    info                             # the machine that created it, and when
    dirs.txt                         # its member directories
    exclude.txt                      # its exclude patterns, if it has any
  objects.deleted-<n>.tsv          # what `s3cab delete` removed on purpose (absent until it runs)
```

One bucket can hold **many backup sets** — your own, and other people's or machines' — all
sharing `objects/`, so duplicate content is stored once across everything in the bucket. Each
set keeps its own snapshot files under its own prefix, `snapshots/<set>/`, and its config
under `sets/<set>/` — which is both how a set name is claimed (first-come, taken over on a
new machine with `reattach`) and how that machine gets the set's directories and exclude
rules back. The set's local `env` file is never uploaded: it can hold credentials.

A snapshot file only ever appears in `snapshots/` after every file it references is safely in
`objects/`, so any snapshot file you find is complete and restorable. Snapshots are never
rewritten either — which is why `delete` records what it removed in `objects.deleted-<n>.tsv`
instead of editing history, so a later `verify` reads a deliberate gap as intended rather than
as damage.

That fixed layout is the no-lock-in promise in practice: to recover a file by hand you
look up its hash in a snapshot and download `objects/<that-hash>`. The full contract —
the repository layout, the snapshot-file grammar, and a recover-by-hand walkthrough — is
written down in [guide/format.md](guide/format.md), **the format spec**.

**Turn on bucket versioning** — it is your ransomware and fat-finger backstop. With versioning
on, `s3cab forget` (drop a snapshot) and `s3cab cleanup` (reclaim unreferenced objects) issue
only _soft_ deletes: they write a delete marker and the bytes live on as a recoverable
noncurrent version, so a mistake — or a leaked key — can add to your backup but can never
permanently destroy its history. `s3cab aws` turns versioning on for you; if you set a bucket
up by hand, enable it yourself. The trade-off is that reclaimed space frees only once a
lifecycle rule expires those noncurrent versions — [guide/aws.md](guide/aws.md) walks through
the full model, and [guide/maintenance.md](guide/maintenance.md) covers keeping a repository
healthy over time (`verify` / `forget` / `cleanup`).

The `hashes` command lists a repository's stored object hashes, **one per line**. It's an
advanced/diagnostic command — most people never run it directly; its real job is composition:
the flat hash-per-line stream pipes into ordinary shell tools, so you can reproduce s3cab's
own maintenance by hand (it's the same enumeration `verify`/`cleanup` diff):

```console
> s3cab hashes my-backup-bucket               # one sha256 per line, to stdout
> s3cab hashes my-backup-bucket > have.txt    # …or redirect to a file
```

Its write counterpart, `upload`, is set-scoped and does the jobs `backup` composes: put **a
single file** into the store at `objects/<sha256>`, seed the store from **a folder**, or
upload **a whole snapshot's** objects and then its snapshot file. Content already in the
store is skipped automatically — identical bytes always map to the same key — unless you
`--force` a single-file re-upload:

```console
> s3cab upload photos --file C:\Users\me\Photos\beach.jpg   # one object into the set's bucket
> s3cab upload photos --dir C:\Users\me\Photos\2026         # a folder's objects, no snapshot
> s3cab upload photos --snapshot 2026-06-12T0915            # that snapshot's objects, snapshot file last
> s3cab upload --bucket my-backup-bucket --file beach.jpg   # raw bucket, no set (ambient credentials)
```

(Like `hashes`, `upload` is plumbing: a lower-level building block beside the snapshot-driven
`backup`, which is just `snapshot` + `upload`. A set supplies its own bucket; `--bucket` is the
raw escape hatch for seeding a file into a bucket that isn't one of your sets.)

## Authentication

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

If neither is configured, s3cab stops and tells you what to do. s3cab has no sign-in flow of
its own: AWS IAM Identity Center (SSO) users sign in with the AWS CLI's `aws sso login`, and
s3cab picks the session up automatically through the standard chain. The only credentials it
ever writes are the ones you hand it with `--keys`, and those go in the set's own `env` file
where you can read or delete them. The full picture — the four sign-in modes, where s3cab
looks, and what to do when the server rejects your credentials — is in
[guide/auth.md](guide/auth.md); `s3cab help provider` has the same material in the terminal.

**Keyless access with IAM Roles Anywhere (AWS, recommended).** Instead of a long-lived
access key, a set can authenticate with an X.509 client certificate and receive **short-lived**
session credentials. `s3cab aws <bucket> --roles-anywhere` generates a machine-level CA + client
certificate under `~/.s3cab/roles-anywhere/` (the private key never leaves your machine) and
writes a CloudFormation template to `~/.s3cab/<bucket>.yaml`; after deploying it and capturing
the ARNs (`--save --from-stack`), point a set at it with `s3cab setup --set … --roles-anywhere` or
`s3cab provider --roles-anywhere <set>`. The durable secret never travels, only a ~1-hour token
flows to AWS, and the trust anchor gives you central revocation. It's a best-effort win, not a
vault: a leaked `0600` key file is about as exposed as a leaked access key against file theft —
the real backstop is the soft-delete-only policy, so even a stolen identity can't destroy backup
history. The [cloud-bucket guide](guide/aws.md#--roles-anywhere--keyless-certificate-based-access)
has the full model.

## License

[GPL-3.0-or-later](LICENSE) © Allen Shiels

---

_Contributors: see [CONTRIBUTING.md](CONTRIBUTING.md) to get started (it links the
[CLA](CLA.md)); [CLAUDE.md](CLAUDE.md) for working conventions and architecture orientation,
[docs/adr/](docs/adr/) for the design decisions, and [CONTEXT.md](CONTEXT.md) for the
vocabulary._
