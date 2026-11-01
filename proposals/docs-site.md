# Documentation site & docs UX

Epic: make the docs site professional, pleasant to use, and a bit of fun — without giving up
what the docs already do well (honest, plain-language, example-led prose). From a docs deep dive
on 2026-10-09. The site itself is built and live at https://s3cab.plantegral.com: how it is built
and served, and who owns what, is [ADR-0114](../docs/adr/0114-docs-site-cloudflare-pages.md).

**Constraints any of this must keep** (CLAUDE.md): `/guide/<topic>` URLs are frozen into shipped
binaries, so `guide/*.md` keep their names and the site serves exactly those paths; `guide/` ships
in the npm tarball, so every page must stay readable as raw GitHub-flavoured markdown; the
help-vs-guide placement doctrine stands (terminal help is mid-task, the site is the sit-down
read).

## Ordered by payoff

- **Examples that can't drift — mostly built** in
  [test/doc-examples.test.mjs](../test/doc-examples.test.mjs), part of `npm test`; its header
  says what it checks and how. **Still open:** every transcript it doesn't name, and in the
  ones it does, the middle of `guide/getting-started.md`'s `setup --keys` transcript — the two
  key prompts and the starter-exclude notice, derived from `setup.mjs` and `sets.mjs` and
  never produced by a run — and its `Compare now? [y/N] y` line, typed into the test rather
  than read from `promptYesNo`.
- **OS switcher** (Windows / macOS / Linux), remembered across pages — the paths are the most
  visible inconsistency. Needs a markdown construct that still reads acceptably raw. The
  story ([test/helpers/story.mjs](../test/helpers/story.mjs)) already has a Windows and a
  POSIX world for each example to draw on.
- **Exclude-pattern playground.** `src/lib/exclude.mjs` imports only `node:path` and
  `path-match.mjs`, so the real matcher can be bundled for the browser — paste paths, type
  patterns, see what's dropped and by which pattern. Same code as the CLI, so it cannot disagree
  with it. Put it on `/pattern-playground` beside the `find` one, with the same pasted paths
  under both, so a pattern that means one thing in an exclude file and another to `find` shows
  it.

## Fun, with a point

- **Keep the existing voice** ("the cardinal sin", "fat-finger backstop") — wit in headings,
  asides and the 404 page, never in commands or warnings.
