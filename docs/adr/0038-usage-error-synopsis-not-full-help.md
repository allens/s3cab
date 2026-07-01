# Usage errors show the synopsis + the missing arg's description, not the full help block

**Status:** accepted (design decided via a grilling session 2026-07-01) —
**implemented** (2026-07-01). Sits in the CLI-output lineage of
[0010](0010-cli-output-conventions.md) (stream discipline) and
[0030](0030-error-message-guidelines.md) (message wording); reasoned under the
**Command Line Interface Guidelines** ([clig.dev](https://clig.dev), the
`cli-design` skill) for command *shape*.

## Context

On any usage error the dispatcher printed the error line **and then dumped the entire
`usage()` block** — synopsis + the full `Arguments:` and `Options:` description tables
([src/s3cab.mjs](../../src/s3cab.mjs), the `isUsageError` branch). For a one-argument
mistake (`s3cab setup` with no set) the missing arg was then stated three times: the
error's hand-written parenthetical, the synopsis line, and the Arguments table. Worse,
the error glosses were **inconsistent** — `setup` hand-wrote three *different* styles
(a mini-synopsis for `<set>`, prose for `<directory>`/`--bucket`), while the shared
`requireArg` ([src/lib/error.mjs](../../src/lib/error.mjs), used by `prop` etc.) wrote
none. The redundancy and the drift were both structural, not a one-command wording bug,
so the fix is a single CLI-wide convention rather than a `setup` patch.

## Decision

1. **A usage error prints three parts, nothing more:**

   ```
   ERROR: Missing required argument: --bucket — The S3 bucket to back this set up to, set when you first create it

   Usage: s3cab setup [options] <set> [<directory>...]
   Run 's3cab setup --help' for details.
   ```

   The **error line** (message + the missing arg's description), a **one-line
   synopsis**, and a **`--help` pointer**. The full `Arguments:`/`Options:` description
   tables move to `-h`/`--help` *only*. This is clig.dev's "say enough, not too much" /
   high signal-to-noise: a user who fat-fingered one argument does not need the whole
   options catalogue — the shape plus a pointer is what every admired CLI (clap, cargo,
   git) prints on error.

2. **Scope: only the `isUsageError` set gets the synopsis + pointer** — our own
   `ParseArgsError` (a missing arg, or a flag conflict / bad flag value that names no
   single arg — e.g. `--profile` with `--unset`) and Node's foreign `ERR_PARSE_ARGS*`
   family (unknown option, missing option value). Only the missing-arg case carries an
   `argName` and gets the inline description; the rest print the synopsis + pointer with
   just their own message. `ValidationError` (bad set/bucket *value*) and plain
   runtime errors stay **message-only**: they already carry their own tailored fix, so a
   synopsis would be noise. An unknown *command* keeps printing the full command **list**
   (there is no single command to point `--help` at — the list *is* the help).

3. **The missing arg's description is single-sourced from the registry and shown
   inline.** It is *kept* (not dropped for a lean "name only" error) because of point 4:
   with flags hidden behind `[options]`, a missing **flag** like `--bucket` — the marquee
   first-timer failure — has *no* other inline context; the synopsis doesn't even contain
   the word "bucket". The description is load-bearing there. For positionals it is a
   nice-to-have the synopsis largely already conveys, but uniform beats special-cased.

4. **The synopsis keeps `[options]`; required flags are not surfaced into it.**
   `--bucket` is required *only* on the `create` path — `setup` is a modal
   create/update/inherit verb ([0036](0036-setup-mutates-list-shows-drop-sets.md)) and the
   registry has no "required flag" concept, because requiredness is enforced contextually
   in `create()`. A command-wide synopsis showing `--bucket <bucket>` unbracketed would
   **lie** for `update`/`inherit`. Inventing a required-flag notion purely for this line is
   over-engineering ([0006](0006-minimal-code.md)). The missing-`--bucket` error still
   guides the user — via its description (point 3), and the create-path errors walk a
   first-timer through the required args one at a time.

5. **Mechanism: positional args in the registry become data-driven, matching how
   `options` already store metadata.** A positional arg goes from a decoration-baked key
   with a bare-string value (`"[<directory>...]": "The directories…"`) to a plain key with
   a descriptor (`directory: { variadic: true, description: "The directories…" }`) — the
   same shape `options` have always used (`bucket: { type, short, description }`). The
   presentation string (`<set>`, `[<directory>...]`) is then **constructed** from the
   metadata by a `displayArg()` helper, never parsed back, and the description lookup is an
   **exact** hit in whichever map holds the name — no string-stripping. `ParseArgsError`
   gains an `argName`; `requireArg` sets it; the dispatcher renders the description via the
   registry. Positional args and options finally have one shape.

## Rejected alternatives

- **Keep dumping the full help block, just de-duplicate the error line.** Rejected: the
  full options table on a one-arg slip is the noise we set out to remove; the block also
  restates the arg a third time.
- **Per-throw-site description overrides** (a generic registry description, overridable
  with custom wording per call). Rejected: it re-opens the exact drift we are closing —
  "override when it's better" slides to "override everywhere." A description that reads
  badly is a *registry-wording* fix (one home, improves `--help` too), not a per-site
  escape hatch. If a command's arg genuinely needs *different* wording on different paths,
  that is a **modality smell** to investigate (does it want splitting?), already answered
  for `setup` by [0036](0036-setup-mutates-list-shows-drop-sets.md) — not a reason to add
  the override.
- **Surface required flags in the synopsis** (point 4). Rejected: misrepresents the modal
  command and needs a registry concept that does not exist.
- **Go lean — drop the inline description, rely on synopsis + pointer** (point 3).
  Rejected: because the synopsis hides flags behind `[options]`, this would make the one
  error a new user is most likely to hit (`--bucket`) the *least* informative.
- **A string-normalizer lookup** that strips `<`, `[`, `...`, `--` off the decorated keys
  to match. Rejected in favour of the data-driven registry (point 5): construct
  presentation from data, don't parse it back out of a display string.
- **Lift descriptions into a separate `descriptions: {…}` map.** Rejected: two places to
  edit per arg and a sync burden. Colocation — `description` on the thing it describes —
  is the better ergonomics, and the shoehorn it would "clean up" is principled anyway (see
  Consequences).

## Consequences

A CLI-wide convention every current and future command inherits for free; adding a
command needs no error-wording work. It touches:

- **[src/commands.mjs](../../src/commands.mjs)** — every command's `args` block rekeyed to
  the `{ description, required?, variadic? }` descriptor shape (~16 entries across 14
  commands); the `Command` typedef's `args` value goes `string` → descriptor. This is the
  bulk of the churn, all mechanical. Accepted under pre-1.0 free rein + "correctness over
  churn": the *end state* is simpler and uniform (args and options one shape), which per
  [0006](0006-minimal-code.md)/#7 is the "more work, less complexity" swap, not
  over-engineering. Two clumsy `(required when creating)` descriptions are reworded while
  here, since they now do double duty (error line *and* `--help` table).
- **[src/help.mjs](../../src/help.mjs)** — `synopsis()` carved out of `usage()` (which
  reuses it, so `--help` output is unchanged); a `displayArg()` presentation generator; an
  `argDescription()` exact-match lookup.
- **[src/lib/error.mjs](../../src/lib/error.mjs)** — `ParseArgsError` gains `argName`;
  `requireArg` sets it.
- **[src/s3cab.mjs](../../src/s3cab.mjs)** — the catch block appends the description and
  prints synopsis + pointer for `isUsageError`.
- **[src/commands/setup.mjs](../../src/commands/setup.mjs)** — the three hand-written
  parentheticals **deleted**; the create-path checks become `requireArg` calls carrying
  `argName`. (`<set>` keeps a distinct `=== undefined` check so an empty string still
  routes to `validateSetName` as *invalid*, not *missing*.)
- **Tests** — the assertions pinning the old message shape
  (e.g. [src/commands/setup.test.mjs](../../src/commands/setup.test.mjs) checking the
  `<set>` mini-synopsis inside the thrown message) move to the new output.

**The `options` typedef shoehorn is kept, deliberately.**
`CommandOption = ParseArgsOptionDescriptor & { description }` is not a hack: `parseArgs`
*consumes* option descriptors, so an option legitimately *is* Node's descriptor plus our
one presentation field, and the intersection type keeps our objects provably valid
`parseArgs` input (Node changing its descriptor would fail the type check). Positional
args, which `parseArgs` never sees per-name, get our own pure-metadata descriptor instead
— the two shapes differ because the two things differ, which is honest modeling, not
inconsistency.
