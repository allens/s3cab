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

## Next: a conformance suite

Files with their expected results, which anyone can run against their own program. Built from the
guesses past reports ranked but the golden set can't settle (a root `DIR`, NUL in a path, a
multi-member gzip, an impossible date, case mapping beyond ASCII), each would be settled once
rather than re-derived by every run. Half of it exists: the golden set, `compare.py` and the
fixtures. With it, clean rooms could be gap-finders only, and whether later real sets need all six
runs is decided once the first set exists to compare against.

## Next: one human cold read before 1.0

Every reader so far is Claude, as was s3cab's author, so a gap they all fill the same way passes
unseen: all five runs of the 2026-10-19 test round chose the same exit codes, none of them from
the spec. One person reading the spec cold would measure how much the model-only evidence
overstates.
