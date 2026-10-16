# The clean-room harness

Built against the format as
[ADR-0107](../docs/adr/0107-the-spec-is-the-public-repository-format.md) scopes it. Running these
clean rooms in CI is [cleanroom-ci.md](cleanroom-ci.md). The fused backup clean room and the
fixtures rework are built: [ADR-0096](../docs/adr/0096-three-implementations-prove-the-format.md)
(amended 2026-10-16) and [scripts/cleanroom/README.md](../scripts/cleanroom/README.md) are the
record. What is left is below.

## The restore clean room

**Decided: two phases, the references shown only in the second.** Today the brief hands the
session s3cab's reference restores and tells it to compare against them — the opposite of the
backup side's "nothing of s3cab's output reaches the room", which exists because a session that
can diff against s3cab converges by imitation and every ambiguity resolved that way vanishes from
its report. But a restorer is also meant to be a working program (ADR-0096's second goal), and
the references are how it finds its own bugs. So both:

1. **Phase 1, no references.** The build leaves `reference/` out of the clean room. The session
   writes the restorer, tests it against the bucket, and writes its guess list.
2. **The harness freezes the report**, copying it out, so the list provably predates any
   reference.
3. **Phase 2, references in.** The harness copies `reference/` in and resumes the same session
   (`claude -p --resume <session-id>`): compare, fix what's yours, and report every difference in
   a separate section — your bug, or a gap in the spec.

The difference section is a result of its own: each entry is a place two careful readers
disagreed, explained while the session still has the context. Its size against phase 1's list
measures how much the references would have hidden. Changes `build-restore-cleanroom.mjs` (build
without `reference/`, then copy it in and resume) and the restore brief; the checks don't change.

Still to decide when it is built:

- What the phase-2 prompt says. Phase 1 starts from a bare `go` with the brief in the system
  prompt; phase 2 has to say that `reference/` is there and what to write. Whether
  `--append-system-prompt-file` must be repeated on `--resume` is unverified.
- What "freezes the report" copies. The brief names no report file, and kept runs show sessions
  choosing `REPORT.md` and `guess-log.md`; a copy of the whole clean room minus credentials
  needs no name.
- A second `--max-budget-usd`, and that the harvested program is phase 2's.

## Open: the readable example

We dropped the idea of the backup program also being easy-to-follow example code (ADR-0096's
2026-10-12 amendment: "proof only, with no readability goal"). Partly that was down to my personal
CLAUDE.md, but most of the complication was probably the exclude pattern matching, which has now
left the spec. So the idea may be back on the table. Let's see what the first fused run produces;
the brief isn't changed to sway it.
