import { DAY_MS, MINUTE_MS } from "./clock.mjs";
import { Random } from "./random.mjs";

/** @import { FaultSpec } from "./faults.mjs" */

// The random-sequence generator: turns one seed into a list of *data* steps
// the runner interprets. Steps are self-contained and order-independent in
// validity — the runner skips any step whose preconditions aren't met (a
// backup of a set that was never created, a forget with nothing to forget) —
// so every subsequence of a valid sequence is itself valid, which is what
// makes shrinking a matter of deleting steps.

/**
 * @typedef {(
 *   | { kind: "create-set", machine: number, set: string, seedFiles: number[] }
 *   | { kind: "mutate", set: string, file: string, content: number | null }
 *   | { kind: "advance", ms: number }
 *   | { kind: "backup", machine: number, set: string, fault?: FaultSpec }
 *   | { kind: "snapshot", machine: number, set: string }
 *   | { kind: "restore", machine: number, set: string, index: number, fault?: FaultSpec }
 *   | { kind: "verify", fault?: FaultSpec }
 *   | { kind: "forget", machine: number, set: string, index: number, fault?: FaultSpec }
 *   | { kind: "cleanup", fault?: FaultSpec }
 *   | { kind: "reattach", machine: number, set: string }
 * )} Step
 */

/**
 * The file-name pool trees mutate over. Windows-safe, includes a nested path
 * and names that dodge the starter excludes (the runner blanks those anyway).
 */
const FILES = [
  "f0.txt",
  "f1.txt",
  "f2.txt",
  "sub/f3.txt",
  "sub/deep/f4.bin",
  "zero.dat",
];

/** How many distinct content kinds `contentBytes` can mint. */
export const CONTENT_KINDS = 8;

/**
 * Deterministic content for a content-kind index. Kind 0 is the empty file
 * (zero-byte edge); higher kinds give distinct, size-varied content. Two
 * mutate steps with the same kind write *identical* bytes — that is the dedup
 * case, on purpose.
 * @param {number} kind
 * @returns {Buffer}
 */
export const contentBytes = (kind) =>
  kind === 0
    ? Buffer.alloc(0)
    : Buffer.from(`s3cab model content ${kind}\n`.repeat(kind * kind * 3));

/**
 * @param {Random} rng
 * @param {("fail-before" | "fail-after" | "duplicate" | "truncate")[]} kinds
 * @returns {FaultSpec | undefined}
 */
const maybeFault = (rng, kinds) =>
  rng.chance(0.25) ? { atOp: rng.int(12), kind: rng.pick(kinds) } : undefined;

/** The write-op fault kinds; reads add "truncate". */
const WRITE_FAULTS = /** @type {const} */ ([
  "fail-before",
  "fail-after",
  "duplicate",
]);

/**
 * Generate one sequence from a seed.
 * @param {number} seed
 * @param {{ steps?: number }} [options]
 * @returns {Step[]}
 */
export function generateSequence(seed, { steps: stepCount = 25 } = {}) {
  const rng = new Random(seed);
  const machines = rng.chance(0.4) ? 2 : 1;
  const sets = rng.chance(0.35) ? ["alpha", "beta"] : ["alpha"];

  /** @type {Step[]} */
  const steps = [];
  for (const set of sets) {
    steps.push({
      kind: "create-set",
      machine: 0,
      set,
      seedFiles: [
        1 + rng.int(CONTENT_KINDS - 1),
        1 + rng.int(CONTENT_KINDS - 1),
      ],
    });
  }

  while (steps.length < stepCount) {
    const set = rng.pick(sets);
    const machine = rng.int(machines);
    const roll = rng.next();
    if (roll < 0.3) {
      steps.push({
        kind: "mutate",
        set,
        file: rng.pick(FILES),
        content: rng.chance(0.15) ? null : rng.int(CONTENT_KINDS),
      });
    } else if (roll < 0.55) {
      steps.push({
        kind: "backup",
        machine,
        set,
        fault: maybeFault(rng, [...WRITE_FAULTS]),
      });
    } else if (roll < 0.62) {
      steps.push({
        kind: "advance",
        ms: rng.pick([30 * MINUTE_MS, DAY_MS, 8 * DAY_MS]),
      });
    } else if (roll < 0.67) {
      steps.push({ kind: "snapshot", machine, set });
    } else if (roll < 0.75) {
      steps.push({
        kind: "restore",
        machine,
        set,
        index: rng.int(8),
        fault: maybeFault(rng, [...WRITE_FAULTS, "truncate"]),
      });
    } else if (roll < 0.83) {
      steps.push({ kind: "verify", fault: maybeFault(rng, [...WRITE_FAULTS]) });
    } else if (roll < 0.89) {
      steps.push({
        kind: "forget",
        machine,
        set,
        index: rng.int(8),
        fault: maybeFault(rng, [...WRITE_FAULTS]),
      });
    } else if (roll < 0.95) {
      steps.push({
        kind: "cleanup",
        fault: maybeFault(rng, [...WRITE_FAULTS]),
      });
    } else {
      steps.push({ kind: "reattach", machine: machines - 1, set });
    }
  }
  return steps;
}
