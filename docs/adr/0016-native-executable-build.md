# Native executable via esbuild bundle + Node SEA

The distribution goal is a **single native executable** — a user shouldn't need Node
installed. Producing it is two steps: [build.mjs](../../build.mjs) calls the **esbuild** JS
API to bundle the ESM source into one file `dist/s3cab.js`, then `node --build-sea` (Node ≥ 26)
embeds that bundle into a copy of the node binary. The `why` not repeated in
[package.json](../../package.json) lives here.

## Why esbuild at all

SEA needs a **single standalone file** (a SEA main may only import built-ins) — esbuild exists
purely for that, **not** to convert module format. The bundle is bundle-only (no
`target`/`minify`), so the output is the same modern syntax that runs from source
([0007](0007-plain-js-via-jsdoc.md)). Even this dev-dep is held to the
[0005](0005-builtins-over-dependencies.md) bar: drop it if Node ever bundles multi-file SEA
inputs natively.

## The `createRequire` banner is load-bearing — don't drop it

In ESM output esbuild rewrites `require()` to a shim that *throws* unless a real `require` is
in scope, and a surviving CJS dep (the AWS SDK's IMDS provider does `require("node:http")`
eagerly) made the binary crash on **every** invocation — even `--help`. The banner
(`createRequire(process.execPath)`) puts a real `require` in scope. Base is `process.execPath`,
not `import.meta.url`, because in the SEA binary the latter isn't a resolvable file URL. The
CJS-bundle alternative (no banner needed) is blocked by the entry's top-level `await`, which
esbuild can't emit in `cjs` format.

## Each OS builds its own binary — no cross-compilation

`--build-sea` *can* cross-inject, but a binary for another OS can't be smoke-tested where it's
built, and mac binaries built off-Mac can't be codesigned. CI builds the full matrix natively,
one runner per platform. The Linux build pins `ubuntu-22.04` (glibc floor). Related: an `exe
smoke` CI job boots the Linux binary + bundle on every PR — see
[0019](0019-s3-test-strategy.md)'s sibling note in CLAUDE.md's gaps for why.
