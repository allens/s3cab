import { secondsSince } from "./format.mjs";
import { statusLine } from "./progress.mjs";

// Telling the user that s3cab is waiting out a dropped network rather than hung.
//
// ADR-0068 lets a request keep retrying a dropped link for two minutes. That is
// the right call for an unattended backup, but it means the upload bar can sit
// frozen for two minutes, which reads as a hang — the responsiveness point
// clig.dev makes. One line saying what is happening fixes that.
//
// **Why this holds state instead of printing from the relay.** A multipart
// upload has `queueSize` parts in flight (32 — ADR-0060), and a dropped link
// fails all of them at once, so a message printed per request would arrive 32
// times, then 32 more on the next attempt. clig.dev's signal-to-noise rule —
// group many similar failures under one header rather than a line each — makes
// one message per *outage* a requirement, not a nicety. Hence the reference
// count: the outage begins when the first request starts waiting and ends when
// the last one stops.
//
// Module-level mutable state is a smell worth justifying: the terminal genuinely
// is one shared resource, and "is the network currently down" is one fact about
// the whole run, not about any request that noticed. Keeping it out of
// progress.mjs leaves that module the pure factory it is.

/** Requests currently waiting out the same outage. */
let waiting = 0;
/** Whether this outage has been announced (so it is announced exactly once). */
let announced = false;
/** Whether any request got through since the outage began. */
let recovered = false;
/** @type {Temporal.Instant | undefined} When the outage was announced. */
let since;

/**
 * How long s3cab will keep trying, in words — so the line sets an expectation
 * ("it will give up eventually") rather than leaving the reader to guess. Taken
 * from the caller's actual window, so the sentence can't drift from the policy
 * it describes.
 * @param {number} windowMs
 * @returns {string}
 */
const windowPhrase = (windowMs) => {
  const seconds = Math.round(windowMs / 1000);
  return seconds >= 90
    ? `${Math.round(seconds / 60)} minutes`
    : `${seconds} seconds`;
};

/**
 * Count a request into the current network outage, announcing it if it is the
 * first. Pair every call with {@link leaveNetworkWait} — a `finally` is the only
 * safe place, since the request can also throw.
 *
 * The caller decides *when* a wait is worth announcing (the relay waits for the
 * second retry, so a blip that clears inside one backoff stays quiet); this
 * decides only that it is said once.
 * @param {NodeJS.WriteStream} stream - Usually `process.stderr`
 * @param {number} windowMs - How long the caller will keep retrying.
 */
export function enterNetworkWait(stream, windowMs) {
  waiting += 1;
  if (announced) {
    return;
  }
  announced = true;
  recovered = false;
  since = Temporal.Now.instant();
  statusLine(
    stream,
    `Connection lost — waiting for the network to come back ` +
      `(up to ${windowPhrase(windowMs)})…`,
  );
}

/**
 * Count a request out of the outage, reporting recovery once the last one is
 * done.
 *
 * Silent when nothing got through: the run is about to fail, and its error
 * explains why far better than a bare "no longer waiting" would. Saying "back
 * online" there would be a plain lie — the one outcome worse than saying
 * nothing.
 * @param {NodeJS.WriteStream} stream - Usually `process.stderr`
 * @param {object} outcome
 * @param {boolean} outcome.recovered - Whether *this* request completed.
 */
export function leaveNetworkWait(stream, { recovered: completed }) {
  waiting -= 1;
  recovered ||= completed;
  if (waiting > 0) {
    return;
  }
  if (announced && recovered && since) {
    statusLine(
      stream,
      `Back online after ${secondsSince(since)} — continuing.`,
    );
  }
  announced = false;
  recovered = false;
  since = undefined;
}
