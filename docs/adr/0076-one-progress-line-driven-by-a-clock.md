# One progress line per pass, driven by a clock

**Status:** accepted & implemented. Extends
[0010](0010-cli-output-conventions.md)'s output/stream discipline and
[0043](0043-human-first-output.md)'s human-first rendering to *progress*, and settles the display
[0069](0069-fused-snapshot-upload-pipeline.md) left behind when it fused two passes into one.

## Context

Progress grew one display per activity, each written when that activity was a command of its own.
The oldest pair date to the first commit: a hashing counter (`Generating snapshot file…: 12.34%`)
and a per-file upload byte bar, belonging to two commands you ran one after the other. They could
not appear together, so nothing had to reconcile them.

ADR-0069 fused hashing and uploading into a single pass. The display did not follow, and four
faults surfaced in use:

- **Every line gated on a *count*** — every 500 objects, every 1,000 files, every changed
  percentage. A count bounds how much happens between redraws but says nothing about how *often*
  they happen: the identical gate is placid on a network-paced LIST (a page per round trip) and a
  strobe on a warm dircache yielding tens of thousands of paths a second. The snapshot counter's
  gate was no gate at all below 10,000 files, where every file moves the second decimal place.
- **The redraw blanked the line before rewriting it.** `clearLine` then `write` leaves a window in
  which a terminal repaint shows an empty row. Invisible at a few redraws a second; at hundreds it
  *is* the flicker.
- **Two owners, one row.** The fused pass drew a counter while each file's upload drew a bar over
  it, and every finished bar was left behind — a wall of identical full bars scrolling past the
  line that was actually tracking the run.
- **The label named half the work.** "Generating snapshot file" while the wait is object
  transfers, in a pass that hashes *and* uploads.

Two further faults were only visible in a real run, and share a root: **a redraw driven by the
data cannot report on the data's own stalls.**

- The store LIST yields a page of 1,000 keys with no wait between them, so a redraw-interval gate
  fired on the first key after each round trip — the count appeared only ever as a multiple of
  1,000 *plus one*, then froze for the next round trip.
- The snapshot pipeline is *pull*-based (paths → hash → upload → write), so redrawing as each path
  is pulled means redrawing only *between* rows — precisely when nothing is being sent. The
  transfer detail was never once on screen while it had something to say, and a row taking minutes
  froze the whole line.

## Decision

**One progress line per pass, owned by one module, driven by a clock.**

1. **`lib/progress.mjs` owns the mechanic and the cadence; each caller owns only what its line
   says.** Redraws are paced there (10/sec), not by per-caller count gates. An update arriving
   inside the interval is *held*, not dropped, and drawn when the line closes — so a caller's
   closing summary is an ordinary update the pacing cannot swallow. `due()` exists for hot loops
   to ask before composing text (~0.5µs to build a line against ~0.07µs to ask); `clear()` is for
   progress that was only ever live, and must leave nothing behind.
2. **Write, then clear the tail — never clear, then write.** Same end state, no blank frame.
3. **Where the data is bursty or blocking, a timer drives the redraw, not the data.** The store
   LIST and the fused pass both take a `setInterval` (`unref`'d, cleared in a `finally`). This is
   the general rule the two real-run faults above teach: the moments worth reporting are exactly
   the moments the data stops arriving.
4. **The porcelain announces once; the engine reports.** Each command heads its pass with a line
   naming what it is doing and to what (`Backing up 'photos/2026-07-31T0915' ('<path>'):`), so the
   dynamic line carries no constant text — a dozen columns repeated four times a second, which the
   file path needs instead. `<set>/<snapshot>` is the notation the rest of the output already uses.
5. **A row earns its name by taking a second.** Below that it is over before it can be read, and
   naming tens of thousands of fast files hides the one that is actually holding things up.
   Applied uniformly to hashing and uploading, both of which carry a start time.
6. **Report a figure only once it has been measured.** A sub-multipart upload is a single PUT and
   the SDK reports its bytes once, at the end — so "0%" would dress "nothing has come back yet" up
   as a measurement. The size is always known and always shown; the percentage is parenthetical,
   joining it when there is one: `Uploading 1.8GB (27%)`, `Uploading 1.5MB`.
7. **Fixed-width fields left of the path, and shed right-to-left when the width runs out** — the
   path first (keeping its *tail*, since the file name is the readable part), then the alignment
   padding, then the whole detail. A line must never wrap: an in-place redraw clears one row, so a
   wrapped line strands its overflow on screen.

## Consequences

- **Hashing is reportable, and better than uploading at it.** `fileProps` streams every file over
  5 MB, and an `fs.ReadStream` already maintains `bytesRead`, so it publishes
  `{path, size, startedAt, read}` at no per-chunk cost and with no extra stat — the size comes
  from the `lstat` it already takes. Below that boundary a file is read in one call, with no
  intermediate count and no realistic way to spend a second; the display threshold and the hashing
  strategy are therefore the same constant and cannot drift apart.
- **Two elapsed-time formats, deliberately.** The prose form (`12 min, 21 sec`) stays on the
  retained summary lines, where it reads best in a sentence; the aligned line uses a fixed-width
  form (`12m 21s`) because a field that swings by a factor of five shifts every column after it.
  Letters rather than a clock's colons: `12:21` reads as a time of day, and durations past an hour
  force a roll to `16:39:23` that changes width anyway.
- **The per-file byte bar survives only where nothing else is drawing** (`upload --snapshot`, the
  folder seed). `putFile` reports its bytes to a caller that asks, and draws a bar otherwise —
  cleared on completion, and only for bodies big enough to go up in parts.
- **A caller that reads live state gets a *reader*, never a subscription.** `transfer()` and the
  hash's `read()` are polled by the renderer on its own clock, so the SDK's event rate and the
  disk's chunk size never set the redraw rate.
- **Timing behaviour is not covered by tests.** Both the pacing and the timers rest on real
  elapsed time, and asserting them needs tests that sleep. Verified by simulation and by real
  runs; the reasoning and what would unblock it (a fake clock) are recorded in
  [proposals/output-ux.md](../../proposals/output-ux.md).
