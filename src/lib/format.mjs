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

// Grouped integers for the human-facing counts the progress lines report
// ("265,716 files", "312,004 objects") — six digits run together are unreadable
// at a glance, which is the only thing those lines are for.
const countFormat = new Intl.NumberFormat("en");

/**
 * A count with thousands separators: `265716` → `"265,716"`.
 * @param {number} count
 * @returns {string}
 */
export const formatCount = (count) => countFormat.format(count);

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

// A *duration* in prose, as opposed to an elapsed time. Separate from
// `durationFormat` above for one reason: its `secondsDisplay: "always"` is right
// for "read in 0 secs" and wrong here, where a round two minutes would render as
// "2 min, 0 sec". `style: "long"` because this lands mid-sentence — "up to 2
// minutes" reads, "up to 2 min" doesn't.
// @ts-ignore - Intl.DurationFormat exists in Node 24+
const proseDurationFormat = new Intl.DurationFormat("en", { style: "long" });

/**
 * A millisecond span as words: `120_000` → `"2 minutes"`, `60_000` →
 * `"1 minute"`, `30_000` → `"30 seconds"`, `90_000` → `"1 minute, 30 seconds"`.
 *
 * Intl picks the units and the plurals, so callers never hand-roll a
 * seconds-versus-minutes rule — the ad-hoc one this replaced rounded 90 s up to
 * "2 minutes", which is exactly the kind of quiet misstatement a shared formatter
 * exists to prevent.
 * @param {number} milliseconds
 * @returns {string}
 */
export const formatDuration = (milliseconds) =>
  proseDurationFormat.format(
    Temporal.Duration.from({ milliseconds }).round({
      smallestUnit: "seconds",
      largestUnit: "hours",
    }),
  );

/**
 * One moment, in the two spellings every timestamped artifact records
 * ([ADR-0072](../../docs/adr/0072-timestamps-utc-in-files-local-in-names.md)),
 * from a **single clock read**:
 *
 * - `name` — local wall clock with the colons dropped, at the precision the
 *   artifact names itself by (`minutes` for a snapshot and a deletion record,
 *   `seconds` for a forget audit). This is the *identity*: a filename, typed and
 *   read by people, so it stays the time the clock on the wall said.
 * - `instant` — the same moment in UTC at millisecond precision, the
 *   machine-readable field of record. Exactly 24 characters, like an `mtime`.
 * - `zone` — the IANA zone the name was minted in, which is what makes a naive
 *   local name resolvable, and which explains a DST shift rather than merely
 *   recording one.
 *
 * One read matters: taking the instant separately would let an `await` slip a
 * boundary between the two, and an artifact whose name and contents disagree is
 * exactly what a record must never be.
 * @param {"minutes" | "seconds"} smallestUnit - The precision the artifact names itself by
 * @returns {{ name: string, instant: string, zone: string }}
 */
export function localMoment(smallestUnit) {
  const now = Temporal.Now.zonedDateTimeISO();
  return {
    name: now.toPlainDateTime().toString({ smallestUnit }).replaceAll(":", ""),
    instant: now.toInstant().toString({ smallestUnit: "millisecond" }),
    zone: now.timeZoneId,
  };
}

/**
 * A moment as a record file's `# generated:` value — the machine-readable
 * instant first, then the artifact's own name and the clock it was minted from:
 *
 * ```
 * 2026-07-19T13:22:04.881Z  (2026-07-19T1422 Europe/London)
 * ```
 *
 * One spelling for every such header, so the format spec tells one story
 * (ADR-0072). The parenthetical is deliberately the file's *own name*, not "the
 * local time" — so a record found detached still says what it was called.
 * @param {{ name: string, instant: string, zone: string }} moment
 * @returns {string}
 */
export const formatMoment = ({ name, instant, zone }) =>
  `${instant}  (${name} ${zone})`;
