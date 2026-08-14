// The harness's seeded PRNG (mulberry32): every generated sequence and every
// fault decision derives from one integer seed, so a failure reproduces from
// its seed alone and shrinking replays deterministically.

export class Random {
  /** @param {number} seed */
  constructor(seed) {
    this.state = seed >>> 0;
    if (this.state === 0) {
      this.state = 0x9e3779b9; // seed 0 would fix mulberry32 near zero
    }
  }

  /** @returns {number} uniform in [0, 1) */
  next() {
    let t = (this.state += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** @param {number} n @returns {number} integer in [0, n) */
  int(n) {
    return Math.floor(this.next() * n);
  }

  /**
   * @template T
   * @param {T[]} items - Non-empty
   * @returns {T}
   */
  pick(items) {
    return /** @type {T} */ (items[this.int(items.length)]);
  }

  /** @param {number} p @returns {boolean} true with probability p */
  chance(p) {
    return this.next() < p;
  }
}
