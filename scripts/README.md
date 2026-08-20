# Dev scripts

Ad-hoc developer utilities. These are **not** part of the published package or
the automated test suite — run them by hand with `node` (or `python` where a
script says so) when needed.

## pyrestore.py

An independent s3cab restorer written in Python from
[guide/format.md](../guide/format.md) **alone** — the experiment behind the
[format-spec clean-room audit](../docs/format-spec-audit.md), which tested the
no-lock-in promise literally and ranked every gap the spec left. Its inline
`GUESS(n)` comments are the raw findings. Deliberately **not** maintained in
step with s3cab: its value is being an independent reading of the spec as
written on 2026-08-12 — if it drifts from a future format, that drift is a
breaking format change to notice, not a bug to patch here. Needs Python ≥ 3.14
(stdlib zstd) and boto3.

```sh
python scripts/pyrestore.py --bucket <bucket> list-sets
python scripts/pyrestore.py --bucket <bucket> restore <set> <snapshot> --output <dir>
```

## cpprestore.cpp

The **second** independent restorer, written in C++23 from
[guide/format.md](../guide/format.md) alone — the experiment behind
[run 2 of the clean-room audit](../docs/format-spec-audit-2.md). Where
[pyrestore.py](#pyrestorepy) answered whether the format is readable without
s3cab, this one answers what reading it *costs*: libcurl for HTTPS, OpenSSL for
SHA-256/HMAC, libzstd for decompression, and **no AWS SDK, no S3 client library,
and no shelling out** — SigV4 is signed by hand, in about 80 lines, and worked
on the first attempt against the real endpoint. That reduces the vendor's whole
SDK, for a reader, to an HTTP client, two hash primitives, one decompressor and
a page of signing arithmetic, which is evidence for
[ADR-0002](../docs/adr/0002-no-lock-in-hard-constraint.md)'s no-lock-in promise
of a kind a documented format can't be.

Deliberately **not** maintained in step with s3cab, for the same reason as
`pyrestore.py`: its value is being an independent reading of the spec as written
on 2026-08-20. Drift is a breaking format change to notice, not a bug to fix
here.

```sh
g++ -std=c++23 -O2 -Wall -Wextra -o s3cab-restore scripts/cpprestore.cpp -lcurl -lcrypto -lzstd
./s3cab-restore --bucket <bucket> --region <region> list
./s3cab-restore --bucket <bucket> --region <region> restore <set> <snapshot> <outdir>
```

Credentials come from `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` /
`AWS_SESSION_TOKEN` — it has no SDK to read `~/.aws` with, which is why
`create-cleanroom.mjs` stages static keys. Exit 2 means integrity faults, which
it enumerates after restoring everything restorable.

## cleanroom-compare.py

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
python3 scripts/cleanroom-compare.py <my-restore-dir> <reference-dir>
```

## create-cleanroom.mjs

Stages a directory for the *next* clean-room restorer: a byte copy of
[guide/format.md](../guide/format.md), a brief naming the language, and nothing
else. `--lang` is a plain string because what makes a rerun worth doing is a
fresh reader rather than a new language, and the brief is language-neutral apart
from one sentence — which names no version and no toolchain, leaving the session
to find "the most modern version that comes as standard" on the machine it's on.

The directory has to be **outside the repo**, and the script refuses otherwise:
a session opened inside is handed [../CLAUDE.md](../CLAUDE.md) before it reads
anything, and that file discusses the `#SNAPSHOT` header's UTC instant, the
`#DIR` headers, the drive-letter normalisation and the TSV encoding. Those are
restore-correctness facts the exercise exists to make someone derive, and the
contamination is invisible in the result — the ambiguity list simply comes back
shorter, which reads as a spec that has been fixed. Keep the previous run's
report ([docs/format-spec-audit.md](../docs/format-spec-audit.md)) out of the
directory too: diffing the two lists afterwards is the reader's job, and an item
that reappears is a fix that didn't land.

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
[ADR-0002](../docs/adr/0002-no-lock-in-hard-constraint.md)'s no-lock-in promise
of a kind a documented format can't be — and it is why the earlier Python run
doesn't answer this, having used boto3.

Credentials go over as static keys in `credentials.env`, resolved through the
SDK chain at staging time — `AWS_PROFILE` would be useless to a restorer with no
SDK to read `~/.aws/config` with. They are session credentials, so the run must
sign `x-amz-security-token` too, and they expire: `ENVIRONMENT.md` states the
deadline and tells the session that a 403 following requests that worked means
the window closed rather than a signing bug. Re-running with `--force` mints a
fresh window, so outliving the permission set's session duration (8 hours here,
12 being the IAM Identity Center maximum) costs a re-run, not an afternoon.

It warns about files it didn't write, rather than deleting them. A clean room
that gets moved or renamed can carry an older brief along beside the new one,
and the session reads both as readily.

```sh
node scripts/create-cleanroom.mjs --lang <language> [--bucket <name>] [--force] <dir>
node --env-file=.env.test scripts/create-cleanroom.mjs --lang "C++" ~/cleanroom
```

## cleanroom-fixtures.mjs

Builds the corpus a clean-room restorer is measured against: six backup sets in
the bucket, plus the `reference/` trees inside the clean room, which are what its
output is compared to. Run it after `create-cleanroom.mjs`, before handing the
room over.

It is a committed script rather than a chat because run 1's corpus is **gone** —
staged by hand, and its harness "was a session artifact and is not preserved"
([format-spec audit](../docs/format-spec-audit.md)). The value of a re-run is
diffing its ambiguity list against the last one, where a reappearing item is a
fix that didn't land, and that comparison needs the same data underneath. Every
run that stages fixtures by hand throws the comparison away again.

Which fixtures, and why each one, is the coverage matrix in the script's own
header: one line per audit finding F1–F16, naming the fixture that would catch a
regression — and naming the two findings a corpus *cannot* provoke (F4, F15)
rather than quietly dropping them so the table looks complete.

`reference/` holds what **s3cab itself restored**, not the source trees. A
correct restore legitimately differs from its source — no empty directories, no
symlinks, no permissions, mtimes rounded to the millisecond
([guide/format.md](../guide/format.md)) — so comparing against the sources would
fail a restorer for being right. The script drives the real CLI as a subprocess
to produce them, with `S3CAB_HOME` pointed at a working directory so your own
`~/.s3cab` is untouched while `~/.aws` keeps working.

Four fixture groups **cannot exist on Windows**: NTFS forbids control characters
in names, strips trailing spaces, and folds case. They are skipped with a loud
notice naming each one, because a partial corpus that reads as a complete one is
the same silent-shortening failure the exercise exists to hunt. Keep them in the
corpus permanently anyway — for a future Windows clean-room run they *become*
the point, where a restorer that refuses them is behaving correctly and one that
silently strips the trailing space and reports success is not. A symlink, by
contrast, is attempted everywhere and skipped only on the error: Windows has
them, it just wants Developer Mode.

A re-stage needs the bucket **cleared** first: snapshots are immutable and a set
name is claimed by whoever sets it up first, so `setup` would refuse. It already
would — the point of the preflight is that it asks the bucket before building
anything, and answers with the fix that applies here (empty the repository)
rather than the one `setup`'s collision error was written for (`reattach`, which
is right for a user and wrong for a fixture corpus).

`--trees-only` builds the trees, prints what this platform managed, and stops
before anything reaches S3 — worth it because staging writes well over a
thousand objects and claims six set names, and on Windows it would claim them
for a corpus missing every POSIX fixture. It takes the same arguments as the
real run plus the flag, so what you rehearse is the command you then run.

`faults` is deliberately broken: an object is torn out of the store through the
SDK, leaving **no** deletion record, because the unexplained-damage case the spec
legislates for ("report it, carry on, exit nonzero") has never been staged. Its
restore therefore exits nonzero, and the script reports that as expected rather
than failing.

```sh
node scripts/cleanroom-fixtures.mjs --bucket <name> --out <cleanroom-dir> [--work <dir>]
node --env-file=.env.test scripts/cleanroom-fixtures.mjs --out ~/cleanroom --trees-only
```

The bucket wants a raised expiry first, or the corpus sweeps out from under the
next run: `node --env-file=.env.test scripts/setup-test-bucket.mjs --days 30 <bucket>`.

## zstd-bench.mjs

Benchmarks zstd compression levels (with and without long-distance matching) on
a snapshot file, reporting compressed size plus compress/decompress time and
printing recommendations. This is the experiment behind the zstd choice
([ADR-0003](../docs/adr/0003-modern-open-tech-only.md) — modern open tech).

```sh
node scripts/zstd-bench.mjs path/to/snapshot.tsv
```

## dd.mjs

Generates a file of incompressible random bytes — the `dd if=/dev/urandom` of
this repo. Random data is the point: it defeats compression and dedup, so a
benchmark measures what it means to (zstd's worst case above; the wire, not a
provider's compression, below) rather than how well the data happened to squash.

Two faces. Run it to *keep* a blob — what zstd-bench wants — or import its
`writeRandomFile` for throwaway payloads, which is how
[multipart-bench.mjs](#multipart-benchmjs) generates and deletes one per size.
The path is required: it previously hardcoded `test/zblob.bin`, parking a 100 MB
blob in the test tree this README says must never be a sandbox.

```sh
node scripts/dd.mjs <path> [sizeMB]   # sizeMB defaults to 100
```

## multipart-bench.mjs

The experiment behind [ADR-0060](../docs/adr/0060-multipart-tuning-in-flight-bytes.md),
which set `partSize` = 16 MiB and `queueSize` = 32 in
[../src/lib/s3.mjs](../src/lib/s3.mjs). Re-run it when a link, a region, or the
SDK changes. `putFile` hardcodes both values, so it drives
`@aws-sdk/lib-storage`'s `Upload` directly — the same uploader `putFile` uses.
Bucket from `S3CAB_TEST_BUCKET` or the first arg; ambient AWS credentials; region
from `AWS_REGION` / `AWS_DEFAULT_REGION` (default `us-east-1`, auto-corrected to
the bucket's real region). With no file path it generates incompressible random
payloads and cleans them up. Probe objects land under `bench/multipart/` and are
deleted after each upload.

Network throughput drifts minute to minute — enough to swamp the differences
being measured — so it **interleaves** (one sample of every config per round,
order reshuffled each round, so a transient dip is shared rather than blamed on
whichever config ran during it) and reports the **median plus min–max spread**,
never a best-of-N. A gap between two medians means something only if it clears
the spread.

The lever is **bytes in flight** (`partSize × streams`): it must cover the link's
bandwidth-delay product before the pipe fills. Two results worth knowing before
reading a table — at *equal* in-flight, more parallel streams beat fewer/bigger
parts (so `queueSize`, not `partSize`, is the dominant knob), and past ~512 MiB
more in-flight stops helping and starts hurting. Run it from hosts at different
distances against the **same** bucket to watch the optimum move.

Two traps it guards against, both of which produced confidently wrong answers
first: a payload smaller than the in-flight under test **silently caps it**
(concurrency is `min(queueSize, parts)`, so those configs are de-duplicated and
flagged `*` rather than measured twice), and a payload too small to clear TCP
slow-start **under-measures a high-latency link** (one far link looked capped at
16 MB/s on a 256 MiB payload and reached 41 MB/s on 1 GiB). Size the payload
above both.

```sh
S3CAB_TEST_BUCKET=<bucket> node scripts/multipart-bench.mjs
# or: node scripts/multipart-bench.mjs <bucket> [path/to/file]
# tunables (comma-separated lists): S3CAB_BENCH_SIZE_MB, S3CAB_BENCH_PARTS,
#   S3CAB_BENCH_QUEUES, S3CAB_BENCH_REPS
# e.g. sweep two payload sizes:
#   S3CAB_BENCH_SIZE_MB=512,1024 node scripts/multipart-bench.mjs <bucket>
```

## setup-test-bucket.mjs

Provisions an S3 test bucket: creates it (idempotently) and applies the ~1-day
auto-expiry lifecycle the [testing strategy](../docs/design/testing.md) mandates —
`--conformance` also enables versioning and swaps in the versioned-aware expiry
baseline. Refuses a name outside the `test-s3cab-` naming convention
(see [docs/integration-testing.md](../docs/integration-testing.md) "Create a bucket")
unless `--force`. Uses the AWS SDK s3cab already depends on, so it's cross-platform
and needs no AWS CLI — credentials come from the standard AWS chain (ambient
`AWS_*`, an SSO session, etc.). Region is `AWS_REGION` / `AWS_DEFAULT_REGION`,
default `us-east-1`. The reference `aws s3api` form is in the file header.

`--days` raises the expiry clock, for a bucket holding data meant to outlive a
run — clean-room fixtures today. Leave the two buckets that assert whole-bucket
state alone: `test/crash` asserts exact object counts and
`test/model/conformance` resets the whole bucket, so for them the short sweep is
what makes the next run start clean after a crashed one, and neither holds
anything worth keeping. Re-running the script restores the default, which is
right for a test bucket and a trap for one holding fixtures — pass `--days`
again when you do.

Creating the bucket is best-effort: a scoped test identity usually has the data
plane but not `s3:CreateBucket`, so a denial there is taken as "it already
exists" and the run continues. If it doesn't exist, the calls after it say so.

```sh
node scripts/setup-test-bucket.mjs [--conformance] [--force] [--days <n>] <bucket>
# or: S3CAB_TEST_BUCKET=<bucket> node scripts/setup-test-bucket.mjs
# raise an existing bucket's expiry (credentials from .env.test):
#   node --env-file=.env.test scripts/setup-test-bucket.mjs --days 30 <bucket>
```

## sqlite-hash-cache.mjs

Evaluates `node:sqlite` as a local hash cache for the owed
`upload --if-modified-from` skip, benchmarked against the in-memory `Map`
approach the snapshot engine uses today. The experiment behind the "don't adopt
sqlite for this" note in [../CLAUDE.md](../CLAUDE.md) — the `Map` wins on both
build and lookup, and sqlite would only earn its place for a persistent
cross-run remote-hash set.

```sh
node scripts/sqlite-hash-cache.mjs [N]   # N = number of synthetic files
```
