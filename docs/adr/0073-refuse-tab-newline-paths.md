# Paths containing a tab or newline are refused, and abort the run

**Status:** accepted & implemented. Closes the "open edge case"
[0004](0004-tsv-snapshot-manifests.md) left for before release. Applies
[0054](0054-missing-member-dir-aborts.md)'s fail-loudly stance and
[0010](0010-cli-output-conventions.md)'s never-truncate rule.

## Context

A snapshot row is tab-separated and newline-terminated, so a path containing either character
breaks the line. ADR-0004 recorded this as an open edge case needing a documented rule — reject,
encode, or comment — and it has sat on CLAUDE.md's "Known gaps" list since.

What can actually occur:

- **Windows forbids both.** The Win32 naming rules exclude `< > : " / \ | ? *` *and* every
  character in the range 1–31, which is where tab (9) lives. NTFS can hold such a name if
  something writes it through native NT APIs, but nothing does in normal use, and Explorer itself
  struggles with the result.
- **POSIX allows both.** The only bytes forbidden in a filename are `/` and NUL.
- **The ecosystem treats them as pathological.** They are the classic source of shell-scripting
  bugs — `find -print0` and `xargs -0` exist because of them. Nothing produces such names
  deliberately; when they appear it is a script naming files from untrimmed data.

## Decision

**Refuse them. A path containing a tab or a newline aborts the run**, naming every offender.

The check runs **during the walk**, which is the cheap phase: `walkSet` fully materialises the
file list before `writeSnapshot` starts, so the failure costs seconds of enumeration rather than
hours of hashing — true with the fused pipeline too
([0069](0069-fused-snapshot-upload-pipeline.md)). A directory whose own path offends means
skipping its subtree, which is forced rather than chosen: every path beneath it contains the
character as well.

Every offender is collected and reported in one failure, **not truncated**
([0010](0010-cli-output-conventions.md)). Almost nobody will ever see this, but whoever does is
likely to have hundreds at once — a buggy script produced all of them — and fixing that one error
at a time would be its own ordeal.

## Why not support them

- **Newlines are structurally impossible.** The format is line-oriented, and 0004 chose TSV
  *precisely* to avoid escaping: "tabs almost never occur in real paths, so we avoid CSV's
  comma-quoting *and* JSON's escaping". Supporting a newline means introducing an escape or
  quoting mechanism into the one format whose selling point is not having one.
- **Tabs are technically supportable, and still not worth it.** The path is the **last** field on
  every row type, so a parser could take the first three fields and rejoin the remainder — lossless,
  about one line. But it cannot arise on the primary platform, it is a defect where it can, and it
  would cost that row its column alignment and its clean import into a spreadsheet (0004's
  "opens cleanly in Excel"), while any third-party reader doing the obvious "take the 4th field"
  would silently truncate the path — a no-lock-in wrinkle. Engineering for a case that does not
  occur is what [0006](0006-minimal-code.md) exists to prevent.

## Why abort rather than skip-and-record

Recording the file as a `#SKIPPED` row and carrying on was the obvious alternative — the grammar
already has that slot for entries the walk omits by design. Three things decided against it:

1. **Abort is the only option that never writes the offending path into the TSV.** Skip-and-record
   must, which forces an escaping scheme for the record itself — and the obvious one is wrong here:
   `\t` is ambiguous on Windows, where the backslash is the separator and `C:\test\file` is
   everywhere. Aborting names the path on **stderr**, where a tab is harmless, so the pathological
   case never touches the format at all.
2. **`#SKIPPED` surfaces nowhere in output today.** The walk's skipped records reach the file and
   parse back into `Snapshot.skipped`, but no renderer shows them — so skip-and-record would be
   *silent*, which is the worst outcome for a file the user believes is backed up.
3. **There is precedent, and it is the same shape.** [0054](0054-missing-member-dir-aborts.md)
   makes a missing member directory abort the whole run rather than quietly back up less, on the
   principle that a backup must never *silently* skip something the user means to keep.

The asymmetry with `restore` — which deliberately keeps going past missing objects — is
intentional: a halted **recovery** is catastrophic and unrepeatable, a halted **capture** is
neither. You fix the name, or exclude it, and run again.

## The escape hatch

`exclude.txt` covers it, and the user never has to reproduce the character.
[`compileExclude`](../../src/lib/exclude.mjs) turns `*` into `[^/]+`, a negated class that matches
a tab *and* a newline, since neither is `/`:

```
odd*name.jpg
```

excludes `odd<TAB>name.jpg`. The abort message points here. (`parseLines` trims each line, so a
*leading or trailing* tab in a pattern would be stripped — immaterial, given `*` does the job.)

## Consequences

- **A member root containing a tab is caught by the same walk check**, since every path beneath it
  inherits the character. No separate validation at `setup`.
- **The deletion record needs nothing.** Such paths are never backed up, so they can never appear
  in one.
- **guide/format.md states the rule** beside the regular-files-only line — it is the same kind of
  statement about what is deliberately not stored.
- **CLAUDE.md's "Known gaps" entry retires.**
