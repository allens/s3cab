# Dev scripts

Ad-hoc developer utilities. These are **not** part of the published package or
the automated test suite — run them by hand with `node` when needed.

## zstd-bench.mjs

Benchmarks zstd compression levels (with and without long-distance matching) on
a snapshot manifest, reporting compressed size plus compress/decompress time and
printing recommendations. This is the experiment behind the zstd choice recorded
in [../CLAUDE.md](../CLAUDE.md) (design principle #3 — "embrace modern open tech").

```sh
node scripts/zstd-bench.mjs [path/to/snapshot.tsv]
# defaults to .s3cab/snapshots/.snapshot.tsv
```

## dd.mjs

Writes a 100 MB file of random bytes to `test/zblob.bin` — incompressible
large-file test data for the benchmark above and other experiments.

```sh
node scripts/dd.mjs
```

## setup-test-bucket.mjs

Provisions the S3 integration-test bucket: creates it (idempotently) and applies
the ~1-day auto-expiry lifecycle rule the [testing strategy](../specs/testing.md)
mandates. Uses the AWS SDK s3cab already depends on, so it's cross-platform and
needs no AWS CLI — credentials come from the standard AWS chain (ambient `AWS_*`,
an SSO session, etc.). Region is `AWS_REGION` / `AWS_DEFAULT_REGION`, default
`us-east-1`. The reference `aws s3api` form is in the file header.

```sh
node scripts/setup-test-bucket.mjs <bucket>
# or: S3CAB_TEST_BUCKET=<bucket> node scripts/setup-test-bucket.mjs
```

## sqlite-hash-cache-spike.mjs

Evaluates `node:sqlite` as a local hash cache for the owed
`upload --if-modified-from` skip, benchmarked against the in-memory `Map`
approach the snapshot engine uses today. The experiment behind the "don't adopt
sqlite for this" note in [../CLAUDE.md](../CLAUDE.md) — the `Map` wins on both
build and lookup, and sqlite would only earn its place for a persistent
cross-run remote-hash set.

```sh
node scripts/sqlite-hash-cache-spike.mjs [N]   # N = number of synthetic files
```
