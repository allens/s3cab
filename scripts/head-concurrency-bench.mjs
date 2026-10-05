/**
 * Measure how many HEADs to keep in flight when checking many stored objects at
 * once — the experiment behind `HEAD_CONCURRENCY` in src/lib/objects.mjs, which
 * `storedObjectSizes` uses for `delete`'s preflight and `forget`'s preview.
 * Re-run it when a link, a region, a provider or the SDK changes.
 *
 * ## The question
 *
 * A HEAD carries no body, so checking N objects one at a time is N round trips
 * back to back. With C in flight it should take about N ÷ C of that, until
 * something else binds: the provider, the link, or the SDK's socket pool (50 per
 * client by default, which s3cab leaves alone — so rows past 50 measure the
 * pool, not the provider). Read the table for the knee: the smallest C past
 * which the median stops falling by more than the spread. Not the fastest row —
 * past the knee, which one wins is noise.
 *
 * The round trip, not the link's bandwidth, is what moves the knee: the longer
 * each HEAD waits, the more in flight pays. So the run opens by timing HEADs one
 * at a time and prints that round trip, which is what makes tables taken from
 * different places comparable.
 *
 * ## What it does
 *
 * Each sample HEADs `S3CAB_BENCH_HEAD_COUNT` fresh random keys under
 * `bench/head/`, none of which exist, through s3cab's own `objectSize` — the
 * production client, so its timeouts, its socket pool and any
 * `AWS_ENDPOINT_URL_S3` provider are what get measured. A missing key costs the
 * same round trip as a present one, and needs nothing written first or cleaned
 * up after. It does need `s3:ListBucket`: without it S3 answers 403, not 404,
 * and the run stops on the first HEAD.
 *
 * Sampling (interleaved rounds, median and spread) is bench-sampling.mjs's.
 *
 * Bucket comes from S3CAB_TEST_BUCKET (the gated-suite bucket) or the first arg;
 * credentials and region are ambient, as for the integration suite.
 *
 * Usage:
 *   node --env-file-if-exists=.env.test scripts/head-concurrency-bench.mjs
 *   node scripts/head-concurrency-bench.mjs <bucket>
 *
 * Tunables (env vars), comma-separated where plural:
 *   S3CAB_BENCH_HEAD_CONCURRENCY  HEADs in flight to compare  (default 8,16,32,50,64)
 *   S3CAB_BENCH_HEAD_COUNT        HEADs per sample            (default 640)
 *   S3CAB_BENCH_HEAD_REPS         samples per concurrency     (default 5)
 */
import { randomUUID } from "node:crypto";
import { objectSize } from "../src/lib/s3.mjs";
import { median, numList, positive, shuffle } from "./bench-sampling.mjs";

const bucket = process.argv[2] ?? process.env.S3CAB_TEST_BUCKET;
if (!bucket) {
  console.error(
    "usage: node scripts/head-concurrency-bench.mjs <bucket>  (or set S3CAB_TEST_BUCKET)",
  );
  process.exit(2);
}

const concurrencies = numList(
  "S3CAB_BENCH_HEAD_CONCURRENCY",
  process.env.S3CAB_BENCH_HEAD_CONCURRENCY,
  [8, 16, 32, 50, 64],
).sort((a, b) => a - b);
const count = positive(
  "S3CAB_BENCH_HEAD_COUNT",
  Number(process.env.S3CAB_BENCH_HEAD_COUNT ?? "640"),
);
const reps = positive(
  "S3CAB_BENCH_HEAD_REPS",
  Number(process.env.S3CAB_BENCH_HEAD_REPS ?? "5"),
);

const missingUri = () => `s3://${bucket}/bench/head/${randomUUID()}`;

/**
 * One HEAD's round trip on its own: the median of `n` HEADs one at a time,
 * after one more that pays for the credential chain and the TLS session.
 * @param {number} n
 * @returns {Promise<number>} Milliseconds.
 */
async function roundTrip(n) {
  await objectSize(missingUri());
  /** @type {number[]} */
  const times = [];
  for (let i = 0; i < n; i++) {
    const start = performance.now();
    await objectSize(missingUri());
    times.push(performance.now() - start);
  }
  return median(times);
}

/**
 * HEAD `count` fresh missing keys with `concurrency` in flight, returning the
 * wall-clock milliseconds. The workers share one iterator, so each key is HEADed
 * once — the shape `storedObjectSizes` has.
 * @param {number} concurrency
 * @returns {Promise<number>}
 */
async function timeHeads(concurrency) {
  const uris = Array.from({ length: count }, missingUri);
  const queue = uris.values();
  const start = performance.now();
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      for (const uri of queue) {
        await objectSize(uri);
      }
    }),
  );
  return performance.now() - start;
}

/** @param {number} ms */
const seconds = (ms) => `${(ms / 1000).toFixed(2)}s`;

async function main() {
  console.log(
    `Bucket: ${bucket}  |  ${count} HEADs per sample  |  reps: ${reps}`,
  );

  const rtt = await roundTrip(20);
  console.log(`Round trip: ${rtt.toFixed(1)}ms per HEAD, one at a time`);

  /** @type {Map<number, number[]>} */
  const samples = new Map(concurrencies.map((c) => [c, []]));
  for (let round = 0; round < reps; round++) {
    process.stdout.write(`  round ${round + 1}/${reps} `);
    for (const c of shuffle([...concurrencies])) {
      const ms = await timeHeads(c);
      samples.get(c)?.push(ms);
      process.stdout.write(".");
    }
    console.log("");
  }

  const rows = concurrencies.map((c) => {
    const xs = samples.get(c) ?? [];
    return { c, med: median(xs), lo: Math.min(...xs), hi: Math.max(...xs) };
  });
  const oneAtATime = count * rtt;

  console.log(
    `\n  ${"in flight".padStart(9)} ${"median".padStart(8)} ${"per HEAD".padStart(9)} ` +
      `${"speed-up".padStart(8)}   spread (min–max)`,
  );
  console.log("  " + "-".repeat(60));
  for (const r of rows) {
    console.log(
      `  ${String(r.c).padStart(9)} ${seconds(r.med).padStart(8)} ` +
        `${`${(r.med / count).toFixed(1)}ms`.padStart(9)} ` +
        `${`${(oneAtATime / r.med).toFixed(1)}×`.padStart(8)}   ` +
        `${seconds(r.lo)} – ${seconds(r.hi)}`,
    );
  }
  console.log(
    "\nSpeed-up is against one at a time, estimated from the round trip.",
  );
}

main().catch((error) => {
  console.error("Error:", error);
  process.exit(1);
});
