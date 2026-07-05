# CLI output: JSON.stringify, stream discipline, env-gated debug

**Status:** accepted

Three linked conventions for how commands emit output.

## Results are serialized with `JSON.stringify`, never `console.log`

> **Default inverted by [0043](0043-human-first-output.md) (2026-07-04):** this section now
> describes the **machine** path. Human-readable text is the stdout **default**; the
> `JSON.stringify` serializer moves **behind `--json`**, where this rationale holds unchanged
> (never truncates, one uniform serializer). The never-truncate principle *also* carries over
> to the new human output. Read 0043 before treating "JSON to stdout by default" as live.

`console.log` routes large structures through `util.inspect`, which **truncates**
(`… N more items`) — fatal for a backup tool whose whole job is "show me everything that
changed". One uniform serializer also means no bespoke per-command printer to maintain
([0006](0006-minimal-code.md)). The one deliberate exception is `hashes` (bare
hash-per-line output — see its doc comment).

## Stream discipline: real output to stdout, everything else to stderr

A command's *real output* — results, `--version`, explicitly requested `--help` — goes to
**stdout**; everything else — progress, warnings, usage shown as part of an *error* — goes to
**stderr**. So `s3cab tree . > files.txt` captures just the file list and `s3cab --help | less`
works. This is why `usage()` *returns* text rather than printing it: the caller chooses the
stream, visibly, at the call site.

## Debug output is gated by `S3CAB_DEBUG`, not a CLI flag

It's a cross-cutting concern, so it lives outside per-command option parsing and is merged
into the options bag passed to each `exec`.
