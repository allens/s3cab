/** @import { Fault, FaultSource } from "./fake-s3.mjs" */

// Per-step fault plans. A step's fault is *pre-rolled data* on the step
// itself ({ atOp, kind }), not a live PRNG at the seam — so removing other
// steps during shrinking never shifts which request a surviving step's fault
// hits, and a shrunk sequence still reproduces the original failure.

/**
 * A pre-rolled fault: the step's `atOp`-th backend request (counting every
 * `plan` consultation, 0-based) gets `kind`; every other request is clean.
 * A step whose command issues fewer requests than `atOp` simply runs clean —
 * the generator over-rolls on purpose so shrinking can't strand a fault.
 * @typedef {{ atOp: number, kind: Fault }} FaultSpec
 */

/**
 * The FaultSource the runner installs on the fake for one step.
 * @implements {FaultSource}
 */
export class StepFaults {
  /** @param {FaultSpec} spec */
  constructor(spec) {
    this.spec = spec;
    this.calls = 0;
    /** @type {string | null} what actually got hit, for failure reports */
    this.fired = null;
  }

  /**
   * @param {string} op
   * @param {string} uri
   * @returns {Fault | undefined}
   */
  plan(op, uri) {
    const index = this.calls++;
    if (index === this.spec.atOp) {
      this.fired = `${this.spec.kind} on ${op} ${uri}`;
      return this.spec.kind;
    }
    return undefined;
  }
}
