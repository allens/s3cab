#!/usr/bin/env node

import { Temporal } from "@js-temporal/polyfill";
import {
  createReadStream,
  createWriteStream,
  existsSync,
  lstatSync,
} from "node:fs";
import { unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { constants, createZstdCompress, createZstdDecompress } from "node:zlib";
import { durationFormat, formatByteValue } from "../src/format.mjs";

/**
 * Test different zstd compression options on a snapshot file.
 * @param {string} inputPath - Path to the input .snapshot.tsv file
 */
async function testZstdOptions(inputPath) {
  if (!existsSync(inputPath)) {
    console.error(`Error: Input file not found: ${inputPath}`);
    process.exit(1);
  }

  const inputSize = lstatSync(inputPath).size;
  console.log(`Testing zstd compression options on: ${inputPath}`);
  console.log(`Input file size: ${formatByteValue(inputSize)}\n`);

  const results = [];

  const levels = [3, 8, 9, 12, 13, 16, 17];
  const stategies = [
    null,
    // constants.ZSTD_dfast,
    // constants.ZSTD_greedy,
    // constants.ZSTD_lazy2,
    // constants.ZSTD_btlazy2,
    // constants.ZSTD_btopt,
    // constants.ZSTD_btultra,
    // constants.ZSTD_btultra2,
  ];

  console.log("Testing configurations...\n");

  for (const level of levels) {
    for (const strategy of stategies) {
      const configName = `Level ${level} + Strategy ${strategy}`;
      console.log(`Testing: ${configName}`);

      try {
        const result = await testCompression(inputPath, {
          level,
          strategy,
          name: configName,
        });
        results.push(result);
      } catch (error) {
        console.error(`  Error testing ${configName}:`, error);
      }
    }
  }

  // Sort by size (smallest first)
  results.sort((a, b) => a.size - b.size);

  // Print results table
  console.log("\n" + "=".repeat(100));
  console.log("RESULTS SUMMARY");
  console.log("=".repeat(100));
  console.log(
    `${"Configuration".padEnd(35)} | ${"Size".padEnd(12)} | ${"Compress Time".padEnd(15)} | ${"Decompress Time".padEnd(15)}`,
  );
  console.log("-".repeat(80));

  for (const result of results) {
    console.log(
      `${result.name.padEnd(35)} | ${result.sizeStr.padEnd(12)} | ${result.timeStr.padEnd(15)} | ${result.decompressTimeStr.padEnd(15)}`,
    );
  }

  console.log("\n" + "=".repeat(100));
  console.log("RECOMMENDATIONS");
  console.log("=".repeat(100));

  // Find best compression (smallest size)
  const bestCompression = results.reduce((a, b) => (a.size < b.size ? a : b));
  console.log(`Best compression (smallest size): ${bestCompression.name}`);
  console.log(`  Size: ${bestCompression.sizeStr}`);
  console.log(`  Compress Time: ${bestCompression.timeStr}`);
  console.log(`  Decompress Time: ${bestCompression.decompressTimeStr}`);

  // Find fastest compression
  const fastestCompress = results.reduce((a, b) => (a.speed > b.speed ? a : b));
  console.log(`\nFastest compression: ${fastestCompress.name}`);
  console.log(`  Size: ${fastestCompress.sizeStr}`);
  console.log(`  Compress Time: ${fastestCompress.timeStr}`);
  console.log(`  Decompress Time: ${fastestCompress.decompressTimeStr}`);

  // Find fastest decompression
  const fastestDecompress = results.reduce((a, b) =>
    a.decompressSpeed > b.decompressSpeed ? a : b,
  );
  console.log(`\nFastest decompression: ${fastestDecompress.name}`);
  console.log(`  Size: ${fastestDecompress.sizeStr}`);
  console.log(`  Compress Time: ${fastestDecompress.timeStr}`);
  console.log(`  Decompress Time: ${fastestDecompress.decompressTimeStr}`);

  // Find best balance (within 5% of best compression size, fastest compression)
  const bestSize = bestCompression.size;
  const balanced = results
    .filter((r) => r.size <= bestSize * 1.05)
    .reduce((a, b) => (a.speed > b.speed ? a : b));
  if (balanced) {
    console.log(
      `\nBest balance (within 5% of best compression size, fastest compression): ${balanced.name}`,
    );
    console.log(`  Size: ${balanced.sizeStr}`);
    console.log(`  Compress Time: ${balanced.timeStr}`);
    console.log(`  Decompress Time: ${balanced.decompressTimeStr}`);
  }
}

/**
 * Test a specific compression configuration.
 * @param {string} inputPath - Path to input file
 * @param {object} config - Compression configuration
 * @param {number} config.level - Compression level
 * @param {number}  config.strategy - Compression strategy
 * @param {string} config.name - Configuration name
 * @returns {Promise<object>} Test result
 */
async function testCompression(inputPath, config) {
  const outputPath = join(
    dirname(inputPath),
    `.test-zstd-${Date.now()}-${Math.random().toString(36).slice(2)}.zst`,
  );

  const start = Temporal.Now.instant();

  try {
    /** @type {Record<number, number | boolean>} */
    const params = {
      // [constants.ZSTD_c_strategy]: config.strategy,
      // [constants.ZSTD_c_enableLongDistanceMatching]: true,
    };

    if (config.level) {
      params[constants.ZSTD_c_compressionLevel] = config.level;
    }

    if (config.strategy === null) {
      delete params[constants.ZSTD_c_strategy];
    }

    await pipeline(
      createReadStream(inputPath),
      createZstdCompress({
        params,
        chunkSize: 256 * 1024, // 128MB chunks
      }),
      createWriteStream(outputPath),
    );

    const end = Temporal.Now.instant();
    const duration = end.since(start);
    const outputSize = lstatSync(outputPath).size;
    const inputSize = lstatSync(inputPath).size;
    const ratio = outputSize / inputSize;
    const durationSeconds = duration.total({ unit: "seconds" });
    const speed = inputSize / durationSeconds;

    // Test decompression
    const decompressOutputPath = join(
      dirname(inputPath),
      `.test-zstd-decompress-${Date.now()}-${Math.random().toString(36).slice(2)}.tsv`,
    );
    const decompressStart = Temporal.Now.instant();

    await pipeline(
      createReadStream(outputPath),
      createZstdDecompress(),
      createWriteStream(decompressOutputPath),
    );

    const decompressEnd = Temporal.Now.instant();
    const decompressDuration = decompressEnd.since(decompressStart);
    const decompressDurationSeconds = decompressDuration.total({
      unit: "seconds",
    });
    const decompressSpeed = outputSize / decompressDurationSeconds;

    // Clean up
    await unlink(outputPath);
    await unlink(decompressOutputPath);

    return {
      name: config.name,
      size: outputSize,
      sizeStr: formatByteValue(outputSize),
      ratio,
      time: duration,
      timeStr: durationFormat.format(
        duration.round({ smallestUnit: "milliseconds" }),
      ),
      speed,
      decompressTime: decompressDuration,
      decompressTimeStr: durationFormat.format(
        decompressDuration.round({ smallestUnit: "milliseconds" }),
      ),
      decompressSpeed,
    };
  } catch (error) {
    // Clean up on error
    if (existsSync(outputPath)) {
      await unlink(outputPath).catch(() => {});
    }
    throw error;
  }
}

// Main execution
const inputPath =
  process.argv[2] || resolve(".s3cab", "snapshots", ".snapshot.tsv");

testZstdOptions(inputPath).catch((error) => {
  console.error("Error:", error);
  process.exit(1);
});

/* The old single-threaded results:
====================================================================================================
RESULTS SUMMARY
====================================================================================================
Configuration                       | Size         | Compress Time   | Decompress Time
--------------------------------------------------------------------------------
Level 22 + LDM                      | 7.1MB        | 100 secs, 552 ms | 990 ms
Level 22 (no LDM)                   | 7.1MB        | 117 secs, 69 ms | 310 ms
Level 20 + LDM                      | 7.1MB        | 60 secs, 154 ms | 284 ms
Level 20 (no LDM)                   | 7.4MB        | 63 secs, 853 ms | 231 ms
Level 18 + LDM                      | 7.4MB        | 25 secs, 642 ms | 269 ms
Level 16 + LDM                      | 7.5MB        | 13 secs, 24 ms  | 231 ms
Level 18 (no LDM)                   | 8MB          | 23 secs, 27 ms  | 247 ms
Level 16 (no LDM)                   | 8.4MB        | 10 secs, 895 ms | 307 ms
Level 14 + LDM                      | 8.9MB        | 2 secs, 913 ms  | 276 ms
Level 12 + LDM                      | 9MB          | 1 sec, 970 ms   | 390 ms
Level 10 + LDM                      | 9.1MB        | 1 sec, 509 ms   | 380 ms
Level 3 + LDM                       | 9.3MB        | 646 ms          | 393 ms
Level 14 (no LDM)                   | 9.4MB        | 2 secs, 871 ms  | 304 ms
Level 12 (no LDM)                   | 9.4MB        | 1 sec, 683 ms   | 462 ms
Level 10 (no LDM)                   | 9.5MB        | 1 sec, 300 ms   | 400 ms
Level 3 (no LDM)                    | 11MB         | 311 ms          | 399 ms

====================================================================================================
RECOMMENDATIONS
====================================================================================================
Best compression (smallest size): Level 22 (no LDM)
  Size: 7.1MB
  Compress Time: 117 secs, 69 ms
  Decompress Time: 310 ms

Fastest compression: Level 3 (no LDM)
  Size: 11MB
  Compress Time: 311 ms
  Decompress Time: 399 ms

Fastest decompression: Level 18 (no LDM)
  Size: 8MB
  Compress Time: 23 secs, 27 ms
  Decompress Time: 247 ms

Best balance (within 5% of best compression size, fastest compression): Level 16 + LDM
  Size: 7.5MB
  Compress Time: 13 secs, 24 ms
  Decompress Time: 231 ms
*/
