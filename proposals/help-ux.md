# Task: standardize user-facing language on "directory" + complete the no-sets `--bucket` hint

**Scope:** small, settled, mechanical. Vocabulary sweep + two tiny help/UX fixes. No design
left open — implement as written.

**Origin:** a user run-through of the CLI raised three help/UX nits (folder-vs-directory wording;
"snapshot of a backup set" reads vague to a first-timer; the no-sets hint dead-ends because it
omits `--bucket`). Grilled to ground in a `/grill-with-docs` session; decisions below.

---

## Decision 1 — say "directory" everywhere user-facing; storage token stays `#DIR`

The surface today **mixes** "folder" and "directory" — sometimes in one sentence
([help.mjs:97](../src/help.mjs#L97): _"member **directories**. Write / between **folders**"_).
That inconsistency is the actual defect, not the word choice. Standardize on **"directory"**.

Why "directory" wins (so the next session doesn't re-litigate):

1. **The stored snapshot-file format is the authority, and it already says `#DIR`.** `#DIR` is one
   of five tokens (`#SNAPSHOT`/`#DIR`/`#EXCLUDED`/`#SKIPPED`/`#ERROR`,
   [snapshot-file.mjs:50-54](../src/lib/snapshot-file.mjs#L50)) in a self-describing, human-readable
   grammar a recoverer reads with no tool — the ADR-0002 no-lock-in promise (printed as example
   output in [README.md:229](../README.md#L229)). Stored data is the permanent surface; a CLI arg
   name is just a habit. Align the cheap-to-change prose/arg **to** the format, not the reverse.
2. **`#DIR` → "directory" is the same word abbreviated** (DOS `dir`, universal), so storage and
   prose stay consistent. `#FOLDER` would force prose to "folder" for zero gain and reintroduce
   point 3.
3. **Disambiguation:** s3cab straddles local FS and S3, and the **S3 console itself calls prefixes
   "folders"** (they're fake). "Directory" unambiguously means _the local path you enrolled_;
   "folder" is overloaded in this exact tool.

(Pre-1.0, the rename is free rein — don't let change-count sway it; CLAUDE.md "don't fear refactors".)

**Changes:**
- Rename the positional arg `<folder>`/`<folder>...` → `<directory>`/`<directory>...` in
  [commands.mjs](../src/commands.mjs) (`setup` arg) and every usage/help line that prints it
  (e.g. [help.mjs:47](../src/help.mjs#L47)).
- Sweep user-facing strings "folder"→"directory": [help.mjs](../src/help.mjs) (esp. the mixed
  line 97 and the exclude topic), [list.mjs](../src/commands/list.mjs) no-sets text,
  [restore.mjs](../src/commands/restore.mjs) prose, [setup.mjs](../src/commands/setup.mjs)
  messages, [sets.mjs](../src/lib/sets.mjs), and `guide/exclude.md` / `README.md` where they say
  "folder".
- **Leave code internals as-is** — `isDirectory()`, the `#DIR` token, `dirs`, and comments are a
  separate technical register no user reads.
- Update [CONTEXT.md](../CONTEXT.md) backup-set entry: it already defines a set as "a named list of
  **directories**" (it was right) — pin the decision in the `_Avoid_` line, and fix the one stray
  "local **folder**" in the same entry. Land this **with** the code so the glossary never
  leads/misleads. Ready-to-apply edit (the **Backup set** entry, [CONTEXT.md:53-58](../CONTEXT.md#L53)):

  ```diff
  -local folder under `~/.s3cab/sets/<name>/`, and the remote namespace. Unique within a bucket
  +local directory under `~/.s3cab/sets/<name>/`, and the remote namespace. Unique within a bucket
   (first-come).
  -_Avoid_: profile, job, project, config.
  +_Avoid_: profile, job, project, config; folder (the user-facing word is **directory** — `#DIR` in
  +the snapshot file is just its abbreviation; "folder" collides with S3's pseudo-folders).
  ```
- Update tests asserting on `<folder>` / "folder" / the swept strings.

## Decision 2 — define "backup set" once, at first contact (don't reword summaries)

"Take a snapshot of a backup set" is correct (a set _is_ the unit of snapshot/backup/restore), but
"set" reads vague to a first-timer, and the top-level help **never defines it** — it's used in
seven summaries assuming you know it ([help.mjs:169-193](../src/help.mjs#L169)). Fix the missing
gloss, not the summaries (avoiding the word doesn't teach it; "use it everywhere, define it once").

**Change:** add a one-line gloss under the title in `usage()`, foregrounding directories as the
essence (excludes/bucket are lesser detail, correctly omitted):

```
s3cab — S3 Content Addressable Backup

A backup set is a named group of directories you keep safe in the cloud.

Usage: s3cab <command> [options] [args]
```

Leave all command summaries unchanged.

## Decision 3 — complete the no-sets hint with `--bucket`, and dedup the two copies

The no-sets guidance omits `--bucket`, so a first-timer who follows it verbatim walks straight into
`Missing required argument: --bucket` ([setup.mjs:145](../src/commands/setup.mjs#L145)) — the fix we
hand them doesn't work (ADR-0030 violation). Meanwhile [setup.mjs:58](../src/commands/setup.mjs#L58)
_already_ prints the complete form, so the tool contradicts itself. And the two no-sets messages are
near-duplicates with drifted wording: "No backup sets **configured.**"
([sets.mjs:254](../src/lib/sets.mjs#L254)) vs "No backup sets **yet.**"
([list.mjs:61](../src/commands/list.mjs#L61)).

**Changes (chose the minimal "one complete next step" scope — _not_ a mini-tutorial pointing at
`s3cab aws`; the `<bucket>` placeholder already signals a bucket is needed, and `setup`/onboarding
lead there):**
- Lift the corrected message into **one shared constant** (in [sets.mjs](../src/lib/sets.mjs)) and
  have `list` use it, so they can't drift again.
- Make it complete: `Create one with: s3cab setup <set> <directory>... --bucket <bucket>` (note: also
  picks up the Decision 1 rename).

---

When all three are done and verified, delete this file (proposals are not of record).
