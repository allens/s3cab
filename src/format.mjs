import { Temporal } from "@js-temporal/polyfill";

const byteValueNumberFormatter = Intl.NumberFormat("en", {
  notation: "compact",
  style: "unit",
  unit: "byte",
  unitDisplay: "narrow",
});

export const formatByteValue = (bytes) =>
  byteValueNumberFormatter.format(bytes);

// @ts-ignore - Intl.DurationFormat exists in Node 24+
const durationFormat = new Intl.DurationFormat();

export const secondsSince = (instant) =>
  durationFormat.format(
    Temporal.Now.instant().since(instant).round({
      smallestUnit: "seconds",
      largestUnit: "hours",
    }),
  );
