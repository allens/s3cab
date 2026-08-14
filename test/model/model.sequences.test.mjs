import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { mkdtempDisposable } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import { generateSequence } from "./harness/sequence.mjs";
import { runSequence } from "./harness/runner.mjs";
import { shrink } from "./harness/shrink.mjs";

/** @import { Step } from "./harness/sequence.mjs" */

// The model-based suite's main loop: random command sequences against the
// in-memory fake, invariants after every step, shrinking on failure.
//
// Reproduction: every sequence derives from an integer seed. On failure the
// report names the seed and prints the shrunk step list; re-run just that seed
// with S3CAB_MODEL_SEED=<seed> S3CAB_MODEL_SEQUENCES=1. Nightly widens the
// sweep with S3CAB_MODEL_SEQUENCES (and optionally longer sequences via
// S3CAB_MODEL_STEPS).

const FIRST_SEED = Number(process.env.S3CAB_MODEL_SEED ?? 1);
const SEQUENCES = Number(process.env.S3CAB_MODEL_SEQUENCES ?? 12);
const STEPS = Number(process.env.S3CAB_MODEL_STEPS ?? 25);

describe("model-based sequences (Tier 1, in-memory fake)", () => {
  it(
    `seeds ${FIRST_SEED}–${FIRST_SEED + SEQUENCES - 1} hold every invariant`,
    // The budget scales with the sweep: nightly runs thousands of sequences —
    // measured ~1.3 s each at 30 steps locally, roughly double on a CI Windows
    // runner — and a failure spends up to 200 shrink re-runs on top.
    { timeout: 600_000 + SEQUENCES * 4_000 },
    async () => {
      await using root = await mkdtempDisposable(join("test", ".tmp"));
      let n = 0;
      /** @param {Step[]} steps */
      const runFresh = async (steps) => {
        const dir = join(root.path, `run${n++}`);
        mkdirSync(dir, { recursive: true });
        try {
          return await runSequence(steps, dir);
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      };

      for (let seed = FIRST_SEED; seed < FIRST_SEED + SEQUENCES; seed++) {
        const steps = generateSequence(seed, { steps: STEPS });
        const result = await runFresh(steps);
        if (result.ok) {
          continue;
        }
        const shrunk = await shrink(steps, async (candidate) => {
          const rerun = await runFresh(candidate);
          return !rerun.ok;
        });
        const final = await runFresh(shrunk);
        assert.fail(
          `seed ${seed} violated the model after step ${final.stepIndex}` +
            ` (${final.step ? final.step.kind : "final sweep"}):\n` +
            final.violations.map((v) => `  ✗ ${v}`).join("\n") +
            `\n\nshrunk to ${shrunk.length} steps (from ${steps.length}):\n` +
            JSON.stringify(shrunk, null, 2) +
            (final.output.length
              ? `\n\ncommand output at the failing step:\n  ${final.output.join("\n  ")}`
              : ""),
        );
      }
    },
  );
});
