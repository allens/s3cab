# Snapshot concurrency lock: the temp file, created atomically; stale locks removed manually

**Status:** accepted

Two concurrent snapshots of the same set are destructive: both target the set's one
fixed-name work file (`.snapshot.tsv.zst` in the set's `snapshots/` directory), and the old
`existsSync` guard was check-then-act — both runs could pass the check, both open the file,
and interleave writes into one corrupt snapshot.

The lock **is** the work file itself, made honest:

- **Acquire** — `open(tmpPath, "wx")`: atomic create-if-absent, enforced by the kernel (the
  `seedStarterExclude` pattern). `EEXIST` → the "already in progress" error.
- **Release on success** — the existing atomic rename that installs the snapshot; the lock
  artifact *becomes* the snapshot.
- **Release on failure** — best-effort `unlink` after the handle is closed (Windows can't
  unlink an open file), so a failed run never wedges the next one.
- **Stale locks** (only a killed/crashed process can leave one) are removed **manually**:
  the error names the exact platform-specific delete command (ADR-0030), gated on "if no
  snapshot or backup of this set is running now" — on POSIX, deleting a *live* run's file
  and re-running lets the old run rename the new run's partial file into place; on Windows
  the open handle blocks the delete outright.

Scope is the **snapshot write path only** (`withSnapshotFile` — covering `snapshot`, and
`backup` through it). `delete` never touches the local store, and `setup --inherit`'s
manifest download already writes per-file atomic temp+rename against a fresh set — locking
them would guard no real failure ([0006](0006-minimal-code.md)).

## Considered options

- **A separate `.lock` file (PID/hostname/start-time content)** — **rejected.** A second
  artifact that can disagree with the work file (one existing without the other is a new
  failure mode), plus new surface in the set directory; everything its content buys is
  liveness probing, rejected below.
- **Age-based auto-break** — **rejected.** A legitimate snapshot can hash a multi-GB file
  for minutes without touching the work file, and total runtime is unbounded — any threshold
  is a guess, and a wrong guess breaks a *live* run's lock: precisely the failure the lock
  exists to prevent. Windows' coarse mtimes make the signal worse.
- **PID-liveness auto-break** — **rejected.** Needs the separate lock file (above) to hold
  the PID, and PID reuse yields false "alive" verdicts.

## Consequences

No new file on the local surface — [guide/format.md](../../guide/format.md) is unchanged. A
crash leaves one leftover file whose error message is its own fix; every other path cleans
up after itself. The lock is per-set (the temp path lives in that set's `snapshots/`), so
snapshots of different sets never contend.
