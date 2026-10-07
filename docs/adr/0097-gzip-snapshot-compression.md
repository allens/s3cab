# Snapshots are compressed with gzip, not zstd

**Status:** proposed (2026-10-07). Investigation PR: the direction is close to decided, pending
a measurement on a real snapshot. Nothing is built yet. If accepted, this partly supersedes
[0003](0003-modern-open-tech-only.md)'s zstd example.

Snapshot files (`<name>.tsv.zst`, locally and under `snapshots/<set>/`) are zstd at level 19.
This proposes **gzip at level 9 with zlib's `Z_FILTERED` strategy** (`<name>.tsv.gz`) instead.

The trade is about 15% larger snapshot files for a format that **every platform and every kind
of reader decodes out of the box**: Node, every Python, the .NET Framework that ships inside
Windows, macOS's own frameworks, the zlib on every Linux, `gunzip` in any shell, and a browser's
`DecompressionStream`. Compression also gets about 25 times faster.

## Why

zstd was chosen as the best speed/ratio balance, and as native in Node and "in Windows 11"
(0003). The second half was weaker than it read. Windows 11's zstd support is Explorer's archive
handling, not a library a program can call. In practice zstd is the one dependency a recovering
reader most often has to install:

| Reader | zstd | gzip |
|---|---|---|
| Node | built in | built in |
| Python | 3.14+ only (`compression.zstd`) | **every version** (`gzip`, `zlib`) |
| Windows | .NET 11 only (`ZstandardStream`), installed separately | **`GZipStream` in the .NET Framework 4.x that ships with Windows**, so even Windows PowerShell 5.1 |
| macOS | `brew install zstd`; Apple's Compression framework has no zstd | **built in** (Foundation/Compression zlib, system libz) |
| Linux C | the libzstd package | zlib, present essentially everywhere |
| A person in a shell | `zstd` often not installed | `gunzip -c x.tsv.gz \| grep …` on any Mac or Linux |
| A browser (`browse`, planned for v2) | no standard support | **`DecompressionStream('gzip')`** |

That reaches three other decisions:

- **ADR-0096's readers** (proposed in PR #379) **lose their only extra
  install.** The Windows reader can target the **.NET Framework that ships with Windows**, so
  nothing is installed at all; under zstd it needs .NET 11. The macOS reader needs nothing from
  Homebrew.
- **The planned `browse` command** can decompress snapshots in the page itself, with no server
  round trip through a decoder and no JS zstd library.
- **[0002](0002-no-lock-in-hard-constraint.md)'s no-lock-in promise gets simpler to keep.**
  The tool needed to read a snapshot by hand is the one already on every machine.

## What it costs: measured

A synthetic snapshot was built from `/usr` on a Linux box: 83,861 rows in the exact column layout
(64-wide padded hash, right-aligned size, 24-wide mtime, path), 12.7 MB uncompressed. Hashes
were SHA-256 of each path, which is random like a real content hash. It was compressed with
Node's built-in zlib (xz via its CLI), single run, 2026-10-07:

| | Size | Ratio | Compress | Decompress |
|---|---|---|---|---|
| gzip -6 | 3,987 KiB | 30.7% | 0.4 s | 0.3 s |
| gzip -9 | 3,921 KiB | 30.2% | 0.5 s | 0.14 s |
| **gzip -9, `Z_FILTERED`** | **3,767 KiB** | **29.0%** | **0.75 s** | — |
| gzip via Zopfli (15 iterations) | 3,641 KiB | 28.0% | 41 s | — |
| bzip2 -9 | 3,446 KiB | 26.5% | — | — |
| brotli q9 | 3,931 KiB | 30.3% | 4.6 s | 0.14 s |
| brotli q11 | 3,301 KiB | 25.4% | 37 s | 0.06 s |
| xz -9e | 3,401 KiB | 26.2% | 17 s | — |
| zstd 3 | 4,004 KiB | 30.8% | 0.1 s | 0.04 s |
| **zstd 19 (today)** | **3,433 KiB** | **26.4%** | **13 s** | **0.05 s** |

- **Every algorithm hits the same floor.** Each row's hash is 32 bytes of incompressible
  entropy written as 64 hex characters, about 2.6 MB of this file. No algorithm gets near it,
  and the spread between them is small. gzip -9 is about 14% larger than zstd 19, roughly half a
  megabyte at 84,000 files. **`Z_FILTERED` cuts that to about 10%** at no cost to readers: it is
  a compressor-side strategy flag (Node's `createGzip({ level: 9, strategy: Z_FILTERED })`), and
  the output is ordinary gzip. `memLevel: 9` changed nothing.
- **Smaller still costs a dependency or a portability loss.** Zopfli writes standard gzip that
  any `gunzip` reads, about 3% smaller again, but it is about 55 times slower and isn't built
  into Node (ADR-0005). bzip2 matches zstd 19's size, but Node, .NET and browsers can't read it.
- **zstd 19 is slow to compress.** About 13 s of CPU here, against 0.5 s for gzip -9. The
  compressor runs alongside hashing in the fused pass ([0069](0069-fused-snapshot-upload-pipeline.md)),
  so part of that is hidden, but it grows with the set.
- **Decompression speed doesn't matter** at these sizes for any of them.

## To do in this PR

1. **Confirm on a real snapshot.** Extend `scripts/zstd-bench.mjs` (renamed, since it would no
   longer be zstd-only) to compare gzip levels beside zstd, and run it on a large real
   decompressed snapshot, including `Z_FILTERED`. Accept if gzip stays within about 20% of
   zstd 19.
2. **Change the writer and readers** in `src/lib/snapshot-file.mjs` and `src/lib/snapshot.mjs`:
   `createZstdCompress`/`createZstdDecompress` become `createGzip`/`createGunzip`. Check:
   - **Tolerant work-file reads** ([0092](0092-recover-the-interrupted-work-file.md)) use
     `finishFlush: ZSTD_e_flush` to accept a cut-short frame. The gunzip equivalent is
     `finishFlush: Z_SYNC_FLUSH`.
   - **Error matching:** `isCorruptSnapshotError` in `src/lib/referenced.mjs` matches `ZSTD_*`
     error codes; gunzip's are `Z_*`/`Z_BUF_ERROR` ("unexpected end of file").
   - **Byte identity** ([0084](0084-snapshot-identity-byte-equality.md)) compares a local file
     with its uploaded copy, made on one machine, so it is unaffected. But the gzip header
     carries an OS byte and an mtime field, so output is not byte-identical *across* platforms
     or zlib builds. Confirm nothing compares snapshots compressed on different machines.
3. **Rename `.tsv.zst` → `.tsv.gz`** everywhere: `src/`, tests, test helpers, the model and crash
   suites, `.gitattributes`/`.gitignore`/`.prettierignore`, and CI if it names the extension.
   Pre-1.0, with no compatibility reader for `.zst` (CLAUDE.md): change the format and move on.
4. **Update the spec and docs:** `guide/format.md` (compression, the extension, "decompress with
   any zstd tool", the truncation paragraph), `guide/compare.md`, `README.md`, `CONTEXT.md`,
   `docs/design/`, and the ADR index. Mark 0003's zstd example as superseded by this ADR, and
   correct older ADRs only where they would otherwise mislead.
5. **Clean-room harness:** `scripts/cleanroom/stage.mjs` recompresses the trailer-less `faults`
   snapshot, so it switches to gzip. The frozen restorers are not updated (they are to be
   replaced; see 0096), but the README's Windows note changes from ".NET 11 for zstd" to the
   in-box .NET Framework.
6. **Run `npm run test:integration`** before pushing, per CLAUDE.md: this changes the S3
   read/write/stream path.

## Considered

- **Keep zstd.** It gives the best ratio at a fast decode. But it is the one dependency a
  recovering reader most often lacks, for a gain of about half a megabyte per large snapshot.
- **Brotli.** It is native in Node and .NET Core, but not in Python's standard library, the .NET
  Framework, or a browser's `DecompressionStream`. Only its slowest level beats zstd 19.
- **xz.** It's in Python's standard library, but not in Node's or .NET's.
- **bzip2.** It matches zstd 19's ratio and ships with most Unix shells and Python, but not
  Node, .NET or browsers.
- **Zopfli.** It writes standard gzip, about 3% smaller than `Z_FILTERED`, but it's 55 times
  slower and is a dependency. A writer can adopt it later without changing the format.

Nothing else comes close to gzip's portability. Its deflate format is also inside ZIP, PNG and
HTTP compression, which is why every platform ships a decoder.
- **zstd at a low level.** This fixes the compression time but none of the availability gaps,
  and the ratio drops to gzip's anyway.
