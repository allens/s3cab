# No row holds a real tab, CR or LF: each field either refuses them or spells them out

**Status:** accepted & implemented (proposed 2026-10-11). Partly supersedes
[0073](0073-refuse-tab-newline-paths.md): the refusal extends to links, the `<TAB>`/`<CR>`/`<NL>`
spelling becomes control pictures, and an exclude pattern may no longer hold a tab or CR. 0073's
abort-not-skip reasoning stands. Row layout is [0098](0098-snapshot-row-layout.md), links
[0099](0099-links-recorded-never-followed.md).

## Decision

**Each field is fixed as either refusing a tab, CR or LF or spelling them out.** Keyed on what
s3cab refuses, not on who reads a field, so it still holds when a field only people read today
becomes one the code reads.

- **Refused:** an `object` path, and a link's path and its target. The walk's check (0073)
  extends to links, so an offending link stops the run like an offending file, and an exclude
  pattern is the way past. A `␉` in these fields is only a character of the name, and restores
  as itself.
- **Spelled out, everywhere else:** as the Unicode Control Pictures `␉` (U+2409), `␍` (U+240D)
  and `␊` (U+240A), and the spec says a reader may read them as the characters they stand for. In
  practice that is an `#excluded` path, since excluding is how such a file gets past the refusal,
  and pathologically `HOME`. A real `␉` in an excluded name would read back as a tab; accepted,
  because these characters exist to stand for those. They replace `showControlChars`'s
  `<TAB>`/`<CR>`/`<NL>`, in error messages too. Measured 2026-10-10: Cascadia Mono and Segoe UI
  Symbol carry all three, Consolas and Calibri none.
- **An exclude pattern may not contain a tab or CR**: refused when the file is read, with `*` as
  the fix. Until now one was kept and matched literally.

## Consequences

- The no-row case [PR #388](https://github.com/allens/s3cab/pull/388) added for a skipped name
  with a line break goes with `#SKIPPED` (0099).
- 0073's escape hatch is unchanged: `*` matches a tab or newline, so `odd*name.jpg` still excludes
  a name with a tab between `odd` and `name.jpg`.
- **The pattern check runs after `parseLines` trims each line**, so an `exclude.txt` with CRLF
  endings is not refused; only a tab or CR inside a pattern is.
