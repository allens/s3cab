#!/usr/bin/env node
/**
 * Compare snapshot compression settings on a real snapshot — the experiment
 * behind ADR-0097's choice of gzip level 9, `memLevel` 9, `Z_FILTERED`.
 *
 * The gzip rows are the candidates; zstd is there as the reference point the
 * format moved away from, so a re-run shows the size cost of that move on your
 * own data. Each setting's size is printed against both gzip's default
 * strategy and zstd 19.
 *
 * Usage:
 *   node scripts/compression-bench.mjs <snapshot.tsv | snapshot.tsv.gz>
 *
 * A `.tsv.gz` (a snapshot as s3cab stores it) is decompressed first, so any
 * snapshot under ~/.s3cab/sets/<set>/snapshots/ can be passed as is.
 */

import { readFileSync } from "node:fs";
import { constants, gunzipSync, gzipSync, zstdCompressSync } from "node:zlib";
import { formatByteValue } from "../src/lib/format.mjs";

const path = process.argv[2];
if (!path) {
  console.error(
    "Usage: node scripts/compression-bench.mjs <snapshot.tsv | snapshot.tsv.gz>",
  );
  process.exit(1);
}

const raw = readFileSync(path);
const input = path.endsWith(".gz") ? gunzipSync(raw) : raw;

/** @type {{ name: string, compress: () => Buffer }[]} */
const candidates = [];
for (const level of [6, 9]) {
  for (const [strategyName, strategy] of Object.entries({
    default: constants.Z_DEFAULT_STRATEGY,
    filtered: constants.Z_FILTERED,
  })) {
    for (const memLevel of [8, 9]) {
      candidates.push({
        name: `gzip ${level} ${strategyName} mem${memLevel}`,
        compress: () => gzipSync(input, { level, strategy, memLevel }),
      });
    }
  }
}
// The two strategies that do no general string matching (RLE repeats only the
// previous byte): here to show what matching is worth on the path column.
for (const [name, strategy] of Object.entries({
  huffman: constants.Z_HUFFMAN_ONLY,
  rle: constants.Z_RLE,
})) {
  candidates.push({
    name: `gzip 9 ${name}`,
    compress: () => gzipSync(input, { level: 9, strategy }),
  });
}
for (const level of [3, 19]) {
  candidates.push({
    name: `zstd ${level}`,
    compress: () =>
      zstdCompressSync(input, {
        params: { [constants.ZSTD_c_compressionLevel]: level },
      }),
  });
}

/** @type {{ name: string, size: number, ms: number }[]} */
const results = candidates.map(({ name, compress }) => {
  const start = performance.now();
  const size = compress().length;
  return { name, size, ms: performance.now() - start };
});

const sizeOf = (/** @type {string} */ name) =>
  /** @type {{ size: number }} */ (results.find((r) => r.name === name)).size;
const gzipDefault = sizeOf("gzip 9 default mem8");
const zstd19 = sizeOf("zstd 19");
const percent = (/** @type {number} */ size, /** @type {number} */ base) =>
  `${size >= base ? "+" : ""}${((size / base - 1) * 100).toFixed(1)}%`;

console.log(`${path}: ${formatByteValue(input.length)} uncompressed\n`);
console.log(
  `${"Setting".padEnd(26)} ${"Size".padStart(9)} ${"vs gzip 9".padStart(10)} ${"vs zstd 19".padStart(11)} ${"Time".padStart(9)}`,
);
for (const { name, size, ms } of results.toSorted((a, b) => a.size - b.size)) {
  console.log(
    `${name.padEnd(26)} ${formatByteValue(size).padStart(9)} ${percent(size, gzipDefault).padStart(10)} ${percent(size, zstd19).padStart(11)} ${`${Math.round(ms)} ms`.padStart(9)}`,
  );
}
