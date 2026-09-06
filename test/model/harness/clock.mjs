// The model harness's virtual clock (Tier 1 only). Snapshot names are
// minute-precision wall clock read through `localMoment` (src/lib/format.mjs)
// with no injection hook, and a same-minute snapshot is refused — so a sequence
// that takes several snapshots needs a clock it can advance. The seam module
// (seam.mjs) mocks `format.mjs` to route its two clock reads here; everything
// below the seam then mints names, instants, `#END` trailers and audit
// timestamps from virtual time. Every export format.mjs reads the clock for
// needs a twin here *and* an entry in seam.mjs's mock — the mock spreads the
// real module, so a missing twin falls through to real time silently.
//
// Zone is pinned to UTC so generated names are deterministic on any machine.
// The clock only ever moves forward (the runner advances it ≥1 minute per op);
// tests that want the clock-went-backwards path set it backwards deliberately.

/** @typedef {{ name: string, instant: string, zone: string }} Moment */

/**
 * One virtual clock: epoch-milliseconds state plus the same `localMoment`
 * surface format.mjs exposes.
 */
export class VirtualClock {
  /** @param {number} startMs - Virtual epoch ms the clock starts at */
  constructor(startMs) {
    this.ms = startMs;
  }

  /** @returns {number} the current virtual time in epoch ms */
  now() {
    return this.ms;
  }

  /** @param {number} ms - How far to advance (may be negative, deliberately) */
  advance(ms) {
    this.ms += ms;
  }

  /**
   * Drop-in for format.mjs's `localMoment`, minted from virtual time in UTC.
   * @param {"minutes" | "seconds"} smallestUnit
   * @returns {Moment}
   */
  localMoment(smallestUnit) {
    const zdt = Temporal.Instant.fromEpochMilliseconds(
      this.ms,
    ).toZonedDateTimeISO("UTC");
    return {
      name: zdt
        .toPlainDateTime()
        .toString({ smallestUnit })
        .replaceAll(":", ""),
      instant: zdt.toInstant().toString({ smallestUnit: "millisecond" }),
      zone: zdt.timeZoneId,
    };
  }

  /**
   * Drop-in for format.mjs's `completionInstant`. Virtual time is whole
   * milliseconds, so the real one's round-up is the identity here.
   * @returns {string}
   */
  completionInstant() {
    return Temporal.Instant.fromEpochMilliseconds(this.ms).toString({
      smallestUnit: "millisecond",
    });
  }
}

/** A minute, a day — the two units sequences advance by. */
export const MINUTE_MS = 60_000;
export const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The mutable holder seam.mjs's `localMoment` mock reads through, so each
 * sequence can install a fresh clock without re-registering module mocks
 * (mock.module is once-per-process).
 * @type {{ current: VirtualClock }}
 */
export const clockHolder = {
  // A default so accidental pre-sequence reads still produce a valid moment;
  // every sequence replaces it. 2026-01-05T00:00Z, an arbitrary fixed origin.
  current: new VirtualClock(Date.UTC(2026, 0, 5)),
};
