# Exclude rules

Files and folders to skip are listed in a backup set's exclude file,
`~/.s3cab/sets/<set>/exclude.txt`, one glob pattern per line. Lines starting with
`#` are comments; blank lines are ignored.

> For a quick reference in the terminal, run `s3cab help exclude` — it carries
> the same rules as this page, no browser needed.

## Globbing

Patterns are matched against the path of each file or directory, relative to
**each** of the set's member directories (so one pattern applies the same way to
every folder in the set). Write `/` between folders; on Windows `\` works too. A
_segment_ is one folder or file name (the text between two separators).

| Token  | Matches                                            |
| ------ | -------------------------------------------------- |
| `*`    | one or more characters, within a single segment    |
| `**/`  | zero or more whole segments                        |
| `?`    | exactly one character                              |

A pattern ending in `/` matches a directory (and everything inside it, since the
walker doesn't descend into an excluded directory).

Matching is case-insensitive on Windows and case-sensitive elsewhere.

## Examples

- `Tests/**/*.js` — `.js` files anywhere under the `Tests` directory:
  `Tests/HelloWorld.js`, `Tests/UI/HelloWorld.js`, `Tests/UI/Feature1/HelloWorld.js`.
- `**/log.txt` — a file named `log.txt` in any directory, including the root:
  `log.txt`, `Tests/log.txt`, `Tests/UI/log.txt`.
- `**/node_modules/` — every `node_modules` directory, wherever it appears.
- `build/` — the top-level `build` directory only.

For a real-world example, see this repository's own
[.s3cab/exclude.txt](../.s3cab/exclude.txt).
