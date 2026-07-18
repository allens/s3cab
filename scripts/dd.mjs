/**
 * Generate a file of incompressible random bytes — the `dd if=/dev/urandom` of
 * this repo, and the shared payload generator for the benchmarks.
 *
 * Random bytes matter for the same reason in both callers: they defeat
 * compression and dedup, so a benchmark measures what it means to (zstd's worst
 * case; the wire rather than a provider's compression) instead of how well the
 * data happened to squash.
 *
 * Two faces, hence the `import.meta.main` guard: run it to *keep* a blob
 * (zstd-bench wants a standing file to compress), or import `writeRandomFile`
 * for throwaway ones (multipart-bench generates and deletes a payload per size).
 *
 * Usage:
 *   node scripts/dd.mjs <path> [sizeMB]     # sizeMB defaults to 100
 *
 * The path is required on purpose: this used to write a hardcoded
 * `test/zblob.bin`, parking a 100 MB blob in the test tree that scripts/README
 * says must never be a sandbox. Name where it goes.
 */
import { randomBytes } from "node:crypto";
import { createWriteStream } from "node:fs";

const MB = 1024 * 1024;

/**
 * How much to generate per `write`: big enough that per-chunk overhead
 * disappears, small enough that the synchronous `randomBytes` behind each one
 * doesn't stall the event loop for long.
 */
const BLOCK = 8 * MB;

/**
 * Write `size` bytes of random data to `path`, resolving once the file is fully
 * flushed. Streamed with backpressure — it honours `write`'s false return and
 * waits for `drain` — so a multi-gigabyte payload never sits in memory.
 * @param {string} path
 * @param {number} size - Bytes to write.
 * @returns {Promise<void>}
 */
export function writeRandomFile(path, size) {
  const stream = createWriteStream(path);
  return new Promise((resolve, reject) => {
    stream.on("error", reject);
    let remaining = size;
    const pump = () => {
      while (remaining > 0) {
        const chunk = randomBytes(Math.min(BLOCK, remaining));
        remaining -= chunk.length;
        if (!stream.write(chunk)) {
          stream.once("drain", pump);
          return;
        }
      }
      stream.end(resolve);
    };
    pump();
  });
}

if (import.meta.main) {
  const path = process.argv[2];
  const sizeMb = Number(process.argv[3] ?? "100");
  // Reject a non-numeric size rather than letting NaN through: `remaining > 0`
  // would be false immediately, so it would write a silent ZERO-byte file and
  // report success — and a benchmark run against that measures nothing while
  // looking fine.
  if (!path || !Number.isFinite(sizeMb) || sizeMb <= 0) {
    console.error("usage: node scripts/dd.mjs <path> [sizeMB]  (sizeMB > 0)");
    process.exit(2);
  }
  await writeRandomFile(path, sizeMb * MB);
  console.log(`wrote ${sizeMb} MB of random bytes to ${path}`);
}
