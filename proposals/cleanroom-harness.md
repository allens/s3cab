# The clean-room harness

Built against the format as
[ADR-0107](../docs/adr/0107-the-spec-is-the-public-repository-format.md) scopes it. Running these
clean rooms in CI is [cleanroom-ci.md](cleanroom-ci.md). The fused backup clean room, the
fixtures rework and the two-phase restore are built:
[ADR-0096](../docs/adr/0096-three-implementations-prove-the-format.md) (amended 2026-10-16 and
2026-10-18) and [scripts/cleanroom/README.md](../scripts/cleanroom/README.md) are the record. What
is left is below.

## Open: the readable example

We dropped the idea of the backup program also being easy-to-follow example code (ADR-0096's
2026-10-12 amendment: "proof only, with no readability goal"). Partly that was down to my personal
CLAUDE.md, but most of the complication was probably the exclude pattern matching, which has now
left the spec. So the idea may be back on the table. Let's see what the first fused run produces;
the brief isn't changed to sway it.
