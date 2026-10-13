# The format spec holds rules, recommendations and hints; a row file is valid or canonical

**Status:** accepted & implemented (2026-10-13), in [guide/format.md](../../guide/format.md)
and the clean-room brief. Completes the split #397 began, which separated what a reader
relies on from how s3cab lays the file out but left the heading row on both sides and gave
hints to restorers only.

Clean-room runs report three different things in one ranked list: real gaps in the rules,
guesses about layout no reader depends on, and traps in a language or OS (`\\?\` on Windows,
Python's `str.splitlines()` and `str.strip()`). A person writing their own snapshot, upload or
restore from the spec needs all three as much as a clean room does, so the answer is not to drop
any of them but to say which is which.

## Decision

### Three kinds of content, named once at the top of format.md

- **Rules**, in a checklist per job: reading, writing a snapshot, uploading, deleting. A rule
  is whatever is in a checklist. Break one and another tool misreads the file or loses data.
- **Recommendations**: what makes a valid row file canonical (below). Another writer should
  match them; no reader depends on them.
- **Hints**, a "what trips you up" list per role: the traps a platform or library sets when it
  meets a fact the rules state. Never a requirement, so the list can grow without making the
  spec harder to meet.

The rest of the page stays prose, explaining the checklists.

Not RFC 2119's MUST/SHOULD/MAY: the capitals don't suit
[0012](0012-consumer-vocabulary-naming.md)'s casual but technical reader, and once some sentences
carry a keyword, every sentence without one raises the question of whether it is a rule. Not
conformance levels: a partial reader is a dangerous one, since skipping the refusal rules is how
a hand-added `..` walks out of the output directory, and the only real second grade is the row
files' layout.

### Valid and canonical, for the two row files

The snapshot and the deletion record share the row layout
([0102](0102-deletion-record-takes-the-snapshot-layout.md)), and only they have a second grade:

- **Valid**: meets the rules. Every reader handles it correctly.
- **Canonical**: valid, and laid out exactly as s3cab writes it: the padding and its widths,
  counted in code points as exclude.md's `?` is, the unpadded column 1, `SIZE`'s readable form. The word is a formatter's (gofmt's canonical format)
  and a canonicalization spec's: one byte form for given content.

**The layout is a function of the rows**, defined fully enough to compute: given the rows,
there is exactly one canonical file. So writing it is arithmetic rather than a guess, and
re-laying-out a valid file never changes what it means.

**The values written for people are content, not layout**: `VERSION`, `HOME`, `BY`,
`START`'s zone and an `#error` row's wording. No reader reads them and no layout derives them, so
they are free text, outside both grades.

**The heading row's exact text is a rule.** s3cab's reader compares all five fields, padding
aside, and the reader's checklist spells them out.

`info`, `dirs.txt` and the bucket layout have only rules.

### A clean-room report splits its findings the same way

- A missing or unclear **rule** is a spec defect, ranked as now.
- A missing **hint** goes in a separate list, "hints that would have helped": harvested like the
  rest, ranked apart.
- A guess about a **recommendation**, or a file that is valid but not canonical, is not reported.
  The checker notes it; an invalid file is the checker's mismatch.

## Consequences

- format.md's checklists sit together under "Writing your own tool", each followed by its
  hints; deleting gets one because the grace window and the record-before-delete ordering are
  rules too, though no clean room plays that part.
- s3cab pads by UTF-16 units, so its own files are non-canonical where column 2 holds an
  emoji, until `formatLine` counts code points.
- `compare-snapshot.mjs`'s mismatch-or-note split draws the valid/canonical line.
