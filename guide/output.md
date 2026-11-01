# Output: human-readable text, and `--json` for machines

By default every s3cab command prints **human-readable text** to stdout — a
report of what an action did (`backup`, `restore`, …), and readable answers for
queries (`compare`, `list`, `status`, …). This is the format designed for a
person at a terminal.

For scripting, pass the global **`--json`** flag to get the same result as a
structured JSON value instead:

```console windows
> s3cab compare photos --until 20251111T0830 --json
{
  "setName": "photos",
  "dirs": ["C:\\Users\\me\\Photos"],
  "since": "20251110T2104",
  "until": "20251111T0830",
  "added": [
    { "path": "C:\\Users\\me\\Photos\\brand-logo.png", "size": 41000, "duplicates": ["C:\\Users\\me\\Photos\\logo.png"], "wasUnreadable": false }
  ],
  "moved": [
    { "path": "C:\\Users\\me\\Photos\\notes.txt", "size": 2100, "to": "C:\\Users\\me\\Photos\\diary.txt" }
  ],
  "modified": [
    { "path": "C:\\Users\\me\\Photos\\report.pdf", "size": 1250000 }
  ],
  "deleted": [
    { "path": "C:\\Users\\me\\Photos\\old notes.txt", "size": 900 }
  ],
  "errors": []
}
```

```console posix
> s3cab compare photos --until 20251111T0830 --json
{
  "setName": "photos",
  "dirs": ["/home/me/Photos"],
  "since": "20251110T2104",
  "until": "20251111T0830",
  "added": [
    { "path": "/home/me/Photos/brand-logo.png", "size": 41000, "duplicates": ["/home/me/Photos/logo.png"], "wasUnreadable": false }
  ],
  "moved": [
    { "path": "/home/me/Photos/notes.txt", "size": 2100, "to": "/home/me/Photos/diary.txt" }
  ],
  "modified": [
    { "path": "/home/me/Photos/report.pdf", "size": 1250000 }
  ],
  "deleted": [
    { "path": "/home/me/Photos/old notes.txt", "size": 900 }
  ],
  "errors": []
}
```

`--json` works on any command and is owned by s3cab itself (like `--help`), so
no command needs its own support for it. It goes anywhere *after* the command
name — `s3cab list --json` and `s3cab list photos --json` both work; the first
word must be the command.

A few things worth knowing:

- **It's explicit-only.** s3cab never switches to JSON on its own — piping or
  redirecting (`s3cab compare > changes.txt`) still writes the readable text, so
  the format is predictable everywhere. Ask for JSON when you want it.
- **The JSON shape may change.** While s3cab is pre-1.0 (`0.x`), the `--json`
  structure is **not** a stability contract — fields may be added, renamed, or
  reshaped between releases. Don't build anything load-bearing on it yet.
- **Errors stay human-readable, always.** `--json` governs only a command's
  successful result on stdout. Errors are written to **stderr** in plain language
  regardless of `--json`, so a script should branch on the **exit code**, not on
  parsing stderr. Zero is success and non-zero is failure; when a script wants to
  tell failures apart, the convention is:

  | Code | Means |
  | ---- | ----- |
  | `0`   | success — including a restore whose only gaps are deliberate deletions |
  | `1`   | a runtime failure, or findings: `verify` found problems, `restore` couldn't produce a file, `backup` or `snapshot` couldn't read one |
  | `2`   | bad input — a usage error, an unknown flag, an invalid name |
  | `127` | unknown command |
  | `130` | interrupted (Ctrl+C) |
- **Neither format truncates.** s3cab prints the whole result either way; manage
  volume yourself with a pager (`s3cab verify my-backups | less`) or a redirect.

Absolute paths are what the JSON carries (unambiguous for a machine); the human
text shortens them for readability — see [reading a compare report](compare.md)
for how that report is laid out.
