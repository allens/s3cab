# Storage-backend capability contract

The model-based suite runs the same invariants against more than one storage
backend (the Tier 1 in-memory fake, the Tier 2 real-AWS bucket). Backends
differ in what they truthfully model, and the honest way to handle that is
**declaration and skip, never assumption**: each backend exposes a
`capabilities` set, a test that depends on a behaviour names it, and a backend
that doesn't declare it skips the test rather than passing it vacuously.

This file is the vocabulary — the real compatibility contract between s3cab
and a storage provider. A provider (or fake) that claims a capability must
exhibit the behaviour described here; a test may rely on exactly what the
capability promises and nothing more.

**The prime rule for fakes: declare only what you truly model.** An optimistic
fake that claims what it fakes poorly is how a suite passes against broken
code. The fake's set is `FAKE_CAPABILITIES` in
[harness/fake-s3.mjs](harness/fake-s3.mjs).

## Capabilities

### `conditional-put`

`PutObject` with `If-None-Match: *` fails (412 `PreconditionFailed`) when the
key already exists, **atomically** — there is no window in which two
concurrent conditional PUTs of the same key can both succeed. s3cab's
`putText(..., { noClobber })` maps the 412 to a `false` return.

- Fake: **yes** (a synchronous map check is trivially atomic).
- Real S3: **yes** (native `If-None-Match` support, GA since 2024).
- A provider without it cannot safely support multi-writer sets; tests of
  claim/no-clobber semantics require this capability.

### `strong-consistency`

A read (GET, HEAD, LIST) issued after a successful write observes that write.
No eventual-consistency window, no stale LIST.

- Fake: **yes**. Real S3: **yes** (strong read-after-write since 2020).
- The model's reconcile step (observe the store after every op) is only sound
  under this capability; a backend without it cannot run the sequence tier.

### `list-last-modified`

LIST reports a `LastModified` per object that measures real elapsed time since
the object landed — the input to `cleanup`'s 7-day grace window.

- Fake: **yes**, with a twist: objects are stamped with the *virtual* clock at
  PUT and LIST reports `real now − virtual age`, so grace-window behaviour is
  testable without waiting seven days.
- Real S3: **yes**, but the clock is the real one — age-dependent tests
  (grace-window expiry) cannot run in one sitting there; that is Tier 3's
  written procedure, not a skipped assertion.

### `virtual-clock`

Object ages and snapshot names can be steered by the harness clock
(`clockHolder`). **Fake-only by construction** — it exists so Tier 1 can cross
the grace window in microseconds. Any test that advances time past minutes
requires this capability; on a real backend it must skip (or live in Tier 3).

### `fault-injection`

The backend executes a planned per-request fault (fail-before, fail-after,
duplicate, truncated body) exactly where the plan says. **Fake-only.** Real
throttling and network faults exist in Tier 2, but they cannot be aimed;
tests that assert recovery from a *specific* injected fault require this.

Why the fault vocabulary has no 503/500/timeout shapes: the SDK retry relay
(ADR-0068) lives **below** the s3.mjs seam, so every retryable status is
absorbed before it could cross it. What code above the seam can observe is
exactly what the fake injects — a request that failed (shape-independent: the
only errors branched on by name up there are NoSuchKey/NotFound/
PreconditionFailed, which the fake throws for real), succeeded twice, or
returned truncated bytes. Injecting a 503 above the relay would test a code
path that cannot occur; testing the relay itself needs real throttling
(Tier 2's capability below).

### `inspection`

The harness can enumerate keys and read raw bytes out-of-band (`listAll`,
`getBytes`, `putBytes`, `deleteKey`) to check store invariants and craft
hostile store states. The fake implements it in-memory; the Tier 2 backend
implements the same surface over the SDK (without `virtualMs`, which is a
fake-only extra riding on `virtual-clock`).

### `versioning`

The bucket retains noncurrent object versions; DELETE writes a delete marker
rather than erasing bytes. s3cab never *checks* this (a known gap — see
proposals/bugs.md), so the capability gates tests of what versioning does to
s3cab's view: delete markers in LIST, `objectExists` on a marker, restore of
an overwritten-then-deleted key.

- Fake: **no** (unversioned hard delete, deliberately).
- Tier 2 bucket (`test-s3cab-<owner>-conformance`): **yes** — the conformance
  provisioning convention creates it versioned, with `s3:PutBucketVersioning`
  denied so a test cannot un-version it.

### `multipart`

Uploads above the part size go through real multipart mechanics
(CreateMultipartUpload / UploadPart / Complete), producing multipart ETags
(`…-N`) and multipart failure modes (orphaned parts on abort).

- Fake: **no** — it stores every body whole; Tier 1's >16 MB test only proves
  the seam streams the bytes faithfully.
- Real S3: **yes**; Tier 2 owns ETag-shape and abort behaviour.

### `list-pagination`

LIST truncates (S3: at 1000 keys) and requires continuation tokens; a correct
client must iterate. The fake returns everything in one page, so pagination
bugs are invisible in Tier 1 — Tier 2's >1000-key case requires this.

### `throttling`

The backend may return real 503 SlowDown / RequestTimeout under load, which
the SDK retry relay *below* the s3.mjs seam absorbs. The fake injects faults
*above* the relay instead (deterministic, but a different code path). Tests of
the real retry pipeline require this capability and live in Tier 2.

### `lifecycle-expiry`

Bucket lifecycle rules expire noncurrent versions on a wall-clock schedule
(days). No backend can compress that into a test run — this capability is
never declared; it exists in the vocabulary because Tier 3's procedure
([tier3-procedure.md](tier3-procedure.md)) is its only exercise.

## Declared sets

| Capability          | Tier 1 fake | Tier 2 real AWS |
| ------------------- | ----------- | --------------- |
| `conditional-put`   | ✔           | ✔               |
| `strong-consistency`| ✔           | ✔               |
| `list-last-modified`| ✔           | ✔               |
| `virtual-clock`     | ✔           | —               |
| `fault-injection`   | ✔           | —               |
| `inspection`        | ✔           | ✔               |
| `versioning`        | —           | ✔               |
| `multipart`         | —           | ✔               |
| `list-pagination`   | —           | ✔               |
| `throttling`        | —           | ✔               |
| `lifecycle-expiry`  | —           | — (Tier 3 only) |

## How a test declares

A test names what it needs and skips when the current backend lacks it:

```js
if (!backend.capabilities.has("versioning")) {
  t.skip("backend does not declare versioning");
  return;
}
```

The skip is the honest outcome: it reports "this behaviour is untested against
this backend" instead of silently passing. A test that would pass identically
with and without the capability shouldn't declare it.
