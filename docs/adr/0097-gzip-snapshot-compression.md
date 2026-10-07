# Snapshots are compressed with gzip, not zstd

**Status:** accepted & implemented (2026-10-07). Partly supersedes
[0003](0003-modern-open-tech-only.md)'s zstd example.

Snapshot files are **gzip** (`<name>.tsv.gz`, locally and under `snapshots/<set>/`), as are the
work file and the parked lookup (`.snapshot.tsv.gz`, `.snapshot.lookup.tsv.gz`). They were zstd
at level 19. The writer uses zlib's maximum settings: **level 9, `memLevel` 9 and the
`Z_FILTERED` strategy**. The spec promises only plain, single-stream gzip; the settings are the
writer's choice.

The trade is snapshots **about 4–10% larger** than zstd 19 on realistic data, for a format that
**every platform and every kind of reader decodes out of the box**. Compression also gets about
**30 times faster**.

## Why

zstd was chosen as the best speed/ratio balance, and as native in Node and "in Windows 11"
(0003). The second half was weaker than it read: Windows 11's zstd support is Explorer's archive
handling, not a library a program can call. In practice zstd was the one dependency a recovering
reader most often had to install:

| Reader | zstd | gzip |
|---|---|---|
| Node | built in | built in |
| Python | 3.14+ only (`compression.zstd`) | **every version** (`gzip`, `zlib`) |
| Windows | .NET 11 only (`ZstandardStream`), installed separately | **`GZipStream` in the .NET Framework that ships with Windows**, so even Windows PowerShell 5.1 |
| macOS | `brew install zstd`; Apple's Compression framework has no zstd | **built in** (Foundation/Compression zlib, system libz) |
| Linux C | the libzstd package | zlib, present essentially everywhere |
| A person in a shell | `zstd` often not installed | `gunzip` on any Mac or Linux |
| A browser (`browse`, planned for v2) | no standard support | **`DecompressionStream('gzip')`** |

That reaches three other decisions:

- **The clean-room readers** proposed as ADR-0096 (PR #379) lose their only extra install. The
  Windows reader can target the .NET Framework that ships with Windows, and the macOS reader
  needs nothing from Homebrew.
- **The planned `browse` command** can decompress snapshots in the page itself.
- **[0002](0002-no-lock-in-hard-constraint.md)'s no-lock-in promise gets simpler to keep.**
  The tool needed to read a snapshot by hand is already on every machine.
  [guide/format.md](../../guide/format.md) now gives the PowerShell lines for Windows, which has
  no `gunzip`.

## What it costs: measured

Five synthetic snapshots in the exact column layout (64-wide padded hash, right-aligned size,
24-wide mtime, path), with each hash the SHA-256 of its path so it is random like a real one.
Compressed with Node 26.11's built-in zlib, one run each, 2026-10-07. `scripts/compression-bench.mjs`
repeats the comparison on any real snapshot.

| Snapshot | Rows | Raw | zstd 19 | gzip 9 | **gzip 9, `Z_FILTERED`, mem 9** | vs zstd 19 |
|---|---|---|---|---|---|---|
| small (Linux paths) | 603 | 84 KiB | 26 KiB | 29 KiB | **28 KiB** | +5.3% |
| photo library (`D:\Photos\<year>\<event>\IMG_….JPG`) | 124,015 | 17.5 MiB | 5.6 MiB | 6.1 MiB | **5.8 MiB** | +3.5% |
| Windows profile tree | 154,335 | 26.8 MiB | 6.2 MiB | 7.1 MiB | **6.8 MiB** | +9.8% |
| Linux `/usr` + `/opt` | 154,335 | 24.7 MiB | 6.2 MiB | 7.1 MiB | **6.8 MiB** | +9.1% |
| all of the above, one set | 432,679 | 68.9 MiB | 18.1 MiB | 20.2 MiB | **19.4 MiB** | +7.4% |

Compression time for the combined 433,000-row set was **81 s for zstd 19 and 2.5 s for gzip**.
For the photo library it was 24.6 s against 0.8 s.

- **Every algorithm hits the same floor.** Each row's hash is 32 bytes of incompressible
  entropy written as 64 hex characters. No algorithm gets near it, so the spread between them is
  small.
- **`Z_FILTERED` is the setting that matters**, at about 4% smaller than gzip's default
  strategy on every set. It makes deflate discard matches of 5 bytes or fewer. In random hex,
  3–4 character repeats turn up by chance within gzip's 32 KB window. Each costs roughly 15–20
  bits as a back-reference, while Huffman coding spends only about 4 bits on a hex digit. So
  dropping the short matches lets the hash column code close to its entropy, while the paths,
  which genuinely repeat, keep their long matches. It is a compressor-only flag: the output is
  ordinary gzip.
- **`memLevel` 9 adds 0.1–0.2%** and costs the compressor 128 KB more, nothing for readers.
  `windowBits` is already at its maximum (15); smaller windows, Huffman-only and RLE were all
  worse, the last two by about 80%.
- **zstd 19 was slow to compress.** The fused pass ([0069](0069-fused-snapshot-upload-pipeline.md))
  runs the compressor alongside hashing, which hid part of it, but it grew with the set.
- **Decompression speed doesn't matter** at these sizes for either.

An earlier single-set run on a `/usr`-only snapshot also covered other algorithms; see
*Considered*.

## Consequences

- **No reader for `.tsv.zst`.** Pre-1.0, per CLAUDE.md: the format changed and the old files are
  not read. A zstd snapshot is simply not a snapshot to `list`, `restore` or `cleanup`. A
  repository that still holds them should be started fresh rather than cleaned up: `cleanup`
  would see their objects as unreferenced.
- **Corruption is still recognised.** `isCorruptSnapshotError` classifies gunzip's
  `Z_DATA_ERROR` (bytes that aren't gzip, a failed CRC-32, or junk after the stream) and
  `Z_BUF_ERROR` (cut short) as damage. A damaged snapshot is still an *unreadable* finding,
  never an S3 failure.
- **Truncation is caught twice.** Node's gunzip rejects every cut-short stream with
  `Z_BUF_ERROR`, measured at every cut point of a snapshot including the empty one, and
  `parseCompressedSnapshotStream` folds it into the same AssertionError as a missing `#END`
  ([0082](0082-snapshot-end-trailer.md), amendment 4). The tolerant work-file read
  ([0092](0092-recover-the-interrupted-work-file.md)) ends cleanly with `Z_SYNC_FLUSH`.
- **Byte identity is unaffected.** [0084](0084-snapshot-identity-byte-equality.md) compares a
  local file with its uploaded copy, and nothing recompresses a snapshot. Node writes a zero gzip
  mtime, so the header leaks no time. But the header's OS byte, and potentially the zlib build,
  differ between platforms, so two machines compressing the same rows need not produce the same
  bytes. Nothing compares those.
- **Older ADRs keep their `.tsv.zst` names** as the history they record. The spec, guides,
  designs and code all say `.tsv.gz`.

## Considered

- **Keep zstd.** It has the best ratio and a fast decode. But it is the one dependency a
  recovering reader most often lacks, for a gain of 4–10%.
- **Zopfli.** It writes standard gzip about 3% smaller than `Z_FILTERED` (`/usr` set: 3,641 KiB
  against 3,767 KiB). But it's about 55 times slower and isn't built into Node, so it would be a
  dependency ([0005](0005-builtins-over-dependencies.md)). Because its output is still gzip, a
  writer can adopt it later without a format change.
- **bzip2.** It matches zstd 19's ratio (3,446 KiB on `/usr`) and ships with most Unix shells
  and Python, but not with Node, .NET or browsers.
- **Brotli.** It is native in Node and modern .NET, but not in Python's standard library, the
  .NET Framework or a browser's `DecompressionStream`. Only its slowest level, at 37 s, beat zstd
  19.
- **xz.** It's in Python's standard library, but not in Node's or .NET's.
- **zstd at a low level.** This fixes the compression time but none of the availability gaps,
  and its ratio drops to gzip's anyway.

Nothing else comes close to gzip's portability. Its deflate format is also inside ZIP, PNG and
HTTP compression, which is why every platform ships a decoder.
