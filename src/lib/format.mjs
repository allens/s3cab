import assert from "node:assert";

// Decimal SI (base 1000). One cached Intl formatter per unit: this runs on the
// hot S3 upload-progress path, so we don't construct a formatter per call.
const byteUnits = [
  "byte",
  "kilobyte",
  "megabyte",
  "gigabyte",
  "terabyte",
  "petabyte",
];
const byteFormatters = byteUnits.map(
  (unit, i) =>
    new Intl.NumberFormat("en", {
      style: "unit",
      unit,
      unitDisplay: "narrow",
      // Scaled units (kB+) always show one decimal so a whole value reads as
      // "3.0MB", not "3MB"; raw bytes are exact integer counts, so no ".0".
      minimumFractionDigits: i === 0 ? 0 : 1,
      maximumFractionDigits: 1,
    }),
);

/**
 * Human-readable byte size, decimal SI: `1500` → `"1.5kB"`, `1_500_000_000` →
 * `"1.5GB"`. Picks the unit by magnitude rather than `Intl`'s
 * `notation: "compact"`, whose English short-scale "B"(illion) suffix collides
 * with the byte unit (it rendered 10⁹ as `"1.5BB"`, and emitted `"KB"` not SI
 * `"kB"`).
 * @param {number} bytes
 */
export const formatByteValue = (bytes) => {
  let value = bytes;
  let unit = 0;
  while (value >= 1000 && unit < byteFormatters.length - 1) {
    value /= 1000;
    unit++;
  }
  const formatter = byteFormatters[unit];
  assert(formatter); // `unit` is bounded by the loop; this just narrows the type
  return formatter.format(value);
};

// @ts-ignore - Intl.DurationFormat exists in Node 24+
const durationFormat = new Intl.DurationFormat("en", {
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
