# Transport failures are retried above the AWS SDK, on a time window

**Status:** accepted & implemented. Completes the two "Not yet" items left open by
[0065](0065-s3-client-request-timeouts.md) — the friendly message for a dead link, and a retry
policy that actually survives one. Extends the relay built by
[0037](0037-aws-auth-error-categorization.md) and works within the multipart concurrency chosen
by [0060](0060-multipart-tuning-in-flight-bytes.md).

## Context

[0065](0065-s3-client-request-timeouts.md) stopped a dropped network from hanging forever: the
socket timeout turns silence into a retryable `TimeoutError`, and it said "the SDK retries it
(default `maxAttempts`), and a genuinely dead link then surfaces as a real error". **That second
half was never true in any useful sense.** A real backup died when a VPN was switched on
mid-upload, and it died in **under a fifth of a second**.

Two separate defects, found together:

1. **The error printed as a bare `ERROR:` with nothing after it.** Node's happy-eyeballs connect
   wraps the per-address failures in an `AggregateError` whose `.message` is **empty** — the
   detail lives only in `.errors`. S3 endpoints resolve to several addresses, so this is the
   *normal* shape of "the network went away", and the top-level catch printed its `message`.
2. **The retries were over before a network transition could possibly finish.** The SDK sleeps
   `random() × min(100ms × 2ⁿ, 20s)` between attempts, so its default 3 attempts spend **at most
   300 ms** in total.

Raising `maxAttempts` looks like the fix and **is not**, which is the finding that shaped this
decision. The SDK's retry budget is a **token bucket on the client** — 500 tokens, 10 per
transient retry — *shared by every request in flight*. The more parts a large file has in the
air, the sooner they all stop retrying. Measured against a loopback server that never answers,
one client, all requests failing:

| Parts in flight | Approx. file size | Attempts per part (cap 8) | File dies after |
| --- | --- | --- | --- |
| 1 | ≤ 16 MB | 8.0 | **9.0 s** |
| 4 | ≤ 64 MB | 8.0 | 3.0 s |
| 8 | ≤ 128 MB | 7.3 | 2.4 s |
| 16 | ≤ 256 MB | 4.1 | 0.4 s |
| 32 | ≥ 512 MB | 2.6 | **0.18 s** |

At 32 concurrent requests the client makes **the same 82 attempts whether `maxAttempts` is 3 or
8** — the bucket binds first, so the setting is inert exactly where it is needed most. "File dies
after" is when the *first* part gives up, because one failed part aborts the whole multipart
upload. With ADR-0060's `queueSize` of 32, every file over ~512 MB gets ~0.2 s of tolerance.

**No built-in configuration escapes this.** `ConfiguredRetryStrategy` extends
`StandardRetryStrategy` and inherits the bucket; `AdaptiveRetryStrategy` delegates to one *and*
adds client-side rate limiting; `AWS_MAX_ATTEMPTS` / `AWS_RETRY_MODE` feed the same accounting;
and `INITIAL_RETRY_TOKENS = 500` is a hard-coded `@smithy/core` constant.

## Decision

**s3cab retries transport failures itself, above the SDK, bounded by a time window rather than an
attempt count.** The relay from [0037](0037-aws-auth-error-categorization.md) — already mounted
at the middleware stack's `initialize` step, *outside* the SDK's own retry middleware at
`finalizeRequest` — becomes a retry loop around `next(args)`.

- **Window: 120 s per request.** Time, not attempts, because the goal is time-shaped: leave a
  backup running unattended and let it survive the wifi dropping for a few seconds.
- **Backoff: exponential, full jitter, capped at 2 s.** Full jitter staggers the parts that all
  failed in the same instant so they don't stampede the link when it returns. The cap is what
  bounds **recovery** latency — a sleeping request cannot notice the network is back until it
  wakes, and a 10 s cap made a 3 s outage take 12 s to recover from (measured in the spike).
- **Transport errors only**, matched on the errno (`isNetworkError`). Throttling and 5xx never
  match, so they keep **stock SDK behaviour, deliberately**.
- **Never retries a stream body.** Retrying a consumed stream would PUT a *truncated* object
  under the correct hash — silent corruption, worse than a failed backup. The SDK holds this
  invariant internally (`isStreamingPayload`); retrying outside it must hold it too.
- **A friendly message** ([0030](0030-error-message-guidelines.md)) when the window does close,
  and `errorText` so a message-less error can never print as a blank line again.

### Why the `initialize` step, and not a custom `RetryStrategyV2`

`retryStrategy` *is* a public client config field, and implementing the three-method interface
would also work. The relay is chosen because it is **smaller** (it extends code 0037 already
put there rather than owning an SDK interface across major versions) and because each pass
re-runs serialization and signing and takes a **fresh retry token**, so a client whose budget is
spent still gets attempts. Re-signing per pass is a bonus: a retry minutes later carries a
current date rather than a stale one.

Retrying at the **request** level is the point. The obvious alternative — a retry loop in s3cab
around `putFile` — would restart a 14 GB upload from zero; this resumes the 16 MB part that
failed.

### Why the SDK's budget is kept for throttling and 5xx

The token bucket is **not a bug**. It is a circuit breaker protecting the *service* from retry
storms, and for `SlowDown`/503 that is exactly right — s3cab should back off politely when S3 is
struggling. It is wrong only for a failure that is *our own link*, where backing off globally
helps nobody. That split is the whole reason the retry is keyed on `isNetworkError` rather than
on the SDK's broader "transient" classification.

## Consequences

- A backup **survives a wifi drop, a VPN coming up, or a laptop waking**, at any file size.
  Verified against a fake S3 on loopback that is dead for 3 s: 32 concurrent PUTs all complete,
  and a real `lib-storage` multipart upload (200 MB, 40 parts, 32 in flight) completes.
- **A genuinely dead link now takes up to 2 minutes to report**, where it used to take under a
  second. That is the deliberate trade: for an unattended backup, waiting beats abandoning the
  run.
- **The progress bar would otherwise sit frozen for that whole window**, reading as a hang. It
  now says so instead: `lib/network-status.mjs` reports the wait on stderr and its recovery
  (`Connection lost — waiting for the network to come back (up to 2 minutes)…`, then
  `Back online after 14 sec — continuing.`), written through `progress.mjs`'s `statusLine` so it
  lands *over* the frozen bar rather than appending to its un-terminated line. Three decisions
  worth keeping: it is **one message per outage, not per request** (a dropped link fails all
  `queueSize` parts at once, so per-request output would arrive 32 times over — clig.dev's
  signal-to-noise rule), which is why that module reference-counts rather than printing from the
  relay; it **waits for the second retry**, so a blip that clears inside one backoff stays quiet;
  and it is **static text, not a ticking counter** — naming the window sets the expectation that
  stops it reading as a hang, without a timer whose lifetime would have to be managed on the
  failure path.
- **`maxAttempts` is deliberately left at the SDK default.** Raising it was tried, measured to be
  inert under concurrency, and reverted rather than shipped — a knob that appears to harden the
  hot path while doing nothing for the files that matter is worse than no knob.
- **The middleware signature is a trap worth remembering.** The SDK invokes a middleware as
  `middleware(next, context)`. A first cut took the window as an optional *second* parameter, so
  it silently received the context object, the deadline became `NaN`, and **nothing retried at
  all** — in production as well as in tests. The relay is therefore curried on the window
  *before* `next`. It was the end-to-end loopback test, not the unit tests, that caught this;
  the same lesson as 0065's "a value-shaped assertion cannot notice that meaning changed".
