# S3 client request + connection timeouts: fail a dropped connection instead of hanging

**Status:** accepted & implemented. Hardens the data plane established by
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

- **`requestTimeout = 30_000` ms** — a socket **inactivity** limit. Node resets it on any byte
  read or written, so a slow-but-alive transfer never trips it (ADR-0060 shows a healthy
  multipart upload streams continuously); only true silence — a dropped connection — does. The
  resulting `TimeoutError` is a **transient, retryable** error, so the SDK retries it (default
  `maxAttempts`), and a genuinely dead link then surfaces as a real error the CLI prints instead
  of an infinite wait.
- **`connectionTimeout = 10_000` ms** — a cap on establishing the TCP/TLS connection.

Both are passed as a **plain options object** (`{ requestTimeout, connectionTimeout }`), not a
constructed handler: the SDK wraps it in a `NodeHttpHandler` itself, so s3cab needn't take a
direct import on the transitive `@smithy/node-http-handler`.

## The values are reasoned, not measured

Unlike [0060](0060-multipart-tuning-in-flight-bytes.md)'s throughput numbers — which were
measured from three network distances because the value *is* the outcome — these timeouts only
set **how long a dead link waits before erroring**, not throughput. 30 s of total socket silence
mid-transfer already means trouble, so the margin over any real S3 response latency is generous.
There is nothing to benchmark: the goal is "fail instead of hang", and any bounded non-zero value
achieves it. Not user-configurable, for the same reason ADR-0060's knobs aren't
([0006](0006-minimal-code.md)) — revisit only if a real link contradicts it.

## Consequences

- A backup that loses its network now **ends with an error after the SDK's retries**, rather than
  hanging forever. Recovery is unchanged and cheap: re-run the backup — content-addressed uploads
  are idempotent, so already-stored objects are skipped.
- **What is pinned vs tunable.** `src/lib/s3.test.mjs` asserts both timeouts are *set and
  non-zero* — the invariant that must never regress (zero/undefined is the infinite-hang bug) —
  **not** the exact numbers, which stay free to tune without churning a test.
- **Not yet:** a friendlier ADR-0030-style message for the timeout itself (today the SDK's raw
  `TimeoutError` reaches the top-level catch), and the broader network-resilience knobs (retry
  policy, bandwidth limiting, resumability) tracked in
  [proposals/engine-robustness.md](../../proposals/engine-robustness.md).
