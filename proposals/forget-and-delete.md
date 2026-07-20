# forget & delete — the deletion rework

The plan and design sketches for the deletion rework settled 2026-07-19 (the grilling session
that began as the orphan/unreferenced vocabulary stress-test and grew). **The decisions of
record live elsewhere** — the verb realignment in
[ADR-0063](../docs/adr/0063-forget-snapshots-delete-paths.md), the path-scoped `delete` +
deletion record + destructive-command pattern in
[ADR-0064](../docs/adr/0064-path-scoped-delete-deletion-record.md) — this file is the
*coordination spine*: PR slicing, dependencies, and the sketches that aren't yet ADR/design-doc
material. Per this directory's rules, sections are deleted as their PRs land (lasting
knowledge moves to ADRs / docs/design/ / guide/ first).

## The PR train

| PR | What | Depends on |
| --- | --- | --- |
| ~~**A**~~ | ~~Baseline-trust bug fix~~ **— landed** (#220) | — |
| ~~**B**~~ | ~~`delete`→`forget` rename + `unrestorable` sweep~~ **— landed** (#218) | — |
| ~~**C**~~ | ~~`restore` degrades gracefully on a missing object~~ **— landed** (#219) | — |
| ~~**D**~~ | ~~The new `delete`: deletion record + purge computation + `verify` partition + `restore` record-awareness + `backup`/`cleanup` record subtraction + `--everywhere` + format-spec section + CONTEXT.md repairs~~ **— landed** (ADR-0064 is the record) | — |
| **E** | Convert the rest of the tool to ADR-0064's destructive-command pattern | D merged |

## PR E — the destructive-command pattern conversion

ADR-0064 settled the tool-wide pattern (`delete` instantiates it): **act by default with a
tier-proportionate confirmation, `-n/--dry-run` previews, non-interactive destructive runs
require `--force`.** E converts the two commands that predate it:

- **`cleanup`**: drop the dry-run-by-default + `--delete` flag; bare `cleanup <bucket>` on a
  TTY computes → reports → y/N confirms → deletes (its gentler tier is right — it removes
  only what nothing references, soft-deleted). `cleanup -n` is today's report-only run; the
  cron idiom becomes `cleanup <bucket> --force`.
- **`forget`**: non-TTY runs currently proceed bare; under the pattern they require
  `--force` like the others. (TTY behaviour — preview + y/N — already matches.)

Doc sweep rides along: guide/maintenance.md's cleanup examples, docs/design/backup.md and
snapshot-deletion.md where they describe the old shapes.

## Deferred / not in this train

- **A "which snapshots contain this path" query command** — floated, has standalone value,
  but `delete`'s preview subsumes most of it. Revisit on demand.
- **Retention automation** (keep-last / daily / weekly / monthly) — unchanged; builds on
  `forget` + `cleanup` once real usage shows the shapes.
