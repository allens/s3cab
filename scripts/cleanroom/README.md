# The clean-room exercise

A literal test of [ADR-0002](../../docs/adr/0002-no-lock-in-hard-constraint.md)'s
no-lock-in promise: a session that has read
[guide/format.md](../../guide/format.md) and **nothing else** writes a restorer
from scratch, and its output is compared byte-for-byte against s3cab's own. The
restorer is never the point. The point is the list of places the spec is
ambiguous, silent, or wrong, ranked by whether a wrong guess corrupts a restore
or merely costs the implementer an afternoon.

Reports so far: [run 1](../../docs/format-spec-audit.md) (2026-08-12, Python,
boto3) and [run 2](../../docs/format-spec-audit-2.md) (2026-08-20, C++23, no
SDK). Diffing a new run's list against the last one is what makes a re-run worth
doing — an item that reappears is a fix that didn't land.

**Two kinds of file live here, with opposite lifecycles.** `create.mjs`,
`stage.mjs` and `compare.py` are the harness: ours, maintained, and improved
every run as findings come in. [restorers/](restorers/) is append-only and
frozen — one file per run, never updated, because each one's value is being a
fixed reading of the spec on a given date.

A run, end to end:

```sh
node --env-file=.env.test scripts/setup-test-bucket.mjs --days 30 <bucket>
node --env-file=.env.test scripts/cleanroom/create.mjs --lang "C++" ~/cleanroom
node --env-file=.env.test scripts/cleanroom/stage.mjs --out ~/cleanroom
# hand the room over, then when it finishes:
python3 scripts/cleanroom/compare.py <its-restore-dir> ~/cleanroom/reference/<snapshot>
```

## create.mjs

Stages a directory for the *next* clean-room restorer: a byte copy of
[guide/format.md](../../guide/format.md), a brief naming the language, and
nothing else. `--lang` is a plain string because what makes a rerun worth doing
is a fresh reader rather than a new language, and the brief is language-neutral
apart from one sentence — which names no version and no toolchain, leaving the
session to find "the most modern version that comes as standard" on the machine
it's on.

The directory has to be **outside the repo**, and the script refuses otherwise:
a session opened inside is handed [CLAUDE.md](../../CLAUDE.md) before it reads
anything, and that file discusses the `#SNAPSHOT` header's UTC instant, the
`#DIR` headers, the drive-letter normalisation and the TSV encoding. Those are
restore-correctness facts the exercise exists to make someone derive, and the
contamination is invisible in the result — the ambiguity list simply comes back
shorter, which reads as a spec that has been fixed. Keep previous runs' reports
out of the directory too: diffing the lists afterwards is the reader's job.

The brief is written as the clean room's own `CLAUDE.md`, so the run starts from
a bare "go" instead of a pasted wall of text — and, because that file is
re-injected as the context compacts, the rule that matters survives a run long
enough to write a program, where an opening-turn instruction would scroll away.

`ENVIRONMENT.md` names **one** bucket. Copying `.env.test` across would be
handier and is the wrong shape: it also names the crash and conformance buckets,
whose suites assert whole-bucket state and which hold deliberately torn
repositories — snapshots published over swept objects, written on purpose by
`test/crash`. That is the exact signature this exercise hunts, so a session that
wandered into one would report a real observation as a spec defect. Pass
`--bucket`, or let `--env-file=.env.test` supply `S3CAB_TEST_BUCKET` and the
`AWS_*` settings without the file itself travelling.

Libraries come from the platform's packages, and the brief bars **any AWS SDK or
S3 client library, packaged or not** — the restorer signs its own requests, and
may not drive the `aws` CLI to do its work either. That rule has to name the SDK
rather than say "platform packages only", because the archive's coverage is
uneven: Ubuntu packages an SDK for Go, Ruby and Perl but none for C++, so the
looser wording would hand one language the thing it denies another and leave two
runs incomparable. Consulting the CLI while getting SigV4 right stays allowed
and is disclosed in the report — a development aid is not a dependency, and
whether signing is derivable from public docs alone is itself worth knowing.

The point is a second result beside the ambiguity list: s3cab depends on the AWS
SDK completely, so nothing has ever established what *reading* the format needs.
A restorer that talks to S3 with an HTTP client and nothing else is evidence for
[ADR-0002](../../docs/adr/0002-no-lock-in-hard-constraint.md)'s no-lock-in
promise of a kind a documented format can't be — and it is why the earlier
Python run doesn't answer this, having used boto3.

Credentials go over as static keys in `credentials.env`, resolved through the
SDK chain at staging time — `AWS_PROFILE` would be useless to a restorer with no
SDK to read `~/.aws/config` with. They are session credentials, so the run must
sign `x-amz-security-token` too, and they expire: `ENVIRONMENT.md` states the
deadline and tells the session that a 403 following requests that worked means
the window closed rather than a signing bug. Re-running with `--force` mints a
fresh window, so outliving the permission set's session duration (8 hours here,
12 being the IAM Identity Center maximum) costs a re-run, not an afternoon.

That refresh is why this is a separate script from `stage.mjs` and not a mode of
one: it runs 1..N times per exercise, mid-run, hours after the corpus is staged
and while the room is live. `stage.mjs` runs exactly once and would destroy the
run if a credential refresh dragged it along.

It warns about files it didn't write, rather than deleting them. A clean room
that gets moved or renamed can carry an older brief along beside the new one,
and the session reads both as readily.

```sh
node scripts/cleanroom/create.mjs --lang <language> [--bucket <name>] [--force] <dir>
node --env-file=.env.test scripts/cleanroom/create.mjs --lang "C++" ~/cleanroom
```

## stage.mjs

Builds the corpus a clean-room restorer is measured against: eight backup sets
in the bucket, plus the `reference/` trees inside the clean room, which are what
its output is compared to. Run it after `create.mjs`, before handing the room
over.

It is a committed script rather than a chat because run 1's corpus is **gone** —
staged by hand, and its harness "was a session artifact and is not preserved"
([run 1](../../docs/format-spec-audit.md)). The value of a re-run is diffing its
ambiguity list against the last one, and that comparison needs the same data
underneath. Every run that stages fixtures by hand throws it away again.

Which fixtures, and why each one, is the coverage matrix in the script's own
header: one line per audit finding F1–F16, naming the fixture that would catch a
regression — and naming the two findings a corpus *cannot* provoke (F4, F15)
rather than quietly dropping them so the table looks complete.

Run 2 added four more, each for a rule the corpus asserted but never made a run
*obey* — its report described its handling of all four as written and never
executed. `spread` is the only set with more than one member directory, without
which the two candidate restore layouts produce identical trees and the corpus
makes its own Tier 1 question unanswerable. (Two member dirs sharing a
*basename* are deliberately absent: s3cab refuses that under `--output`, so the
set would have no reference tree, and the refusal is already the answer.)
`faults/deleted.txt` is deleted and left deleted, so a file is absent *and*
recorded — F5's fixture re-backs its file up, which is the presence-wins trap
and leaves nothing for the skip path to skip. `corrupt` puts wrong bytes under a
right key, the case where the spec neither requires re-hashing a download nor
says what to do when it fails. And `faults` gets a second snapshot with its
`#END` trailer removed and the frame recompressed: truncating the compressed
bytes would test zstd's leniency instead, and the trailer's whole purpose is
catching a backup killed mid-write.

`reference/` holds what **s3cab itself restored**, not the source trees. A
correct restore legitimately differs from its source — no empty directories, no
symlinks, no permissions, mtimes rounded to the millisecond
([guide/format.md](../../guide/format.md)) — so comparing against the sources
would fail a restorer for being right. The script drives the real CLI as a
subprocess to produce them, with `S3CAB_HOME` pointed at a working directory so
your own `~/.s3cab` is untouched while `~/.aws` keeps working.

Four fixture groups **cannot exist on Windows**: NTFS forbids control characters
in names, strips trailing spaces, and folds case. They are skipped with a loud
notice naming each one, because a partial corpus that reads as a complete one is
the same silent-shortening failure the exercise exists to hunt. Keep them in the
corpus permanently anyway — for a future Windows clean-room run they *become*
the point, where a restorer that refuses them is behaving correctly and one that
silently strips the trailing space and reports success is not. A symlink, by
contrast, is attempted everywhere and skipped only on the error: Windows has
them, it just wants Developer Mode.

**It empties the bucket for you**, when the bucket is its own to empty. A
re-stage needs an empty repository — snapshots are immutable and a set name
belongs to whoever claimed it first — and there is never a reason to keep the
previous corpus, so the question worth asking is not "may I clear this?" but "is
this bucket mine to clear?": the wrong `--bucket`, an `.env.test` pointing
somewhere forgotten, a live integration run. The set names answer it, since the
integration suite names its sets for the clock (`rt1755…`) and never one of ours.
A bucket holding only our own names is cleared and reported; anything else and
the script stops and names what it found. It is a check and not a lock — a suite
that *starts* after the check still loses its in-flight objects.

`--trees-only` builds the trees, prints what this platform managed, and stops
before anything reaches S3 — worth it because staging writes well over a
thousand objects and claims every set name, and on Windows it would claim them
for a corpus missing every POSIX fixture. It takes the same arguments as the
real run plus the flag, so what you rehearse is the command you then run.

Two sets are deliberately broken, in four different ways, because s3cab's own
damage handling is the part a corpus most easily leaves untested. `faults` has
an object torn out of the store through the SDK with **no** deletion record (the
unexplained-damage case: report it, carry on, exit nonzero), one file deleted
*with* a record (the explained one, skipped with its date), and a snapshot
missing its trailer. `corrupt` has an object whose bytes don't hash to its key.
Their restores therefore exit nonzero, and the script reports that as expected
rather than failing — and their reference trees are whatever s3cab wrote before
it gave up, since a partial tree is the honest reference for a partial restore.
The damaged snapshot is backdated a minute so the intact one stays `faults`'s
latest; it exists only in S3, so the script restores it by name.

```sh
node scripts/cleanroom/stage.mjs --bucket <name> --out <cleanroom-dir> [--work <dir>]
node --env-file=.env.test scripts/cleanroom/stage.mjs --out ~/cleanroom --trees-only
```

The bucket wants a raised expiry first, or the corpus sweeps out from under the
next run: `node --env-file=.env.test scripts/setup-test-bucket.mjs --days 30 <bucket>`.

## compare.py

The differential verifier: walks two restored trees with **raw byte paths** and
compares the path set, per-file SHA-256, and `st_mtime_ns`. Preserved because
run 1's equivalent wasn't — that harness "was a session artifact and is not
preserved", which is half the reason its findings could never be re-tested.

Three details are the whole point. Byte paths, because a comparator that decodes
to `str` can normalise NFC/NFD apart or choke on the `\v`, `\f` and U+0085
fixtures. `st_mtime_ns`, because millisecond comparison would have hidden the
sub-millisecond defect that is run 2's finding 2. And directory mtimes reported
separately, since both tools create directories implicitly at restore time, so
those reflect the run rather than the format.

```sh
python3 scripts/cleanroom/compare.py <my-restore-dir> <reference-dir>
```

## restorers/

One program per run, each written from the spec alone, each **deliberately not
maintained** in step with s3cab. If one drifts from a future format, that drift
is a breaking format change to notice — not a bug to patch here.

### pyrestore.py — run 1

Python, from [guide/format.md](../../guide/format.md) alone; the experiment
behind [run 1](../../docs/format-spec-audit.md). Its inline `GUESS(n)` comments
are the raw form of that run's findings. An independent reading of the spec as
written on 2026-08-12. Needs Python ≥ 3.14 (stdlib zstd) and boto3.

```sh
python scripts/cleanroom/restorers/pyrestore.py --bucket <bucket> list-sets
python scripts/cleanroom/restorers/pyrestore.py --bucket <bucket> restore <set> <snapshot> --output <dir>
```

### cpprestore.cpp — run 2

C++23, behind [run 2](../../docs/format-spec-audit-2.md). Where `pyrestore.py`
answered whether the format is readable without s3cab, this one answers what
reading it *costs*: libcurl for HTTPS, OpenSSL for SHA-256/HMAC, libzstd for
decompression, and **no AWS SDK, no S3 client library, and no shelling out** —
SigV4 signed by hand, in about 80 lines, working on the first attempt against
the real endpoint. That reduces the vendor's whole SDK, for a reader, to an HTTP
client, two hash primitives, one decompressor and a page of signing arithmetic.
An independent reading of the spec as written on 2026-08-20.

```sh
g++ -std=c++23 -O2 -Wall -Wextra -o s3cab-restore \
  scripts/cleanroom/restorers/cpprestore.cpp -lcurl -lcrypto -lzstd
./s3cab-restore --bucket <bucket> --region <region> list
./s3cab-restore --bucket <bucket> --region <region> restore <set> <snapshot> <outdir>
```

Credentials come from `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` /
`AWS_SESSION_TOKEN` — it has no SDK to read `~/.aws` with, which is why
`create.mjs` stages static keys. Exit 2 means integrity faults, which it
enumerates after restoring everything restorable.
