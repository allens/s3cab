/** @import { Step } from "./sequence.mjs" */

// Delta-debugging shrink: greedily delete chunks of steps (halving chunk
// sizes down to single steps) while the sequence still fails. Works because
// the runner skips steps whose preconditions vanished — every subsequence is
// runnable — and because faults are pre-rolled per step, so survivors behave
// identically without their neighbours.

/**
 * @param {Step[]} steps - A failing sequence
 * @param {(candidate: Step[]) => Promise<boolean>} stillFails - Re-runs a
 *   candidate in a fresh root and reports whether it still violates.
 * @param {{ maxRuns?: number }} [options] - Budget on re-runs (default 200)
 * @returns {Promise<Step[]>} a locally minimal failing sequence
 */
export async function shrink(steps, stillFails, { maxRuns = 200 } = {}) {
  let current = steps;
  let runs = 0;
  for (let chunk = Math.ceil(current.length / 2); chunk >= 1;) {
    let removedAny = false;
    for (let start = 0; start < current.length && runs < maxRuns;) {
      const candidate = [
        ...current.slice(0, start),
        ...current.slice(start + chunk),
      ];
      runs++;
      const failed = candidate.length > 0 ? await stillFails(candidate) : false;
      if (failed) {
        current = candidate;
        removedAny = true;
        // The same start now holds the next chunk — don't advance.
      } else {
        start += chunk;
      }
    }
    if (chunk === 1) {
      if (!removedAny || runs >= maxRuns) {
        break; // fixpoint at single-step granularity (or out of budget)
      }
      // Another pass at 1: a removal may have enabled more.
    } else {
      chunk = Math.floor(chunk / 2);
    }
  }
  return current;
}
