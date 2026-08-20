# Dev scripts

Ad-hoc developer utilities. These are **not** part of the published package or
the automated test suite — run them by hand with `node` (or `python` where a
script says so) when needed.

## cleanroom/

The clean-room exercise — the literal test of the no-lock-in promise, and the
restorers preserved from each run. Its harness (`create.mjs`, `stage.mjs`,
`compare.py`) and its frozen artifacts live together in
[cleanroom/](cleanroom/), documented by [its own README](cleanroom/README.md).

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
