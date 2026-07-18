/**
 * Benchmark multipart-upload settings against a real S3 bucket: the experiment
 * behind ADR-0060, which set `partSize` = 16 MiB and `queueSize` = 32 in
 * src/lib/s3.mjs. Re-run it when a link, a region, or the SDK changes.
 *
 * `putFile` hardcodes both values, so they can't be swept non-invasively; this
 * drives `@aws-sdk/lib-storage`'s `Upload` directly (the same uploader `putFile`
 * uses). Everything else matches setup-test-bucket.mjs: the SDK s3cab already
 * depends on, ambient AWS credentials, region from AWS_REGION /
 * AWS_DEFAULT_REGION (default us-east-1, auto-corrected via S3's 301). No AWS
 * CLI needed.
 *
 * ## What it measures
 *
 * The lever is **bytes in flight** = partSize × streams — how much is on the
 * wire at once. It must cover the link's bandwidth-delay product (throughput ×
 * round-trip time) before the pipe fills. Two results from ADR-0060 worth
 * knowing before reading a table:
 *   - at EQUAL in-flight, more parallel streams beat fewer/bigger parts (each
 *     TCP flow is individually RTT-limited, so throughput scales with flow
 *     count) — `queueSize`, not `partSize`, sets that count;
 *   - more in-flight stops helping and then HURTS — past ~512 MiB the measured
 *     curve turns over. It is a peak to find, not a quantity to maximize.
 *
 * ## Two traps this script now guards against
 *
 * Both produced confident, wrong answers before they were caught:
 *
 * 1. **A payload smaller than the in-flight under test silently caps it.**
 *    In-flight can never exceed the file, and concurrency is capped by the part
 *    count (`ceil(payload ÷ partSize)`), so on a 256 MiB payload `16 MiB × 32`
 *    and `16 MiB × 16` are the SAME execution. Configs are therefore
 *    de-duplicated by their *effective* (partSize, streams) and the collapse is
 *    reported — rather than burning uploads on duplicate rows that then differ
 *    by noise and read as a real difference.
 * 2. **A payload too small to clear TCP slow-start under-measures a
 *    high-latency link.** At 256 MiB one far link looked capped at ~16 MB/s; at
 *    1 GiB the same settings reached 41 MB/s — the transfer had been finishing
 *    while the congestion window was still opening. Size the payload above both
 *    the largest in-flight under test and the ramp.
 *
 * ## Method
 *
 * Network throughput drifts minute to minute, enough to swamp the differences
 * being measured. So it interleaves — one sample of every config per round, the
 * order reshuffled each round — and reports the MEDIAN plus min–max spread,
 * never a best-of-N (which just rewards whichever config ran in the quietest
 * window). A gap between two medians means something only if it clears the
 * spread.
 *
 * Run it from hosts at different distances against the SAME bucket to watch the
 * optimum move; ADR-0060 records three such runs.
 *
 * Bucket comes from S3CAB_TEST_BUCKET (the gated-suite bucket) or the first arg.
 * Probe objects go under `bench/multipart/` and are deleted after each upload;
 * the ~1-day lifecycle rule setup-test-bucket.mjs applies sweeps any that leak
 * if this crashes.
 *
 * Usage:
 *   S3CAB_TEST_BUCKET=<bucket> node scripts/multipart-bench.mjs
 *   node scripts/multipart-bench.mjs <bucket> [path/to/file]
 *
 * With no file path it generates incompressible random payloads (so the wire,
 * not a provider's dedup/compression, is what's timed) and deletes them after.
 * A supplied file forces a single payload — its own size — ignoring the size list.
 *
 * Tunables (env vars), comma-separated lists where plural:
 *   S3CAB_BENCH_SIZE_MB   payload size(s) to generate, MB   (default 1024)
 *   S3CAB_BENCH_PARTS     part size(s), MB                  (default 16,32)
 *   S3CAB_BENCH_QUEUES    queueSize value(s)                (default 8,16,32)
 *   S3CAB_BENCH_REPS      samples per config (rounds)       (default 3)
 *
 * Note: S3 requires each non-final part to be >= 5 MB, so smaller part sizes are
 * skipped for payloads that would split.
 */
import { DeleteObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { createReadStream, statSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatByteValue } from "../src/lib/format.mjs";
import { writeRandomFile } from "./dd.mjs";

const MB = 1024 * 1024;
const MIN_PART = 5 * MB; // S3's hard floor for a non-final part.

const bucket = process.argv[2] ?? process.env.S3CAB_TEST_BUCKET;
if (!bucket) {
  console.error(
    "usage: node scripts/multipart-bench.mjs <bucket> [file]  (or set S3CAB_TEST_BUCKET)",
  );
  process.exit(2);
}

const region =
  process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? "us-east-1";

/**
 * Parse a comma-separated number list env var, or fall back.
 * @param {string | undefined} raw
 * @param {number[]} fallback
 * @returns {number[]}
 */
const numList = (raw, fallback) =>
  raw ? raw.split(",").map((n) => Number(n.trim())) : fallback;

const sizesMb = numList(process.env.S3CAB_BENCH_SIZE_MB, [1024]);
const partSizes = numList(process.env.S3CAB_BENCH_PARTS, [16, 32]).map((n) =>
  Math.round(n * MB),
);
const queueSizes = numList(process.env.S3CAB_BENCH_QUEUES, [8, 16, 32]);
const reps = Number(process.env.S3CAB_BENCH_REPS ?? "3");

// followRegionRedirects lets the client auto-correct to the bucket's real region
// via S3's 301 (as src/lib/s3.mjs does), so a bucket outside the default region
// works without setting AWS_REGION.
const client = new S3Client({ region, followRegionRedirects: true });

/**
 * Time one multipart upload of `path` with the given part/queue sizes, returning
 * throughput in bytes/sec. A fresh read stream per attempt (an Upload consumes
 * its body); the probe object is deleted before returning so runs don't pile up.
 * @param {string} path
 * @param {number} size - The file's size in bytes (already stat'd once).
 * @param {number} partSize
 * @param {number} queueSize
 * @returns {Promise<number>} Throughput, bytes/sec.
 */
async function timeUpload(path, size, partSize, queueSize) {
  const key = `bench/multipart/${partSize}-${queueSize}-${process.pid}-${Date.now()}`;
  const start = performance.now();
  const upload = new Upload({
    client,
    params: { Bucket: bucket, Key: key, Body: createReadStream(path) },
    partSize,
    queueSize,
  });
  await upload.done();
  const seconds = (performance.now() - start) / 1000;
  await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
  return size / seconds;
}

/** @param {number} bytesPerSec */
const rate = (bytesPerSec) => `${formatByteValue(bytesPerSec)}/s`;

/**
 * Median of a sample list, the robust summary this reports instead of a
 * best-of-N. Returns 0 for an empty list (never happens — every config is
 * sampled `reps` times — but keeps the caller total).
 * @param {number[]} xs
 * @returns {number}
 */
function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  if (s.length % 2 === 1) {
    return s[mid] ?? 0;
  }
  return ((s[mid - 1] ?? 0) + (s[mid] ?? 0)) / 2;
}

/** Fisher–Yates shuffle in place, so each round visits configs in a fresh order. */
const shuffle = (/** @type {any[]} */ xs) => {
  for (let i = xs.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [xs[i], xs[j]] = [xs[j], xs[i]];
  }
  return xs;
};

/**
 * The partSize × queueSize grid for one payload, reduced to the executions that
 * are actually distinct.
 *
 * `queueSize` is a ceiling, not a promise: real concurrency is
 * `min(queueSize, parts)`, so once the queue exceeds the part count the extra
 * slots do nothing and a deeper queue is the SAME upload. Those duplicates are
 * dropped (and reported) rather than measured twice — trap 1 in the header.
 * @param {number} size - Payload size in bytes.
 * @returns {{ configs: {
 *     partSize: number, queueSize: number, parts: number,
 *     streams: number, inFlight: number, capped: boolean }[],
 *   collapsed: string[] }}
 */
function grid(size) {
  const configs = [];
  const collapsed = [];
  /** @type {Set<string>} Effective (partSize, streams) already scheduled. */
  const seen = new Set();
  for (const partSize of partSizes) {
    if (partSize < MIN_PART && partSize < size) {
      continue; // below S3's 5 MB floor for a multipart part
    }
    const parts = Math.max(1, Math.ceil(size / partSize));
    for (const queueSize of queueSizes) {
      const streams = Math.min(queueSize, parts);
      const key = `${partSize}/${streams}`;
      if (seen.has(key)) {
        collapsed.push(
          `queueSize ${queueSize} @ ${formatByteValue(partSize)} parts → only ` +
            `${streams} streams (${parts} parts); same as a shallower queue`,
        );
        continue;
      }
      seen.add(key);
      configs.push({
        partSize,
        queueSize,
        parts,
        streams,
        inFlight: Math.min(size, partSize * streams),
        capped: queueSize > parts,
      });
    }
  }
  return { configs, collapsed };
}

/**
 * Benchmark one payload: interleave `reps` rounds over the grid, then print a
 * median-and-spread table sorted fastest-first.
 * @param {string} path
 * @param {number} size
 */
async function benchPayload(path, size) {
  const { configs, collapsed } = grid(size);
  console.log(
    `\n${"=".repeat(78)}\n` +
      `Payload: ${formatByteValue(size)}  |  ${configs.length} configs × ${reps} rounds ` +
      `= ${configs.length * reps} uploads\n${"=".repeat(78)}`,
  );
  for (const note of collapsed) {
    console.log(`  (skipped: ${note})`);
  }

  /** @type {Map<string, number[]>} */
  const samples = new Map();
  const key = (/** @type {{ partSize: number, queueSize: number }} */ c) =>
    `${c.partSize}/${c.queueSize}`;
  for (const c of configs) {
    samples.set(key(c), []);
  }

  for (let round = 0; round < reps; round++) {
    process.stdout.write(`  round ${round + 1}/${reps} `);
    for (const c of shuffle([...configs])) {
      const throughput = await timeUpload(path, size, c.partSize, c.queueSize);
      samples.get(key(c))?.push(throughput);
      process.stdout.write(".");
    }
    console.log("");
  }

  const rows = configs
    .map((c) => {
      const xs = samples.get(key(c)) ?? [];
      return {
        ...c,
        med: median(xs),
        lo: Math.min(...xs),
        hi: Math.max(...xs),
      };
    })
    .sort((a, b) => b.med - a.med);

  console.log(
    `\n  ${"partSize".padEnd(9)} ${"queue".padEnd(6)} ${"streams".padEnd(8)} ` +
      `${"in flight".padEnd(10)} ${"parts".padEnd(6)} ${"median".padStart(11)}   spread (min–max)`,
  );
  console.log("  " + "-".repeat(80));
  for (const r of rows) {
    console.log(
      `  ${formatByteValue(r.partSize).padEnd(9)} ${String(r.queueSize).padEnd(6)} ` +
        `${(String(r.streams) + (r.capped ? "*" : "")).padEnd(8)} ` +
        `${formatByteValue(r.inFlight).padEnd(10)} ${String(r.parts).padEnd(6)} ` +
        `${rate(r.med).padStart(11)}   ${rate(r.lo)} – ${rate(r.hi)}`,
    );
  }
  if (rows.some((r) => r.capped)) {
    console.log(
      `\n  * queueSize exceeded the part count — the payload capped concurrency, ` +
        `\n    so this row does NOT measure the queueSize asked for. Use a bigger payload.`,
    );
  }

  const winner = rows[0];
  if (winner) {
    console.log(
      `\n  Fastest @ ${formatByteValue(size)}: partSize ${formatByteValue(winner.partSize)}, ` +
        `queueSize ${winner.queueSize} → ${winner.streams} streams, ` +
        `${formatByteValue(winner.inFlight)} in flight — median ${rate(winner.med)}`,
    );
  }
}

async function main() {
  const givenPath = process.argv[3];
  console.log(`Bucket: ${bucket} (${region})  |  reps: ${reps}`);

  // Warm up the connection pool / TLS session so the first measured config isn't
  // charged for one-time handshake cost. Its own small file, so warm-up never
  // depends on the payloads below.
  const warmPath = join(tmpdir(), `s3cab-bench-warm-${Date.now()}.bin`);
  await writeRandomFile(warmPath, 8 * MB);
  console.log("Warming up …");
  await timeUpload(warmPath, 8 * MB, 8 * MB, 4);
  await unlink(warmPath).catch(() => {});

  if (givenPath) {
    await benchPayload(givenPath, statSync(givenPath).size);
  } else {
    for (const sizeMb of sizesMb) {
      const path = join(
        tmpdir(),
        `s3cab-multipart-bench-${sizeMb}mb-${Date.now()}.bin`,
      );
      console.log(`\nGenerating ${sizeMb} MB incompressible payload …`);
      await writeRandomFile(path, sizeMb * MB);
      try {
        await benchPayload(path, statSync(path).size);
      } finally {
        await unlink(path).catch(() => {});
      }
    }
  }
  console.log(
    "\nShipped default is partSize 16 MiB / queueSize 32 (ADR-0060) — compare above.",
  );
}

main().catch((error) => {
  console.error("Error:", error);
  process.exit(1);
});
