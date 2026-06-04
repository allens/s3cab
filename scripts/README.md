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
