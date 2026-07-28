# S3 client request + connection timeouts: fail a dropped connection instead of hanging

**Status:** accepted & implemented — **corrected 2026-07-28**, when the original option choice
turned out not to work at all (see the Correction under Decision). Hardens the data plane
established by
[0059](0059-aws-provisioning-boundary-static-imports.md) and tuned by
[0060](0060-multipart-tuning-in-flight-bytes.md) (the `@aws-sdk/client-s3` client in
`src/lib/s3.mjs`); the plain-options form keeps the transitive handler off the dependency list
([0005](0005-builtins-over-dependencies.md)).

## Context

`clientConfig()` built the S3 client with **no `requestHandler`**, so every request ran on the
SDK's default Node handler — which sets **no socket timeout**. A real backup lost its network
mid-upload and the process **froze indefinitely**: the multipart `Upload` was parked on a
half-open TCP connection with nothing to break the wait, the progress bar stopped at the last
completed part, and no error was ever raised. The only recovery was to kill the process by hand.

Expiring credentials, by contrast, are already handled (the `credentialErrorRelay`,
[ADR-0037](0037-request-time-credential-error-translation.md)) — this is the *other* silent
failure mode on the S3 path, and the one with no feedback at all.

## Decision

Set a `requestHandler` on the S3 client with two timeouts:

- **`socketTimeout = 30_000` ms** — a socket **inactivity** limit. Node resets it on any byte
  read or written, so a slow-but-alive transfer never trips it (ADR-0060 shows a healthy
  multipart upload streams continuously); only true silence — a dropped connection — does. It
  **destroys the request** and raises a `TimeoutError`, a **transient, retryable** error, so the
  SDK retries it (default `maxAttempts`), and a genuinely dead link then surfaces as a real error
  the CLI prints instead of an infinite wait.
- **`connectionTimeout = 10_000` ms** — a cap on establishing the TCP/TLS connection.

Both are passed as a **plain options object** (`{ socketTimeout, connectionTimeout }`), not a
constructed handler: the SDK wraps it in a `NodeHttpHandler` itself, so s3cab needn't take a
direct import on the transitive `@smithy/node-http-handler`.

### Correction (2026-07-28): it must be `socketTimeout`, never `requestTimeout`

**This ADR originally specified `requestTimeout = 30_000`, described as the inactivity limit
above. That was wrong, and the fix it claimed never worked** — the hang it was written to kill
was still fully live. `@smithy/node-http-handler` has *three* separate options, and the one we
picked was neither an idle timeout nor, by default, fatal:

| Option | What it actually does |
| --- | --- |
| `socketTimeout` | Idle limit. Destroys the request, rejects with `TimeoutError`. **What we want.** |
| `requestTimeout` | Cap on **total** request duration. **Logs a warning and lets the request continue** unless `throwOnRequestTimeout` is also set. |
| `connectionTimeout` | Connect phase only. |

Upstream names the trap in its own type docs: *"because `requestTimeout` was for a long time
incorrectly being set as a socket idle timeout, users must also opt-in for request timeout thrown
errors"* (`@smithy/types`, `NodeHttpHandlerOptions`). It once *was* the idle timeout; the rename
left the old name meaning something else.

Two symptoms, both real and both observed:

1. **The hang was never fixed.** Nothing set `socketTimeout`, so no idle timeout existed at all;
   `requestTimeout` only warned. A half-open connection still parked forever — exactly the
   Context above.
2. **Noise on healthy transfers.** Because it caps *total* duration, any object legitimately
   taking over 30 s on a slow uplink logged
   `@smithy/node-http-handler - [WARN] a request has exceeded the configured 30000 ms
   requestTimeout` straight to the console, mid-backup, past s3cab's own output discipline
   (ADR-0010).

**`throwOnRequestTimeout: true` is rejected as the fix**: it would make symptom 2 fatal, failing
a perfectly healthy large upload for the crime of being slow — the opposite of the goal. Only
`socketTimeout` distinguishes "slow" from "dead", which is the whole distinction this ADR exists
to draw.

## The values are reasoned, not measured

Unlike [0060](0060-multipart-tuning-in-flight-bytes.md)'s throughput numbers — which were
measured from three network distances because the value *is* the outcome — these timeouts only
set **how long a dead link waits before erroring**, not throughput. 30 s of total socket silence
mid-transfer already means trouble, so the margin over any real S3 response latency is generous.
There is nothing to benchmark: the goal is "fail instead of hang", and any bounded non-zero value
achieves it — **provided it is on the right option**, which is where this first went wrong.
Not user-configurable, for the same reason ADR-0060's knobs aren't
([0006](0006-minimal-code.md)) — revisit only if a real link contradicts it.

## Consequences

- A backup that loses its network now **ends with an error after the SDK's retries**, rather than
  hanging forever. Recovery is unchanged and cheap: re-run the backup — content-addressed uploads
  are idempotent, so already-stored objects are skipped.
- **What is pinned vs tunable — and _how_.** `src/lib/s3.test.mjs` pins the behaviour, not the
  numbers: it points the real client at a loopback server that accepts a request and then goes
  silent, and asserts a `TimeoutError` arrives instead of a hang. It builds that client from
  `clientConfig()`'s own handler **keys**, shortening only the durations, so reverting to
  `requestTimeout` fails the test rather than a user's backup. The exact numbers stay free to
  tune without churning it.
  - The suite previously asserted only that both timeouts were *set and non-zero* — which is
    **how the `requestTimeout` bug shipped green**. `requestTimeout` was non-zero throughout and
    never broke a single hang. A value-shaped assertion cannot notice that an option's *meaning*
    changed underneath it; only exercising the failure can. Worth remembering the next time a
    config invariant looks too simple to be worth a real test.
- **Not yet:** a friendlier ADR-0030-style message for the timeout itself (today the SDK's raw
  `TimeoutError` reaches the top-level catch), and the broader network-resilience knobs (retry
  policy, bandwidth limiting, resumability) tracked in
  [proposals/engine-robustness.md](../../proposals/engine-robustness.md).
