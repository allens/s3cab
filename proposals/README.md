# proposals/

A bucket for **ideas we might do** — anything from a rough thought or a one-line comment up
to a detailed design doc, from important stuff down to pipe dreams. Capture it here and point
an AI assistant (or a teammate) at it. Nothing in here is committed to or of record.

Ideas are grouped into **theme-based files** ("epics") — e.g. `output-ux.md`,
`snapshot-format.md`, `performance.md` — each holding related items of whatever size. A story
can be a one-liner or a worked-out design, and can be split finer as it gets closer to being
done. Anything that doesn't fit a theme yet lives in [misc.md](misc.md). One special file,
[bugs.md](bugs.md), is the interim defect tracker until the repo moves bugs to GitHub Issues —
it should reach zero before release.

Another special file, [architecture-improvements.md](architecture-improvements.md), is the
durable capture of `/improve-codebase-architecture` runs (open candidates, standing
rejections, run log — the skill is costly, so nothing it finds lives only in chat). The
latest run's visual report sits beside it as
[architecture-review.html](architecture-review.html), **latest only** — each run replaces it;
superseded reports go stale fast and git history keeps them.

An idea leaves this directory one of two ways, and either way the entry is deleted:

- **Implemented** — its lasting knowledge moves to its real home first (a decision to an
  [ADR](../docs/adr/), a subsystem design to [docs/design/](../docs/design/), user docs to
  [guide/](../guide/)), then the proposal is removed.
- **Abandoned** — just removed.

Git history preserves anything deleted, so nothing is truly lost.

> This is really a lightweight, in-repo backlog / issue tracker. Longer term it may move to
> **GitHub Issues** (which the repo already uses as its tracker — see
> [docs/agents/issue-tracker.md](../docs/agents/issue-tracker.md)); kept as files for now.
