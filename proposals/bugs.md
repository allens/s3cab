# Bugs / correctness suspicions

> **Interim home — must reach zero before release.** Bugs belong in **GitHub Issues**, but the
> repo won't use Issues until pre-release. So this file is the stop-gap tracker in the
> meantime. It is the **one file in `proposals/` that should be gone by release** — i.e. *no
> known bugs* at ship. After that, file bugs as GitHub Issues, not here.

Some of these are unverified suspicions — **check before believing.**

- **An unsupported file type is double-recorded** — both `#EXCLUDED` *and* `#ERROR`. In
  `walk.mjs`'s `createWalkCallbackFn`, a dirent that is neither a regular file nor a directory
  (socket, FIFO, device, symlink) is pushed onto `excluded` as `"Unsupported file type"` but
  then falls through to `return path`, so it also enters `files` → the props pipeline →
  `prop` throws `"Not a regular file"` → an `#ERROR` row. So the same path appears as both
  skipped *and* errored, and `compare` reports it under **errors** when it isn't one — it's
  just not backupable, so `#EXCLUDED`-only is the right category. Minimal fix: `return null`
  in that branch (drops it from `files`). Note the deeper inconsistency: the callback only
  runs **when patterns exist**, so *without* a pattern list these types flow straight to
  `#ERROR` with no `#EXCLUDED` record at all — a correct fix must decide whether unsupported
  types are filtered regardless of patterns. Testing is awkward on Windows (no `mkfifo`,
  symlinks need privilege); likely a Linux-gated test like the S3 suite. (Surfaced 2026-06-23
  during the snapshot-writer deepening refactor, which deliberately *preserved* this behaviour
  to stay structural — see the deleted candidate 1 of `architecture-deepening.md`.)
- **`readSnapshotFile` trims every field**, so a path with leading/trailing whitespace doesn't
  round-trip. Only the padding columns need trimming; the path field should be taken verbatim.
  Related: a blank line in a hand-edited snapshot file dies on a bare `assert` — hand-editing
  is the whole no-lock-in story, so parse errors deserve friendly messages with file/line
  context.
- **`withSnapshotFile` closes the fd twice** (`await fd.close()` inside an `await using`);
  `putFile`'s skip path (`PreconditionFailed`) returns without terminating the stderr progress
  line.
- **`formatByteValue` hardcodes locale `"en"`** while `DurationFormat` uses the system default;
  pick one.
