# A clocked line ticks where its caller never yields; the loop turn belongs to the interrupt

**Status:** accepted & implemented. Partly supersedes [0076](0076-one-progress-line-driven-by-a-clock.md)
— its 2026-08-06 claim that a caller "cannot forget a timer it does not own", and its 2026-09-13
assignment of the event-loop concession to the progress line. Adds a consequence to
[0067](0067-park-hashes-on-interrupt.md): its handler needs that concession to be heard.

## Context

0076 put the progress lines on a timer so that a slow stretch could not freeze them, and its
2026-08-06 amendment moved the timer into `countedPass` so that no caller could forget one. Its
2026-09-13 amendment then found that a timer is a macrotask: it fires only when the event loop
turns. The fused pass's stages are `async` functions whose work is synchronous (`lstatSync`,
`readFileSync`, `crypto.hash`), so every `await` is a microtask and the loop never turns. The fix
was a concession in `withProgress`: await `setImmediate` every 100 ms.

**The walk has the same fault, and nothing fixed it.** `walkDirs` is synchronous end to end: a
plain `for…of` over the sync generator `walkFiles`, which calls `readdirSync` per directory. So
`countedPass`'s timer never fired during the walk. The line drew its bare label, then its tally,
and nothing in between, for what is minutes on a large set. That is the freeze the 2026-08-06
amendment was written to end. Verified with a harness that drove the real `countedPass` with a fake
terminal: three seconds of synchronous work drew 2 frames; the same work conceding every 100 ms
drew 4. It hid because the timer's test waited with an awaited sleep, which gave the loop the very
turn the walk never gives.

**The mechanism existed twice, each copy missing what the other had.** `countedPass` had a closing
draw but never got a loop turn. `withProgress` got a loop turn but had no closing draw: its last
frame was whatever the last timer firing happened to show.

**The concession had a second job.** 0067's park handler is JavaScript, so it too runs only on a
loop turn, and so does the second, force-quitting press. A WSL harness sent a real SIGINT one second
into a four-second pass of the same shape (50 µs of synchronous work per item, four runs each).
Without the concession the handler never ran before the pass ended; with it, it ran 0–101 ms after
the signal. 0076's 2026-10-01 amendment noted the double duty, but the concession still lived in the
progress line, where removing it would look like a display change. The walk is not affected:
`walkSet` runs before `writeSnapshot` installs the handler, so a Ctrl+C there is Node's default,
an immediate exit.

## Decision

1. **One clocked line, with two hands.** `lib/progress.mjs` exports
   `clockedLine(stream, compose, { every, opening })`, returning `{ tick(), done(text) }` and
   disposable. It owns `createProgress`, the timer, the off-terminal `due` gate, `tick()` and the
   closing draw. The **timer** serves callers waiting on I/O: the store LIST turns the loop on every
   round trip, and both of `find`'s passes on every read of a snapshot file they stream in, so
   neither calls `tick()`. **`tick()`** serves callers
   whose work is synchronous. It reads `performance.now()` and redraws if the interval is due: one
   clock read and a compare, about 50 ns a call (measured). Both hands stamp one "last drawn"
   moment. `countedPass` is rebuilt on it (label, count and tally, at one second), and
   `withProgress` uses it with `progressLine` at 250 ms. `createProgress` is unchanged for
   `restore` and the per-file upload bar, which push their own text and need no clock.
2. **The walk ticks per entry *visited*, kept or not.** `walkDirs` wraps the callback it builds and
   ticks before delegating, because the callback sees excluded and unsupported entries too, and a
   subtree the walk keeps nothing from is the stall the line exists to report. About 20 ms over
   400,000 entries. One huge directory's single `readdirSync` stays unpreemptable. That is accepted,
   as 0076 accepted the long slurp.
3. **The fused pass ticks after each `yield`**, once the consumer has finished with the path, so
   the count and `currentFile` describe the same file. The line no longer depends on a loop turn.
4. **The loop turn moves to the interrupt.** The 100 ms `setImmediate` concession leaves
   `withProgress` for `propsRows`, just before the `signal.aborted` check whose result it lets
   arrive, and is documented as the interrupt's. The timer can fire on those turns too, but the
   line no longer needs it to.
5. **A closing frame, drawn after the loop**, so only on a pass that ran to the end: the true count
   and bytes, and no detail column, since nothing is in hand. A throw or a stop keeps the last
   ticked frame, which is where the pass got to. `done(text)` takes the text because a closing
   frame need not say what a running one does. Off a terminal it writes nothing, like every other
   frame: `countedPass` writes its own plain tally there, as before, and the fused pass's line
   stays silent off a terminal, as it always was.

## Rejected

- **Conceding the loop in the walk, as the fused pass did.** It would make `walkDirs`, which
  `snapshot`, `tree` and the folder seed all call synchronously, asynchronous for a display. The
  walk has no handler to serve: Ctrl+C there already exits at once.
- **Dropping the concession now that the line no longer needs it.** Ctrl+C would sit unheard until
  the pass ended, which is the strongest form of "it did nothing".
- **Folding the clock into `createProgress`.** It would put two kinds of caller behind one
  interface: pushed text with no clock, and composed text on one.
- **Generalising `countedPass` to carry the fused line.** Its name would stop describing what it
  is.
- **Pushing the count through `tick(count)`.** The count stays pulled, read only when a redraw is
  due, so a tick that is not due costs a clock read and nothing else.
- **A clock seam for the tests.** `mock.timers` does not move `performance.now()` (Node 26.10:
  `"performance"` is not a mockable api), and a `Date.now()` clock is not monotonic. The tick is
  asserted with a short real spin and the timer mocked dead instead.

## Consequences

- **A synchronous caller can forget its tick.** 0076's 2026-08-06 guarantee was that a caller
  cannot forget a timer it does not own. That holds for the timer hand. A synchronous caller now
  owes the line a `tick()`, which it could omit, so the wiring tests are what hold it:
  `walk.progress.test.mjs` counts one tick per visited entry, and `snapshot.progress.test.mjs`
  stubs `clockedLine` to draw on every tick. The cadence and the gate still cannot be forgotten,
  because they stay in the module.
- **0076's 2026-09-13 obligation is restated.** "A progress line driven by a clock is only as live
  as the loop the clock runs on" is now true of the timer hand only. A pass whose work is
  synchronous ticks its line, and a pass that must hear an interrupt concedes the loop where the
  interrupt is read.
- **0076's written limit stands.** A tick between rows cannot preempt one long *synchronous* row,
  and the chunked small-file read stays declined.
- **Most of 0076's untested timing is now asserted.** `progress.test.mjs` asserts both hands: the
  timer with an awaited sleep, `tick()` with a real synchronous spin and the timer mocked dead,
  and the `due` gate on each. The per-file upload bar's pacing is still verified only by hand.
- **The concession is now asserted.** `snapshot-file.test.mjs` sends a real SIGINT at row 10 of a
  200-row pass whose rows block for 5 ms each, and asserts the pass parks well before its end.
  With the concession disabled it fails ("hashed 200 of 200 files"), on the assertion rather than
  by killing the worker, because the test holds a listener of its own. It is **skipped on
  Windows**, where Node ends a process that sends itself SIGINT before any listener runs. A real
  console Ctrl+C reaches the same handler there, but nothing in the suite sends one.
