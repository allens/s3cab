# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

This is a **single-context** repo: one root `CONTEXT.md` glossary and one `docs/adr/` decision log.

## Before exploring, read these

- **`CONTEXT.md`** at the repo root — the glossary (canonical term + definition + `_Avoid_` synonyms).
- **`docs/adr/`** — read ADRs that touch the area you're about to work in. [docs/adr/README.md](../adr/README.md)
  indexes them and carries the old `#1`–`#7` → `0001`–`0007` mapping.

If any of these files don't exist, **proceed silently**. Don't flag their absence; don't suggest creating them upfront. The `/domain-modeling` skill (reached via `/grill-with-docs` and `/improve-codebase-architecture`) creates them lazily when terms or decisions actually get resolved.

## Use the glossary's vocabulary

When your output names a domain concept (in an issue title, a refactor proposal, a hypothesis, a test name), use the term as defined in `CONTEXT.md`. Don't drift to synonyms the glossary explicitly avoids. s3cab names for its **consumers**, not for developers — see [ADR-0012](../adr/0012-consumer-vocabulary-naming.md).

If the concept you need isn't in the glossary yet, that's a signal — either you're inventing language the project doesn't use (reconsider) or there's a real gap (note it for `/domain-modeling`).

## Flag ADR conflicts

If your output contradicts an existing ADR, surface it explicitly rather than silently overriding:

> _Contradicts ADR-0013 (one repository, one bucket) — but worth reopening because…_
