const byteValueNumberFormatter = Intl.NumberFormat("en", {
  notation: "compact",
  style: "unit",
  unit: "byte",
  unitDisplay: "narrow",
});

/** @param {number} bytes */
export const formatByteValue = (bytes) =>
  byteValueNumberFormatter.format(bytes);

// @ts-ignore - Intl.DurationFormat exists in Node 24+
const durationFormat = new Intl.DurationFormat(undefined, {
  // A sub-second duration rounds to all-zero, which the default "auto"
  // display renders as an empty string ("read in " + nothing) — always
  // show the seconds field instead ("0 secs").
  secondsDisplay: "always",
});

/** @param {Temporal.Instant} instant */
export const secondsSince = (instant) =>
  durationFormat.format(
    Temporal.Now.instant().since(instant).round({
      smallestUnit: "seconds",
      largestUnit: "hours",
    }),
  );
