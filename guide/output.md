# Output: human-readable text, and `--json` for machines

By default every s3cab command prints **human-readable text** to stdout — a
report of what an action did (`backup`, `restore`, …), and readable answers for
queries (`compare`, `list`, `status`, …). This is the format designed for a
person at a terminal.

For scripting, pass the global **`--json`** flag to get the same result as a
structured JSON value instead:

```console
> s3cab compare photos --json
{
  "setName": "photos",
  "dirs": ["/home/me/Pictures"],
  "since": "2026-11-11T0830",
  "until": "2026-11-12T0915",
  "added": [{ "path": "/home/me/Pictures/2025/new.jpg", "size": 812043, "duplicates": [] }],
  "moved": [],
  "modified": [{ "path": "/home/me/Pictures/diary.txt", "size": 240 }],
  "deleted": [],
  "errors": [],
  "skipped": []
}
```

`--json` works on any command and is owned by s3cab itself (like `--help` and
`--version`), so it can go anywhere on the line: `s3cab --json list` and
`s3cab list --json` are the same.

A few things worth knowing:

- **It's explicit-only.** s3cab never switches to JSON on its own — piping or
  redirecting (`s3cab compare > changes.txt`) still writes the readable text, so
  the format is predictable everywhere. Ask for JSON when you want it.
- **The JSON shape may change.** While s3cab is pre-1.0 (`0.x`), the `--json`
  structure is **not** a stability contract — fields may be added, renamed, or
  reshaped between releases. Don't build anything load-bearing on it yet.
- **Errors stay human-readable, always.** `--json` governs only a command's
  successful result on stdout. Errors are written to **stderr** in plain language
  regardless of `--json`, so a script should branch on the **exit code** (0 =
  success, non-zero = failure), not on parsing stderr.
- **Neither format truncates.** s3cab prints the whole result either way; manage
  volume yourself with a pager (`s3cab verify my-bucket | less`) or a redirect.

Absolute paths are what the JSON carries (unambiguous for a machine); the human
text shortens them for readability — see [reading a compare report](compare.md)
for how that report is laid out.
