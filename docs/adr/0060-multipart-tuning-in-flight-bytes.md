# Multipart upload tuning: 16 MiB parts × 32 concurrent — bytes *in flight* are the lever

**Status:** accepted & implemented. Tunes the data plane established by
[0059](0059-aws-provisioning-boundary-static-imports.md) (`@aws-sdk/lib-storage` in
`src/lib/s3.mjs`); measured under the real-bucket philosophy of
[0019](0019-s3-test-strategy.md); the benchmark tool is kept ad-hoc per
[0006](0006-minimal-code.md), not promoted to a test tier
([0049](0049-centralize-cross-cutting-test-tiers.md)).

`putFile` uploads through lib-storage's `Upload`. It passed `partSize = 8 MiB` (copied from the
AWS CLI's default `multipart_chunksize`) and — the part nobody noticed — **no `queueSize` at
all**, so every upload ran on lib-storage's default of **4** concurrent parts. Neither number was
ever measured. Both were wrong, and the unset one was wrong by more.

Measured against a real bucket (`eu-west-1`) from three network distances, the old pairing was
**the worst configuration tested on every link** — roughly half the achievable throughput on a
nearby bucket and about a third of it on a moderate-latency one.

## The mechanism: in-flight bytes, then stream count

The lever is **bytes in flight** = `partSize × queueSize` — how much data is on the wire at
once. To saturate a link, that has to cover its **bandwidth-delay product** (throughput ×
round-trip time). Below it the pipe is never full and throughput is latency-bound, however fast
the line is.

Two findings sharpen this, both counter to the intuition we started with:

1. **At equal in-flight, more parallel streams win.** Splitting the same 537 MiB into 32 streams
   of 16 MiB beat 16 streams of 33 MiB (92 vs 85 MB/s local; the same ordering held at every
   distance). Each TCP flow is individually RTT-limited, so aggregate throughput scales with the
   *number* of flows. `queueSize` — not `partSize` — is what sets that count. We initially
   predicted the opposite (that high latency would favour *bigger* parts); the data overruled it.
2. **More in-flight stops helping, then hurts.** Past ~512 MiB the curve turns over: 1.1 GiB in
   flight measured *slower* than 537 MiB (86 vs 92 MB/s local). So this is a peak to find, not a
   quantity to maximize — which is what makes a fixed default defensible.

## The measurements

`scripts/multipart-bench.mjs` (kept — see below). Payload 1 GiB unless noted, median of
interleaved rounds, same bucket throughout.

**Local — UK → `eu-west-1`, ~865 Mbit/s upload, low RTT:**

| partSize × queueSize | in flight | MB/s |
| --- | --- | --- |
| **16 MiB × 32** | 537 MiB | **92** |
| 33 MiB × 32 | 1.1 GiB | 86 |
| 33 MiB × 16 | 537 MiB | 85 |
| 16 MiB × 16 | 268 MiB | 81 |
| 8 MiB × 4 *(the old default)* | 32 MiB | **44** |

92 MB/s is ~85% of line rate; the remainder is protocol/TLS overhead, not reachable by these
knobs (every attempt to push past it measured worse).

**Moderate latency — VPN via New York, 512 MiB payload.** The realistic proxy: a user whose
single-stream upload is RTT-limited but who has real capacity underneath.

| partSize × queueSize | in flight | MB/s |
| --- | --- | --- |
| **16 MiB × 32** | 537 MiB | **33.9** |
| 16 MiB × 16 | 268 MiB | 30.9 |
| 8 MiB × 16 | 134 MiB | 29.7 |
| 8 MiB × 4 *(the old default)* | 32 MiB | **12.7** |

**Extreme latency — VPN UK → Australia → `eu-west-1`, ~600 ms RTT.** Recorded because it proves
the mechanism, **not** used to pick the default (see "What we deliberately did not tune for").
Single-stream speedtest on this path reported 4.2 Mbit/s up; 64 parallel parts moved 332 Mbit/s —
an ~80× parallelism win, the bandwidth-delay product in its purest form.

## Two measurement traps (both cost us a wrong conclusion)

Recorded because each produced a *confident, wrong* answer before it was caught:

- **A payload smaller than the target in-flight silently caps the experiment.** In-flight can
  never exceed the file, and `parts = ceil(payload ÷ partSize)` caps concurrency at the part
  count. On a 256 MiB payload, `16 MiB × 32` and `16 MiB × 16` are the *same execution* (only 16
  parts exist) and measured identically — we briefly read that as "32 streams don't help."
- **A payload too small to clear TCP slow-start under-measures a high-latency link.** At 256 MiB
  the far link looked capped at ~16 MB/s; at 1 GiB the same settings reached 41 MB/s. The
  transfer had been finishing while the congestion window was still opening. We had already
  written off that ceiling as the VPN's limit — it was an artifact.

Method consequences, now baked into the script: interleave one sample of every config per round
(reshuffled) so network drift is shared rather than blamed on whichever config ran during a dip;
report **median plus min–max spread**, never best-of-N (which just rewards the config that ran in
the quietest window); size the payload above both the largest in-flight under test and the
slow-start ramp.

## Decision

**`partSize = 16 MiB`, `queueSize = 32`** — 512 MiB in flight, at the measured peak.

- **16 MiB is the right part size**, and it also **halves the request count** versus 8 MiB (64
  `UploadPart` calls per GiB instead of 128) — a direct cost saving for users, since S3 bills per
  request. 8 MiB × 32 measured within noise of 16 MiB × 32 at double the requests; 32 MiB was
  slower at equal memory.
- **`queueSize = 32` is the headline change.** The old code passed none, silently accepting 4.

**Both self-scale down, so small files pay nothing.** Concurrency is `min(queueSize, partCount)`
and buffered bytes never exceed the file. A 50 MiB file is 4 parts → 4 streams → ~50 MiB
buffered; the deep queue simply cannot engage. The 512 MiB peak is reached only by files ≥512
MiB — precisely when the throughput is worth it. Files under 16 MiB now go as a single
`PutObject` (previously 8–16 MiB files were multipart), dropping the create/complete round trips
entirely.

## Consequences

- **Memory:** up to 512 MiB buffered per upload, on large files only. Acceptable because uploads
  are sequential — one file at a time, so one buffer, not N — on the project's modern-consumer-PC
  assumption. 1 GiB in flight was explicitly rejected: it doubles memory *and* measured slower.
- **The no-clobber preflight threshold moves with `partSize`** (`size >= partSize`), so the HEAD
  now fires at 16 MiB rather than 8 MiB. Fewer preflights; the conditional PUT remains the real
  guard.
- **Not user-configurable.** No flag, no env knob — a measured default with no evidence of a
  second regime worth exposing ([0006](0006-minimal-code.md)). Revisit if a real user's link
  contradicts the curve.

## What we deliberately did not tune for

**Distant buckets.** The expectation is that a user puts the bucket in a region *near them*; the
Australia path was a diagnostic, not a target. Tuning for ~600 ms RTT would have pushed toward
1 GiB in flight, which is worse for everyone else. **The realistic constraint we did honour** is a
sensibly-configured user with a *modest upload* — the local link's 865 Mbit/s up is unusually
fast and asymmetric-fibre users have far less, which is why the New York numbers, not the local
ones, drove the choice. Below roughly fibre-to-the-node, cloud backup is the wrong tool and no
tuning rescues it.

## The benchmark stays an ad-hoc script

`scripts/multipart-bench.mjs` is kept, documented in `scripts/README.md`, run by hand — **not**
wired to an npm script or a test tier. It asserts nothing, has no pass/fail, spends real money on
S3, and needs a human to read it: it is an experiment, like `scripts/zstd-bench.mjs`, and the
`test:*` namespace means "correctness, with a verdict". A `test:perf`/`bench:*` suite was
considered and rejected ([0006](0006-minimal-code.md)) — the `--env-file` and tunable-env
ergonomics mean an npm alias would save nothing.

Because throughput is unobservable in a unit test, `src/lib/s3.multipart-tuning.test.mjs` pins the
decision where it *is* cheap — the arguments `putFile` hands the uploader — so that deleting
`queueSize` fails a test instead of silently halving throughput. `partSize` is additionally
pinned behaviourally by the loopback suite in `s3.test.mjs`, whose fixtures are cut from the same
constant.
