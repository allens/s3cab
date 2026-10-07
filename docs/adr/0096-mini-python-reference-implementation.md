# A "back to basics" s3cab in Python, readable in half an hour

**Status:** proposed (2026-10-07) — the idea is settled; its scope and placement are not, and
nothing is built.

One of s3cab's founding ideas was that anyone who knew a little JavaScript could read the whole
thing in half an hour and understand how it worked. Features and robustness have since grown the
code by an order of magnitude over its core. That growth is accepted, and `src/` remains the real
tool. Alongside it there will be a **mini s3cab**: a separate, deliberately small implementation
that still works properly and passes the **half-hour reading test**.

## What is settled

- **Python, one file, boto3 the only dependency.** The standard library (3.14) covers the rest:
  `compression.zstd`, `hashlib`, `pathlib`, `argparse`. boto3 plays the part the AWS SDK plays
  under [0005](0005-builtins-over-dependencies.md): too big to hand-write, and its high-level
  `upload_file` hides multipart, retries and the credential chain behind one call that a reader
  can take on trust.
- **Same format, same bucket.** It reads and writes exactly what [guide/format.md](../../guide/format.md)
  specifies, so each tool can restore the other's backups. An independent second implementation
  is the strongest evidence for [0002](0002-no-lock-in-hard-constraint.md) (no lock-in), and a
  check on the spec itself: wherever the two disagree, either the spec or one of them is wrong.
- **"Works properly" is not negotiable; breadth is.** The half-hour budget is spent on
  functionality before optimisation. For example, `delete` probably earns its lines before hash
  reuse from the previous snapshot does.

## Why Python, not JavaScript

It is the most widely readable language for a short script. Its readers extend well beyond
s3cab's contributors, which is the audience no-lock-in is for. boto3's synchronous high-level
calls also read shorter than the JS SDK's command objects, `lib-storage` and stream plumbing.
JavaScript would have kept one language in the repo and a path from the mini tool into `src/`;
that was weighed and set aside.

## Open, to settle before building

- **Scope.** The floor is snapshot, upload and restore, done correctly:
  - the exact format, including UTF-8, refusing tab/CR/LF in paths, and never trimming a path;
  - objects first, snapshot last;
  - uploads verified with `ChecksumSHA256`;
  - restores that check each hash and write atomically;
  - `#ERROR`/`#SKIPPED` rows instead of aborting the run;
  - native paths on Windows, macOS and Linux.

  Candidates above the floor include `delete` (with deletion records), hash reuse, simple exclude
  patterns, `verify` and `list`.
- **Starting point.** A bash spike of the floor, [scripts/s3cab-mini.sh](../../scripts/s3cab-mini.sh), and the two bugs it hit are the cautionary tale for what the mini tool must get right.
- **Placement.** It is not a dev utility, so it doesn't belong in `scripts/`. The options are a
  top-level directory in this repo or a repository of its own.
- **How far it honours the full tool's state.** For example, whether it writes `sets/<set>/`
  markers so that full s3cab recognises a set the mini tool created, and how it treats a missing
  object that a deletion record explains.
