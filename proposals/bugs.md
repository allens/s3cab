# Bugs / correctness suspicions

> **Interim home — must reach zero before release.** Bugs belong in **GitHub Issues**, but the
> repo won't use Issues until pre-release. So this file is the stop-gap tracker in the
> meantime. It is the **one file in `proposals/` that should be gone by release** — i.e. *no
> known bugs* at ship. After that, file bugs as GitHub Issues, not here.

Some of these are unverified suspicions — **check before believing.**

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
