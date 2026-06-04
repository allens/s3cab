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

## build-sea-cross.mjs

Cross-builds the native SEA executable for other platforms from this host (see the
Build section of [../CLAUDE.md](../CLAUDE.md)). Downloads the node build matching
`process.version` from nodejs.org, checksum-verifies it, and injects the bundle via
`--build-sea`'s `executable` field. Run via `npm run build:cross` (which builds the
bundle first), or directly:

```sh
node scripts/build-sea-cross.mjs [target ...]
# defaults to: linux-x64 linux-arm64 darwin-arm64
# known targets: linux-x64, linux-arm64, darwin-arm64, darwin-x64, win-x64
```

Outputs `dist/s3cab-<target>`. macOS binaries are emitted **unsigned** with a warning —
they must be codesigned on a Mac (or via `rcodesign`) before they will launch.

## dd.mjs

Writes a 100 MB file of random bytes to `test/zblob.bin` — incompressible
large-file test data for the benchmark above and other experiments.

```sh
node scripts/dd.mjs
```
