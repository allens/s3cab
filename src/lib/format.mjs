import assert from "node:assert";

// Besides the formatters, this module is the **clock seam**: every instant an
// artifact *records* — a snapshot's name, header and `#END` trailer, a
// deletion record's or forget audit's stamp, a set marker's CREATED — is read
// here, by `localMoment` or `completionInstant`, and nowhere else. The model
// harness mocks this module to run every command on a virtual clock
// (test/model/harness/seam.mjs), so a `Temporal.Now` read anywhere else in
// `src/` is real time under the fake and makes the artifact it lands in
// non-deterministic there. Elapsed-time subtractions (progress, durations) are
// not records and read the clock directly.

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

/**
 * The plural of `word` for `n`: `plural(1, "file")` → `"file"`,
 * `plural(0, "file")` → `"files"`.
 *
 * **Regular forms only, deliberately.** What stays hand-rolled elsewhere is
 * clause agreement rather than noun morphology — `was`/`were`, `its`/`their`,
 * `This path matches`/`These paths match`, `Snapshot 'a' is`/`Snapshots 'a',
 * 'b' are` — and a helper that took a whole clause would *be* the sentence, not
 * a plural of it. (`directory`/`directories` is the lone irregular **noun**, and
 * a lookup table holding one word is not worth having.) Where it can be had, the
 * better fix is `referenced.mjs`'s: word the sentence so number never shows, and
 * one snapshot and forty read correctly from the same clause.
 * @param {number} n
 * @param {string} word
 * @returns {string}
 */
export const plural = (n, word) => (n === 1 ? word : `${word}s`);

/**
 * A counted noun: `countOf(1204, "file")` → `"1,204 files"`. The grouped count
 * and its plural always travel together in the report prose, and three modules
 * had spelled the pair out as an identical private helper
 * (`delete`/`deletion-record`/`unrestorable`), so it lives here with the two
 * halves it composes.
 * @param {number} n
 * @param {string} word
 * @returns {string}
 */
export const countOf = (n, word) => `${formatCount(n)} ${plural(n, word)}`;

/**
 * A headed `label / count / size` table with the numbers right-aligned and the
 * last row ruled off as the total:
 *
 * ```
 *   path                   files    size
 *   ~/photos               1,204   3.1GB
 *   shared across 3 paths     17   4.0MB
 *                          ─────────────
 *   total                  1,221   3.1GB
 * ```
 *
 * Right-aligned because the column being compared is the column being scanned —
 * ragged magnitudes defeat the only thing a total table is for. **The unit lives
 * in the header, not in every cell**: a column that repeats "files" on each row
 * is a header doing its job in the wrong place, and once said once the numbers
 * line up on their digits instead of on a noun.
 *
 * Every cell arrives **already formatted**, and that is what makes this shareable
 * between two different commands' previews: the caller keeps every decision that
 * is actually its own — which rows, what they and their columns are called, what
 * the total row is called, what (if anything) follows it — and hands over only
 * the padding arithmetic, which was never either command's decision to make.
 * @param {[string, string, string]} headers - Column names; counted in the widths, so they align with the cells below
 * @param {[string, string, string][]} rows - `[label, count, size]`, the **last** being the total
 * @param {string} [totalSuffix] - Trails the total row, outside the alignment (`delete` names the stored-object count there)
 * @returns {string[]}
 */
export function alignTotalTable(headers, rows, totalSuffix = "") {
  const total = rows.at(-1);
  assert(total, "alignTotalTable needs at least a total row");

  const cells = [headers, ...rows];
  const label = Math.max(...cells.map(([name]) => name.length));
  const countCol = Math.max(...cells.map(([, n]) => n.length));
  const sizeCol = Math.max(...cells.map(([, , size]) => size.length));
  const line = (/** @type {[string, string, string]} */ [name, n, size]) =>
    `  ${name.padEnd(label)}  ${n.padStart(countCol)}  ${size.padStart(sizeCol)}`;

  return [
    line(headers),
    ...rows.slice(0, -1).map(line),
    `  ${" ".repeat(label)}  ${"─".repeat(countCol + sizeCol + 2)}`,
    line(total) + totalSuffix,
  ];
}

// @ts-ignore - Intl.DurationFormat exists in Node 24+
const durationFormat = new Intl.DurationFormat("en", {
  // A sub-second duration rounds to all-zero, which the default "auto"
  // display renders as an empty string ("read in " + nothing) — always
  // show the seconds field instead ("0 secs").
  secondsDisplay: "always",
});

// Elapsed time for an *aligned* line, where the prose form (`1 hr, 12 min, 3
// sec`) can't be used because its width swings by a factor of five and every
// column after it would shift. Two most significant units, letters rather than
// a clock's colons: `12:21` reads as twelve-twenty-one, and `999:23` — 999
// minutes — is a duration nobody writes, so the colon form has to roll to
// `16:39:23` and change width anyway. Letters carry their own meaning, need no
// convention, and roll cleanly. Right-aligned in 7, which holds every duration
// up to `99h 59m`; the retained summary lines keep the prose form, which is
// what reads best in a sentence.
const ELAPSED_COLUMNS = 7;

/**
 * A whole-second span in the compact two-unit form — `45s`, `12m 21s`,
 * `3h 04m` — the shared core of the two spellings below. Private, because the
 * choice a caller actually makes is *padded or not*, and both those doors are
 * exported.
 * @param {number} totalSeconds
 * @returns {string}
 */
function compactSpan(totalSeconds) {
  const seconds = totalSeconds % 60;
  const minutes = Math.floor(totalSeconds / 60) % 60;
  const hours = Math.floor(totalSeconds / 3600);
  return hours > 0
    ? `${hours}h ${String(minutes).padStart(2, "0")}m`
    : minutes > 0
      ? `${minutes}m ${String(seconds).padStart(2, "0")}s`
      : `${seconds}s`;
}

/**
 * `    45s`, `12m 21s`, ` 3h 04m` — fixed width for a column that must not move.
 * @param {Temporal.Instant} instant
 * @returns {string}
 */
export const elapsedSince = (instant) =>
  compactSpan(
    Math.max(
      0,
      Math.floor(Temporal.Now.instant().since(instant).total("seconds")),
    ),
  ).padStart(ELAPSED_COLUMNS);

/**
 * The same compact form for a span already measured in milliseconds, unpadded —
 * for a line printed once rather than redrawn, where padding would only insert a
 * gap mid-sentence.
 *
 * The compact form rather than {@link formatDuration}'s prose one, against
 * [ADR-0076](../../docs/adr/0076-one-progress-line-driven-by-a-clock.md)'s
 * default for a retained summary: a backup's closing report puts *two* spans in
 * one line ([ADR-0078](../../docs/adr/0078-backup-run-report.md) §9), and
 * `9 minutes, 12 seconds` carries a comma of its own that collides with the
 * commas separating the line's own clauses.
 * @param {number} milliseconds
 * @returns {string}
 */
export const shortDuration = (milliseconds) =>
  compactSpan(Math.max(0, Math.round(milliseconds / 1000)));

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
 * The one clock read behind both seam exports, so a test that pins
 * `Temporal.Now.zonedDateTimeISO` has pinned the whole seam.
 */
const readClock = () => Temporal.Now.zonedDateTimeISO();

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
  const now = readClock();
  return {
    name: now.toPlainDateTime().toString({ smallestUnit }).replaceAll(":", ""),
    instant: now.toInstant().toString({ smallestUnit: "millisecond" }),
    zone: now.timeZoneId,
  };
}

/**
 * The instant that vouches for everything written before it — a snapshot's
 * `#END` trailer ([ADR-0082](../../docs/adr/0082-snapshot-end-trailer.md)),
 * which the ctime cross-check weighs a file against on the next pass
 * ([ADR-0085](../../docs/adr/0085-ctime-cross-check-on-hash-reuse.md)). UTC at
 * millisecond precision like `localMoment`'s `instant`, but **rounded up, not
 * truncated**: the column holds milliseconds and the clock has more digits, so
 * one direction has to be chosen and the default (`trunc`) is the wrong one. A
 * truncated value claims a moment up to a millisecond *earlier* than the write
 * really ended, so a file whose ctime landed inside that last millisecond reads
 * as touched afterwards and is distrusted for ever — the exact failure the
 * trailer exists to end. Rounding up can over-vouch by under a millisecond
 * instead: a rewrite completing between the true last row and the recorded
 * instant. A far better trade, and `ctimeMs` carries sub-millisecond precision
 * on every filesystem here, so the comparison stays meaningful.
 * @returns {string}
 */
export const completionInstant = () =>
  readClock().toInstant().toString({
    smallestUnit: "millisecond",
    roundingMode: "ceil",
  });

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
