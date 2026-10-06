/**
 * The sampling method the network benchmarks share (multipart-bench.mjs,
 * request-concurrency-bench.mjs), and their env-var parsing.
 *
 * Network timings drift minute to minute, enough to swamp the differences being
 * measured. So a benchmark interleaves — one sample of every config per round,
 * in a fresh order each round — and reports the MEDIAN plus min–max spread,
 * never a best-of-N (which just rewards whichever config ran in the quietest
 * window). A gap between two medians means something only if it clears the
 * spread.
 */

/**
 * Every tunable is a positive count or size, so anything else is a typo, not a
 * setting. Rejected loudly at parse time because the failure is otherwise
 * silent-but-plausible: a NaN `reps` runs zero rounds and then reports median 0
 * with an Infinity–-Infinity spread, which reads as a result rather than a
 * mistake.
 * @param {string} name - The env var, so the error names what to fix.
 * @param {number} value
 * @returns {number}
 */
export function positive(name, value) {
  if (!Number.isFinite(value) || value <= 0) {
    console.error(`${name}: expected a positive number (got "${value}")`);
    process.exit(2);
  }
  return value;
}

/**
 * Parse a comma-separated number list env var, or fall back.
 * @param {string} name
 * @param {string | undefined} raw
 * @param {number[]} fallback
 * @returns {number[]}
 */
export const numList = (name, raw, fallback) =>
  raw ? raw.split(",").map((n) => positive(name, Number(n.trim()))) : fallback;

/**
 * Median of a sample list. Returns 0 for an empty list (never happens — every
 * config is sampled `reps` times — but keeps the caller total).
 * @param {number[]} xs
 * @returns {number}
 */
export function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  if (s.length % 2 === 1) {
    return s[mid] ?? 0;
  }
  return ((s[mid - 1] ?? 0) + (s[mid] ?? 0)) / 2;
}

/** Fisher–Yates shuffle in place, so each round visits configs in a fresh order. */
export const shuffle = (/** @type {any[]} */ xs) => {
  for (let i = xs.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [xs[i], xs[j]] = [xs[j], xs[i]];
  }
  return xs;
};
