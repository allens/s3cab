# Test coverage — the upload skip / no-clobber path

**Handoff for a dedicated session.** Scope: everything that decides *whether an object's body gets
sent* — the store LIST, the snapshot-baseline diff, the HEAD preflight, the conditional PUT —
across single vs multipart, and success vs failure vs partial failure.

Surfaced from [PR #203](https://github.com/allens/s3cab/pull/203) (dropping `objectExists`'s
metadata heuristic), which found that the branch it deleted had **no test at all**, and that the
guard underneath it still doesn't. Owner's call (2026-07-16): **concentrate on the real-bucket
suite** — see "Where each case belongs".

## Already covered — don't rebuild

| Behaviour | Where |
| --- | --- |
| First backup LISTs the store; `--since` diffs the local previous snapshot | `test/integration/uploadSnapshot` (real bucket) |
| `putText` `IfNoneMatch` atomicity — first writer wins, second loses (ADR-0024) | `test/integration/set-marker` (real bucket) |
| Backup → restore round trip, incl. real stream teardown (the #171 `ABORT_ERR` class) | `test/integration/backup-restore-roundtrip` |
| Off-AWS / AWS request shaping (SSE, checksum, storage-class); objects carry no metadata | `src/lib/s3.test.mjs` units on `putObjectParams` |
| A non-ASCII local path uploads (the header-encoding trap) | `src/lib/s3.test.mjs`, loopback fake |
| `putFile` ≥ `partSize`, no-clobber, object **present** → skip, **no body on the wire** | `src/lib/s3.test.mjs`, loopback fake (#203) |
| `putFile` ≥ `partSize`, no-clobber, object **absent** → single `PutObject` | `src/lib/s3.test.mjs`, loopback fake (#203) |

So the LIST-based skip and the baseline diff are **not** bare — scope the work to the cases nearer
the wire.

## The gaps

Ranked by what actually matters.

1. **`PreconditionFailed` → `false` is asserted by nothing, anywhere.** `grep PreconditionFailed`
   across every test file returns nothing. This is the guard that makes no-clobber *work* — the one
   that stops a losing racer destroying a snapshot — and it is the whole reason `upload.mjs` can
   raise "Snapshot is already backed up". Untested before #203 and untested after; #203 neither
   caused nor fixed it.
2. **True multipart (> `partSize`) — every variant.** #203's fixture sits *exactly at* `partSize`
   deliberately, which keeps lib-storage on the single-`PutObject` path. So nothing exercises
   Create/UploadPart/Complete at all. Note the 412 fires at **`CompleteMultipartUpload`**, i.e.
   after every part is already uploaded.
3. **Partial failure → abort.** lib-storage defaults `leavePartsOnError = false` and auto-sends
   `AbortMultipartUpload`; `putFile` never sets it, so we inherit that silently. An orphaned-parts
   leak is a *money* bug (incomplete MPUs are billed), not a correctness one — worth a lifecycle-rule
   question alongside the test.
4. **`noClobber: false`** (the `--force` overwrite path) — untested.
5. **A non-`NotFound` HEAD error rethrows** (e.g. `AccessDenied` must not read as "absent" and
   silently re-upload). The `isObjectNotFound` units cover the *predicate*, not the preflight's use
   of it.
6. **Small file (< `partSize`), no-clobber** — no preflight runs; the conditional PUT is the only
   mechanism. Untested.

## Machinery facts — verified 2026-07-16, don't re-derive

Each of these was checked against `node_modules` or the source, and several are counter-intuitive
(two were got wrong first time in the #203 discussion):

- **`IfNoneMatch` *does* reach `CompleteMultipartUpload`.** lib-storage builds
  `uploadCompleteParams = { ...this.params, … }`, and `CompleteMultipartUploadRequest` accepts
  `IfNoneMatch`. So the conditional PUT **is** a real guard for multipart — it just fires after the
  whole body is uploaded, which is why it's a poor optimization and a sound guard.
- **`Upload.MIN_PART_SIZE = 5 MiB`**, and S3 rejects non-final parts below 5 MiB
  (`EntityTooSmall`). This kills the "shrink `partSize` for cheap tests" idea — see below.
- **An exactly-`partSize` body stays on the single-`PutObject` path.** Anything *above* forces real
  multipart choreography, so a fake must then answer Create (XML `UploadId`), UploadPart (ETag),
  Complete (XML), and Abort.
- **`leavePartsOnError` defaults to `false`** (lib-storage line ~203); `putFile` never sets it.
- **The plan loop is strictly sequential** — `for (const [hash, path] of plan) { await putObject(…) }`
  in `upload.mjs`. Relevant to any "just HEAD everything" suggestion (see the standing rejection in
  [architecture-improvements.md](architecture-improvements.md)).
- **`planUpload` already excludes objects it knows are present**, so `putFile` is called almost only
  for genuinely-absent objects. The preflight only pays when the plan is *wrong* (resumed backup
  after a failure; another machine sharing the set).
- **The SDK tags operations with a `?x-id=…` query** (`PUT /bucket/key?x-id=PutObject`) — strip it
  when asserting request paths.
- **An IP endpoint puts the SDK in path-style addressing**, which is what makes the loopback fake
  see `/bucket/key` rather than an unresolvable virtual host.

## Where each case belongs

The split matters — the two harnesses prove different things:

- **Real bucket** (`test/integration/`) — anything asserting **S3's own** behaviour: 412 at
  `Complete`, multipart success, `EntityTooSmall`, abort semantics, orphaned parts. A fake we write
  only proves *lib-storage's* behaviour against our own assumptions. This is ADR-0019's whole point,
  and the #171 lesson is the precedent: every unit test green, integration red.
- **Loopback fake** (`src/lib/s3.test.mjs`, added in #203) — **request-sequence** questions: did the
  body go on the wire, was `Abort` sent, was the preflight skipped below `partSize`. Cheap and
  deterministic. Extend this harness rather than starting a new one.

## Considered and dropped

- **`partSize` as an env var (a test seam).** Tempting — a tiny `partSize` would make multipart
  choreography cheap. But **S3 enforces a 5 MiB minimum part size**, so it cannot help the
  real-bucket suite, which is exactly where this work is meant to concentrate: a real multipart
  upload needs > 5 MiB regardless (~10MB for two parts). It would only help the *fake* — and
  multipart choreography is precisely where a fake's fidelity is least trustworthy. A ~10MB fixture
  costs a few seconds. Not worth a production knob that exists only for tests
  ([ADR-0006](../docs/adr/0006-minimal-code.md)). Owner's read at the time — "a slightly bigger than
  8MB file probably isn't a big issue" — is the right one.

## Open questions for the session

- **Fixture generation.** Today's integration fixtures are tiny strings (`beach …`, `ski …`); a
  ≥ 8MB fixture is new for the suite. Generate per-run vs commit? (Committing 10MB is a non-starter.)
  Where does cleanup live?
- **Test-time cost.** The real-bucket suite is currently ~2.6s wall. Multipart cases add real
  upload time — acceptable, but worth watching the trend rather than discovering it later.
- **Orphaned parts.** If the abort test deliberately fails mid-upload, does the test bucket need an
  `AbortIncompleteMultipartUpload` lifecycle rule so leaked parts don't bill forever? Possibly a
  bucket-policy/onboarding change, not just a test.
