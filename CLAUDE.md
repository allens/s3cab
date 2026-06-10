# CLAUDE.md

Architecture, design philosophy, and conventions for **s3cab**. This file is for
contributors and for AI assistants working in the codebase — it documents the _why_
behind decisions, not how to use the tool. User-facing documentation lives in
[README.md](README.md).

### Documentation discipline (applies to this file and the README)

Two standing rules govern the docs. They matter because **transparency is a core project
value** (see #2, no lock-in): docs that lie about behaviour undermine the whole premise.

1. **Keep docs rigorously in sync with the code — never aspirational or stale.** Before
   writing a claim, verify it against the actual code. Always distinguish what is **built
   today** from what is **planned/target** (the README's S3/backup descriptions are the
   target; the code in `src/` is what works now). Flag drift you
   notice — stale comments, `package.json` paths to non-existent files, etc.; the "Known
   gaps & cleanup items" section is the running list.
2. **CLAUDE.md carries only what is _not_ trivially knowable from the code** — the
   non-obvious _why_. Do **not** restate `package.json` scripts, or build/test/lint
   commands, or anything a contributor could derive by reading the source. Developer
   setup instructions, if wanted, belong in the README (or a dedicated dev doc), not here.

The split itself: **README.md** is user-facing (what it is, why, status, commands,
install/usage, license — examples use Windows paths, the primary target). **CLAUDE.md**
is for contributors/AI (architecture, the design philosophy below, data formats,
conventions, and the pre-release TODO list).

### Working conventions (for AI assistants)

Standing operating rules, kept **here in source** rather than any one machine's local
memory so every session — on any computer — follows them. **When the user has to correct
you on a decision, record that decision here** (that is how this list grows) — local memory
is invisible to other machines, so a correction kept only there gets re-litigated elsewhere.
These are **defaults, not shackles:** if you think the context behind a rule has changed,
it is fine — encouraged, even, once in a while — to ask the user whether it still holds
rather than assuming it is fixed forever.

1. **Never `git commit`/`push` without an explicit go-ahead in that same message.** Do the
   work, show what changed, then wait to be told "commit" / "pr". A go-ahead is per-request,
   not standing — don't carry it forward to later changes.
2. **Multiple sessions may run on this repo at once.** Stage only the files _you_ changed
   (`git add <path>`, never `git add -A`/`.`), so you don't sweep up another session's
   in-flight work.
3. **[.claude/settings.json](.claude/settings.json) is a shared, committed project file**
   (the team-wide permission allow/deny lists), not personal — `settings.local.json` is the
   gitignored personal override. This does **not** authorise an unprompted commit (rule 1
   still holds). But _when a commit/PR go-ahead is given_ and the working tree also has
   changes to `.claude/settings.json`, fold them in rather than setting them aside as
   unrelated — they need no separate sign-off. Validate via the `update-config` skill first,
   and keep it as its own `chore:` commit so it reads cleanly apart from the feature change.
4. **After non-trivial work, update CLAUDE.md / README.md** so what you learned is shared at
   the project level (this section exists because that wasn't being done for these very
   rules). A cross-machine rule belongs in source, never only in local memory.
5. **Refactors and minor chores may ride along with a feature** — the user is relaxed about
   this; a one-feature commit/PR carrying a small refactor, a settings.json tweak (point 3),
   or a doc fix needn't be split into its own PR. Don't over-engineer separation. (Still
   prefer a _separate commit_ per logical change within the PR, as the `chore:` commits do.)

---

## What this project is

**s3cab** = **S3 C**ontent **A**ddressable **B**ackup. [README.md](README.md) covers what
it is, why, and status — not repeated here. What matters for working in the code:

- **Built today:** the local snapshot + diff engine — walk a tree (with exclude
  globbing) → compute per-file SHA-256/size/mtime → write an immutable `.tsv.zst`
  manifest → diff two snapshots into added/moved/modified/deleted via content hashes
  (so moves, renames, and duplicates are detected).
- **Not yet built:** the full snapshot-driven backup/restore flow to S3. The
  `objects/<sha256>` store + remote snapshots are the next milestone. The S3 milestone has
  _started_: the S3 client and its operations have been promoted into [src/lib/s3.mjs](src/lib/s3.mjs)
  (the single SDK boundary — see Core modules), so the production CLI uses the AWS SDK
  directly. Two plumbing commands now exercise that store — `objects` (lists stored hashes)
  and `upload` (hashes one file and PUTs it at `objects/<sha256>`) — and the SSO-login POC has
  been promoted to a real (if still rough) `login` command
  ([src/commands/login.mjs](src/commands/login.mjs)). The old `src/_poc/` experimental sandbox
  has been retired: its last occupant, the `upload-file` stub, became the real `upload`
  command, so the folder is gone. Future throwaway/scratch experiments go in
  [scripts/](scripts/) instead, not a parked sandbox under `src/`.

Treat the README's S3/backup descriptions as the _target_; treat `src/` as _what works now_.

---

## Design philosophy

These principles are the heart of the project. When a decision is unclear, decide in
favour of these — especially #2, which the others serve.

### 1. Content-addressable, at the file level

Dedup by the **SHA-256 of whole-file contents**. Identical content — anywhere, under
any name — is stored once. Moving a folder of videos, or backing up duplicate files,
costs no extra storage.

Dedup is deliberately **file-level only**. No sub-file/block packing, no chunking, no
delta encoding. Yes, that means a one-byte change to a large file produces a wholly new
object, and it forgoes some space savings. That cost is **accepted on purpose**: block
packing would make the stored format opaque and break easy recovery (see #2). The big
wins (moved/duplicate files) come from file-level hashing anyway, and the largest files
(video, photos) rarely change in place.

**Why SHA-256:** ubiquitously available in every language/runtime/CLI (`sha256sum`,
`openssl`, `certutil`, Node's `crypto`), fast enough that I/O — not hashing — is the
bottleneck, and collision-resistant with an intact security margin. (Note: SHA-1 — what
Git historically uses — is _not_ a good choice here; collision attacks against it are
real, and in a content-addressable store a collision means silent data loss.)

### 2. No lock-in (hard constraint)

The single most important principle. **If s3cab disappeared tomorrow, a competent
person should be able to recover their data by hand, or write a replacement tool in an
afternoon.** Snapshot manifests and the object store use plain, self-evident formats.
Recoverability is a first-class feature, designed in on purpose — not an afterthought.

This is a **hard constraint, not a preference.** Reject any feature that meaningfully
harms hand-recoverability, even if it saves space or time. (This is exactly why
file-level-only dedup is chosen over block packing.)

### 3. Embrace modern _open_ tech

Target the newest OS, runtime, and language features deliberately — _provided they are
standard and open_. Modern ≠ proprietary. The project happily requires recent tech
(see `engines.node`), but only open, widely-implemented tech.

Worked examples:

- **zstd** — an open standard, native in Node and in Windows 11 (not Win10 out of the
  box). Chosen for snapshot compression after testing several algorithms; best
  speed/ratio balance.
- **Node 26+** — for native built-ins that remove the need for dependencies (see #5).

### 4. TSV snapshot manifests

Snapshots are tab-separated values. This flows directly from #2.

- **Editor-readable.** Fixed-width leading columns scan cleanly even unaligned.
- **Deliberate column order for visual alignment:** fixed-width fields first
  (`hash` → `size` → `mtime`), variable-length `path` **last**, so the left edge stays
  aligned and the ragged part is pushed right.
- **Opens cleanly in Excel** (treated as an "open enough" standard) → instant
  sort/filter/pivot over a backup manifest. (Caveat: don't let Excel re-save and mangle
  it.)
- **TSV > CSV > JSON** for this job: tabs almost never occur in real paths, so we avoid
  CSV's comma-quoting _and_ JSON's escaping — notably JSON would force escaping every
  Windows backslash (`C:\\Users\\...`). Less escaping = more directly recoverable.

See the format spec at the top of [src/lib/snapshot-file.mjs](src/lib/snapshot-file.mjs) and
the data-model section below.

### 5. Built-ins over dependencies (high bar for libraries)

Prefer Node/JS built-ins. The bar to add a third-party dependency is high, and applies
to **runtime deps, CLI ergonomics, and dev tooling** alike:

- Arg parsing → Node's `node:util` **`parseArgs`**, _not_ commander.
- Terminal output → plain ANSI / `process.stderr`, _not_ chalk.
- Tests → Node's built-in **`node:test`** runner, _not_ Jest (especially) or Vitest.
  This is a deliberate choice; contributors should **not** introduce a test framework.

**Permitted runtime dependencies are exactly two kinds:**

1. **Genuinely too big to hand-craft** → the **AWS SDK** (SigV4, multipart, SSO/OIDC).
   This is _the_ sanctioned exception; reimplementing it by hand would be absurd.
2. **Polyfills of actual standards**, accepted _temporarily_, removed the moment the
   native version ships. Filling a standards gap is fine; reaching for a convenience lib
   is not. There are currently **none**: `@js-temporal/polyfill` was the worked example,
   and it was duly dropped once native `Temporal` landed in the target Node (≥26.3.0) —
   `Temporal` is now used as a global. The AWS SDK is therefore the only runtime dep.

**Dev dependencies get a more relaxed bar** — they never ship to users and don't affect
recoverability. The notable one is **esbuild**, used only to bundle the ESM source into
a single ESM file for native-executable packaging (see Tooling & build). Even here
the same instinct applies: it exists to bridge a gap (SEA needs one standalone file),
and Node's growing native capabilities may remove the need for it over time.

### 6. Minimal, simple code

Code should be as **small and low-surface-area** as possible — easy for a newcomer (or
future maintainer) to pick up. This is in honest **tension** with #5: avoiding a library
can mean writing bespoke code, which _adds_ code.

**Resolution — minimize total complexity (bespoke code + dependency weight):**

- Modern Node usually makes the bespoke alternative _tiny_ (parseArgs vs commander,
  ANSI vs chalk) → write the small code, skip the dep. Both #5 and #6 win.
- When an honest reimplementation would be **large or risky** (SigV4, multipart, SSO),
  the library wins. The AWS SDK is the worked example of #5 yielding to #6.

**Keep the count of functions and modules down.** Fewer named units = less surface
area to learn, the same instinct as preferring built-ins over deps. The bar for
extracting a function or a shared module is *reuse*, not tidiness:

- Extract a **function** when the code is actually reused. Don't split code out
  purely to give a block a name or to shorten a function — inline, locally-obvious code
  beats a one-call helper.
- Promote code into a **shared module** only once it's used by **more than one of the
  main command modules** (`src/commands/`). Until a second command needs it, let it live
  where it's used. (This is exactly how the existing core modules in `src/` earned their
  place.)

Where #2 protects the **format**, #6 protects the **tool**: transparent format +
transparent code = nothing about this project is a black box.

### 7. Plain JavaScript, typed via JSDoc

Source is plain JS; full type-checking comes from **JSDoc annotations +
`jsconfig.json`**, enforced in the editor. In the spirit of open & simple: no
build/transpile step for source — the code you read is the code that runs.

**Flagged for reconsideration:** the original draw of pure JS was avoiding a toolchain.
Node now runs TypeScript natively and non-experimentally, so that argument is much
weaker. JS for now, but this is an open question — parallel to the Temporal polyfill,
which modern Node _did_ make obsolete (it has since been removed): a stance modern Node
may likewise overtake.

---

## Architecture

### Entry point & command dispatch

[src/s3cab.mjs](src/s3cab.mjs) is the real entry point. The `commands` registry it drives
(an object keyed by command name; each command is `{ summary, args?, options?, exec }`)
lives in its own module, [src/commands.mjs](src/commands.mjs) — `s3cab.mjs` imports it and
owns only dispatch: `parseArgs` option merging, `allowNegative`/`allowPositionals`, and a
shared error handler, all driven off that registry. The help rendering — the `usage()`
generator and the `help <topic>` strings — lives in a third root module,
[src/help.mjs](src/help.mjs), keeping the entry point to control flow. `usage(commands, …)`
takes the registry as an argument (rather than importing it), so it's a pure, testable
function and `help.mjs` stays decoupled from the dispatcher.
Adding a command = adding one entry to `commands.mjs`. Debug output is gated by the **`S3CAB_DEBUG`
environment variable** (any non-empty value), not a CLI flag — it's a cross-cutting
concern, so it lives outside per-command option parsing and is merged into the options
bag passed to each command's `exec`.

**`--version` / `-v`** is the one other pre-dispatch global: handled before the command
lookup, it prints `package.json`'s `version` and exits. That version is the **single
source of truth** — imported via `import pkg from "../package.json" with { type: "json" }`,
which works from source (npm resolves `../package.json`) and is **inlined by esbuild** into
the SEA bundle, so the native binary reports the same number without reading a file at
runtime. The git tag is kept in lockstep by the release guard (and bumping via
`npm version <x>` edits `package.json` + tags atomically); docs avoid pinning the number
(README uses a live `img.shields.io/npm/v/s3cab` badge) so nothing drifts.

> Note: `package.json` `bin` (`s3cab`) points at `src/s3cab.mjs` — it carries a
> `#!/usr/bin/env node` shebang so it runs directly as the npm-installed command. There is
> deliberately **no `main`**: s3cab is a CLI, not a library, and `src/s3cab.mjs` is unsafe to
> `import` as one — it runs CLI logic (reads `process.argv`, may `process.exit`, dispatches a
> command) as a top-level side-effect. A library entry, if ever wanted, would be a separate
> side-effect-free re-export barrel pointing `main` at _it_, never at the CLI file; the
> per-command functions in `src/commands/` are already cleanly exported for that. The esbuild
> bundle (`dist/s3cab.js`) is _not_ referenced here either; it exists only as the SEA input
> (see Build → "npm package" for why npm ships source, not the bundle).

### Commands

The registry in [src/commands.mjs](src/commands.mjs) groups commands as **local snapshot**,
**remote backup**, and **diagnostics**. The local commands are **built**; the remote
ones (plus `status`/`verify`) are **registered stubs** — they appear in the CLI with
real args/options/help, but their `exec` calls the shared `notImplemented()` helper and
throws, pending the S3 milestone. Stubs carry `planned: true`, which `--help` renders as
`(not yet available)`. They're deliberately kept inline in the registry (not given their
own `src/commands/` files) until they gain real bodies — per #6, a file is earned by
logic, not reserved ahead of it.

`--help` (top-level lists commands; `<command> --help` prints that command's
args/options) and `--version` are handled pre-dispatch. **Each `exec` just calls its core
command function and returns that value as-is** (no per-command output formatting — the
execs stay one-liners); dispatch serializes the result to stdout with
`JSON.stringify(result, null, 2)` (a `undefined` result prints nothing). JSON is chosen
deliberately over `console.log(result)`: `console.log` routes a large array/object through
`util.inspect`, which **truncates** (`… N more items`) — fatal for a backup tool whose
whole job is "show me everything that changed" — whereas `JSON.stringify` serializes the
whole structure and handles every command's shape (array, object, string) uniformly, so
there is **no** bespoke result-printer to maintain (#6). The one deliberate exception is
`objects`, whose result is meant to be saved as a plain-hash lookup file: it writes its own
newline-delimited output and returns `undefined`, rather than emit a quoted JSON array.

**Stream discipline:** a command's _real output_ — results, `--version`,
and explicitly-requested `--help` — goes to **stdout**; everything else — progress,
warnings, and usage shown as part of an _error_ (bad args, unknown command) — goes to
**stderr**. So `s3cab tree . > files.txt` captures just the file list, and
`s3cab --help | less` works. This is why `usage()` _returns_ the help text rather than
printing it: the caller chooses the stream — `console.log` for an explicit help request,
`console.error` when the help is shown as part of an error — so the stream choice sits
visibly next to the other prints at the call site.

| Command | File | Status | Purpose |
| --- | --- | --- | --- |
| `snapshot` | snapshot.mjs | built | Walk → compute props → stream through zstd → write `<timestamp>.tsv.zst`; then diff against previous. |
| `list` | list.mjs | built | List snapshot names (sorted newest-first), or `--latest`. `--remote`/`-r` (list backed-up snapshots) throws — not yet implemented. |
| `compare` | compare.mjs | built | Diff two snapshots (`--since` older → `--until` newer) → added / moved / modified / deleted. Defaults: `until`=latest, `since`=the one before it, so bare `compare` shows recent changes. `--remote`/`-r` throws — not yet implemented. |
| `status` | _(inline stub)_ | stub | Show which snapshots are backed up and what a backup would upload (≈ `compare` of latest-local vs remote). |
| `setup` | _(inline stub)_ | stub | Set up a backup destination: prepare the remote bucket **and** link the local dir to it (one command, both halves). |
| `backup` | _(inline stub)_ | stub | Send a snapshot (manifest + missing objects) to the remote. |
| `restore` | _(inline stub)_ | stub | Granular restore from a backed-up snapshot (`[<path>...]`, `--snapshot`, `--output`). |
| `verify` | _(inline stub)_ | stub | Integrity check: every object a snapshot references exists remotely and hashes to its key. |
| `login` | login.mjs | experimental (Tier 2, AWS-only) | Optional AWS-CLI-replacement convenience — **not** the main auth path (most users use access keys via `.env`/a profile). AWS SSO/OIDC device-authorization login: registers (requesting the `refresh_token` grant), shows the URL+code, **polls** `CreateToken` until approved, then persists the session to `~/.s3cab/auth.json` (see `auth.mjs`). Prints only a non-secret summary. Deliberately frozen/rough: hardcoded start URL/region (`--start-url`/`--region` override) and first-account/first-role selection (not being built out). |
| `credential-process` | credential-process.mjs | experimental (Tier 2, AWS-only) | Optional companion to `login` (specs/auth.md). Emits the app-managed login's credentials as standard `credential_process` JSON (`Version`/`AccessKeyId`/`SecretAccessKey`/`SessionToken`/`Expiration`) on stdout — for users who wire s3cab into their own AWS profile as a credential helper. Reuses `resolveAppManagedAwsCredentials` (app-managed only, not the full chain); the dispatcher's stdout-JSON + stderr-for-everything-else gives the "never leak secrets to stderr" contract for free. |
| `objects` | objects.mjs | built | **Plumbing/diagnostic** (cf. git porcelain vs plumbing — not for everyday use). Lists a repository's stored object hashes, one sha256 per line, under the fixed `objects/` prefix (to `--file` or stdout). The intended consumer is `backup`, as a skip-the-upload lookup — hence the bare-hash output, the one command that opts out of the JSON dispatch (see above). Takes a plain `<bucket>` name (one repo == one bucket). |
| `upload` | upload.mjs | built | **Plumbing** — the write counterpart of `objects`. Hashes one file (reusing `prop`) and PUTs it at `objects/<sha256>` via `putFile` in [src/lib/s3.mjs](src/lib/s3.mjs); identical content maps to the same key, so it skips an object already present (`putFile`'s conditional PUT) unless `--force`/`-f`. The low-level building block under the not-yet-built snapshot-driven `backup`. **Planned (not yet wired, from the POC):** a `--if-modified-from <snapshot>` skip — see the TODO in `upload.mjs`, load-bearing for `backup`. |
| `tree` | tree.mjs | built | Recursively walk a dir; apply exclude globs; skip `.s3cab/`; report file paths and unsupported file types. |
| `prop` | prop.mjs | built | Compute `{ size, mtime, hash }` for one file (streaming hash for ≥5 MB). |

Naming decisions worth recording: the read commands (`list`, `compare`, `status`) take a
**`--remote`/`-r` flag** rather than separate `*-remote` verbs or a `remote` noun-group —
local and remote are the *same operation pointed elsewhere*, and a flag avoids a
two-level dispatcher (#6). The transfer verbs are **`backup`/`restore`** (not
`push`/`pull` or `upload`/`download`): the most domain-honest pair, and they avoid
implying the bidirectional *sync* that `push`/`pull` connote — s3cab is one-directional
archival. **Audience is ordinary, non-technical folks**, so user-facing names favour
consumer backup vocabulary over git/dev jargon — the setup command is **`setup`, not
`init`** for that reason. (Calls weighed but *kept* as-is: `--remote` over `--cloud`,
`verify` over `check`, and the dev-flavoured diagnostics `tree`/`prop` left alone.)
`login` (SSO) now exists as an **experimental** command — promoted from the POC to be
callable, but still rough (hardcoded start URL/region, first-account/first-role), and it
remains undecided whether s3cab keeps a bespoke SSO flow or leans on the standard AWS
credential chain instead. `compare` takes the two snapshots as
**`--since` (older) / `--until` (newer) options, not positionals**: a leading
defaultable `<dir>` positional would otherwise force `compare . <snap>` (you'd have to
type the dir to reach a snapshot positional), and `--since` reads naturally, fixes the
direction to old→new (like `diff`), and extends to dates later. Single-snapshot use is
deliberately "since X → latest" (the useful baseline case), not "X vs its predecessor".

**Argument validation lives in the command functions, not the dispatcher.** A command that
needs a positional checks it itself and throws `ParseArgsError` via `requireArg()`
([src/lib/error.mjs](src/lib/error.mjs)) — e.g. `objects`/`upload`/`prop` guard
`<bucket>`/`<file>`. This is deliberate: the per-command functions are the **library surface**
(cleanly exported, see Source layout), so a direct caller of `objects(bucket)` must get the
same guard a CLI user does — validation in the dispatcher would protect only the CLI path. A
registry-driven scheme (the dispatcher inferring required-ness from the `args` keys) was
considered and **rejected** for that reason, and because deriving required-ness by parsing
`<name>`/`[<name>]` display strings is stringly-typed and couples help formatting to
validation. The `args` keys are therefore **honest about optionality and nothing more**: a key
in `[brackets]` is optional, a bare `<name>` is required — and commands that default a missing
positional (`snapshot`/`list`/`compare`/`tree` all default `<dir>` to the current directory)
use `[<dir>]` so the generated usage text matches real behaviour. `usage()` just prints those
keys verbatim — it does not parse them.

### Source layout

`src/` keeps the **app-level shell** files at the root — [src/s3cab.mjs](src/s3cab.mjs) (the
CLI entry + dispatch), [src/commands.mjs](src/commands.mjs) (the registry that wires them
together), and [src/help.mjs](src/help.mjs) (the `usage()` renderer + `help` topics) — and
splits the rest into two **sibling** folders: [src/commands/](src/commands/) (one file per
command) and [src/lib/](src/lib/) (the shared core modules below). `help.mjs` is root, not
`lib/`, on purpose: it's bespoke CLI-shell glue tied to the registry shape, cohesive with the
entry + registry, not a reusable primitive like `format`/`read-lines`. The
sibling arrangement is deliberate: the shared modules are _depended on by_ the commands, so
they sit beside `commands/`, not stacked above it at the root. It's a taste-driven reorg, not
a functional need — so don't read the split as a hard layer boundary (e.g. `snapshot-file.mjs`
in `lib/` still imports `commands/prop.mjs`; that pre-existing coupling is fine). The grouping
is by **subsystem/cohesion, not by abstract layer** — there's deliberately no `lib/util/`
junk-drawer split of "generic helpers vs domain core"; if `lib/` ever grows enough to cleave,
extract a folder named for the subsystem (likely `lib/s3/` as the S3 milestone lands), and
leave the few generic leaves (`format`, `read-lines`, `error`) flat at `lib/` root.

> **No library entry yet.** There is deliberately no `src/index.mjs` barrel / `main` (see the
> "no `main`" note above). The per-command functions in `src/commands/` are already cleanly
> exported, so a re-export barrel is trivial to add the day a real library consumer appears —
> until then it would be speculative structure (#6).

### Core modules

- **[src/lib/snapshot-file.mjs](src/lib/snapshot-file.mjs)** — the snapshot format hub. Reads
  and writes manifests, handles zstd compress/decompress transparently, and provides
  `withSnapshotFile()` which writes to a temp file (`.snapshot.tsv.zst`) and atomically
  `rename`s it into place. The temp file's existence doubles as a crude concurrency
  guard against overlapping snapshots.
- **[src/lib/format.mjs](src/lib/format.mjs)** — human formatting via built-in `Intl`
  (`Intl.NumberFormat` compact bytes, `Intl.DurationFormat`). No dependency.
- **[src/lib/read-lines.mjs](src/lib/read-lines.mjs)** — read a text file into trimmed,
  comment-stripped, non-empty lines (used for the exclude file).
- **[src/lib/error.mjs](src/lib/error.mjs)** — `ParseArgsError` for usage-triggering failures.
- **[src/lib/s3.mjs](src/lib/s3.mjs)** — the **single module that imports the AWS S3 SDK**; all S3
  access goes through it. Its client is **lazily constructed** (`client()` builds the
  `S3Client` on first use), so commands that never touch S3 (`list`, `tree`, …) don't
  resolve AWS region/credentials and therefore don't fail when none are configured — even
  though every command shares the one entry point. That lazy boundary, plus keeping the one
  heavyweight dependency in a single place, is why this is a shared module despite thin
  usage today, overriding the usual "promote on the second caller" bar (#6). `objects` calls
  `listObjects` and `upload` calls `putFile`; the download/read-stream and bucket operations
  have **no caller yet** — deliberately promoted ahead of `backup`/`restore`/`setup`, and
  esbuild tree-shakes the unused ones out of the SEA bundle until a command imports them.
  **Provider-agnostic (Tier 1, see [specs/s3-provider-compatibility.md](specs/s3-provider-compatibility.md)):**
  a custom endpoint is first-class — `customEndpoint()` honours the SDK-native
  `AWS_ENDPOINT_URL_S3`/`AWS_ENDPOINT_URL`, and its presence is the single "not AWS" signal.
  Off-AWS, `client()` passes `endpoint` instead of the AWS-only `followRegionRedirects`, and
  `putFile` omits the AWS-only `StorageClass`/`ServerSideEncryption` (the `x-amz-meta-*`
  metadata is portable, so it always goes). `bucketPolicy` stays AWS-only and unused until
  `setup` is built.
- **[src/lib/auth.mjs](src/lib/auth.mjs)** — AWS **credential resolution** (the model is specified in
  [specs/auth.md](specs/auth.md)). Single source of truth for *how* s3cab gets credentials:
  `resolveCredentials` (the provider `s3.mjs` hands its client) tries, in order, a loaded
  `.env` → the **standard AWS SDK chain** (`fromNodeProviderChain`, the new
  `@aws-sdk/credential-providers` dep) → the **app-managed `s3cab login` cache**
  (`resolveAppManagedAwsCredentials`) → a clear, actionable error. `.env` is loaded with
  Node's native `process.loadEnvFile` — **no dotenv dep** (#5) — via `loadDotEnv`, which
  `s3.mjs` calls right before building the client. s3cab never writes `~/.aws/*`. **Status:**
  Phases 1–3 built. Phase 1 = the resolution chain (`.env` → standard chain → app-managed →
  actionable error), wired into `s3.mjs`. Phase 2 = the app-managed login cache: `login`
  performs the SSO device-auth flow and persists the session (registration + token + resolved
  account/role) to `~/.s3cab/auth.json` via `writeLoginCache`/`readLoginCache` (owner-only on
  POSIX; on Windows the file is user-profile-scoped, as Node ignores POSIX mode bits there).
  Phase 3 = `resolveAppManagedAwsCredentials` reads that cache, ensures a valid SSO access
  token (silently refreshing via the OIDC `refresh_token` grant + rewriting the cache when it
  nears expiry), and exchanges it for short-lived role credentials via `GetRoleCredentials`,
  returning **expiration-aware** creds so the SDK re-mints them on its own when they lapse. A
  missing cache throws a marked `NO_LOGIN` error → the full actionable message; a *present but
  unusable* session (expired, no/failed refresh) surfaces its **specific** reason instead.
  Phase 4 = the `credential-process` command ([src/commands/credential-process.mjs](src/commands/credential-process.mjs))
  reuses that same resolver to emit standard process-credential JSON. Phase 5 = the `help auth`
  topic + README + the actionable error. **Tiering (per
  [specs/s3-provider-compatibility.md](specs/s3-provider-compatibility.md)):** the `.env` +
  standard-chain + endpoint path is **Tier 1** — the portable core every S3-compatible provider
  can use. The bespoke SSO `login` + `credential-process` are **Tier 2** — an optional,
  **experimental, AWS-only** convenience (an AWS-CLI-replacement; `aws sso login` flows through
  Tier 1 via the standard chain too). Tier 2 is deliberately **frozen** — don't extend it (e.g.
  the "first-account/first-role" selection is intentionally *not* being built out); it can be
  kept, deferred, or dropped without affecting any non-AWS user.

  > Why a bespoke cache and not the SDK's native SSO cache: the JS SDK has **no public API**
  > for the interactive device-auth login (only the AWS *CLI* does), and its token cache path
  > is hardcoded to `~/.aws/sso/cache` (not redirectable). Wiring the standard chain to our
  > login would mean *our* code writing `~/.aws/config` + the token cache — exactly what the
  > spec forbids. So s3cab owns the storage and uses the SDK only for `GetRoleCredentials` /
  > `CreateToken` refresh.

### Key data-flow behaviours

- **Incremental hashing (lookup optimization).** `snapshot` reads the previous snapshot;
  for each file, if **size and mtime are unchanged**, it reuses the previous hash
  instead of re-reading and re-hashing the file. `--rehash` forces a full re-hash. This
  is the main performance lever. (The option is `rehash`, a plain positive flag —
  deliberately _not_ a `--no-lookup` negation: a camelCase `noLookup` key made the
  natural `--no-lookup` an unknown option, and `allowNegative` only negates the literal
  key.)
- **Streaming throughout.** `snapshot` is a `pipeline()` of async generators
  (`tree → progress → props → stringify → zstd → file`), so memory stays flat on huge
  trees. Files ≥ 5 MB are hashed via a stream rather than read whole.
- **Move/rename/duplicate detection via content hash.** `compare`/`diff` builds a
  hash→paths map of the previous snapshot, then classifies each current path:
  - _modified_ — same path, different hash
  - _moved_ — a deleted path's hash reappears at a new path (`→` = rename in same dir,
    `→→` = moved across dirs)
  - _added_ — genuinely new (records `==` duplicates if the content already existed)
  - _deleted_ — previous path absent and not matched as a move
- **Resource management** uses `await using` / `Symbol.dispose` for file handles and
  progress indicators.

---

## Data model & formats

### On-disk layout (per backed-up directory)

```
<dir>/.s3cab/
  exclude.txt                  # exclude globs (optional)
  snapshots/
    2025-11-10T2104.tsv.zst    # one immutable snapshot per run, zstd-compressed
    2025-11-11T0830.tsv.zst
```

- Snapshot name is a timestamp `YYYY-MM-DDTHHMM` (the `:` is stripped). Newest-first
  ordering is lexical on the name.
- The reader accepts a bare `.tsv` or `.tsv.zst` (or extensionless) name, so an
  uncompressed manifest can be dropped in for inspection. With `S3CAB_DEBUG` set,
  `snapshot` also writes a decompressed `.snapshot.tsv` alongside for transparency.

### Snapshot line format (TSV)

```
<hash>\t<size>\t<mtime>\t<path>
```

- `hash` — **SHA-256 in lowercase hex** (64 chars). Empty-file hash is the well-known
  `e3b0c4…b855`. (Base64url was an abandoned space-saving experiment — 43 chars vs 64 —
  dropped because the gain is negligible once the manifest is zstd-compressed, and hex
  is more recognizable and hand-recoverable, per #2.)
- `size` — bytes, right-aligned to width 10.
- `mtime` — ISO-8601 to ms, width 24.
- `path` — absolute path, unlimited length, **last** so alignment survives.
- **Comment / metadata lines** begin with `#`:
  - `#SNAPSHOT` — header line (carries the snapshot's dir + timestamp).
  - `#EXCLUDED` — a path skipped by an exclude rule or an unsupported file type
    (records which pattern matched).
  - `#<error message>` — a per-file error (e.g. unreadable file) recorded inline rather
    than aborting the whole snapshot.

> **Edge case to handle before release:** a path containing a literal tab or newline
> would break a line. Needs a documented rule (reject / encode / comment).

### Exclude globbing

Documented in [doc/exclude.md](doc/exclude.md); implemented in
[src/commands/tree.mjs](src/commands/tree.mjs) (`createMatcher`). Globs are translated
to `RegExp` (using `RegExp.escape`, Node 24+):

- `/` is always the path separator (Windows `\` is normalized to `/` for matching).
- `*` — one or more chars within a single segment.
- `**/` — zero or more whole segments.
- `?` — a single char.
- Case-insensitive matching on Windows (`win32`), case-sensitive elsewhere.
- `.s3cab/` is always skipped by the walker.

### Intended S3 layout (target, not yet implemented)

**One s3cab repository == one bucket**, with a fixed, well-known structure at the bucket
root — _not_ an arbitrary prefix within a shared bucket. The fixed layout is what lets a
tool (or a person) find everything by convention alone (#2): objects always live under
`objects/`, snapshots under `snapshots/`.

```
s3://<bucket>/
  objects/<sha256>            # immutable content-addressed blobs
  snapshots/<set>/<timestamp>.tsv[.zst]
```

This is the design intent carried over from the early notes. The `objects` command already
reads `objects/` per this layout, and `upload` writes a single blob to it; the
snapshot-driven `backup` that populates `snapshots/` is the remaining piece.
remaining piece.

---

## Build → native executable (the non-obvious parts)

> The exact npm scripts live in [package.json](package.json) and aren't repeated here.
> This section records only the _why_.

The distribution goal is a **single native executable** — a user shouldn't need Node
installed to run s3cab. Producing it is two steps:

1. **Bundle** (`npm run build`): a one-line **esbuild** invocation (the `build` script in
   [package.json](package.json), calling esbuild's CLI directly — no wrapper script) bundles
   the ESM source (entry: `src/s3cab.mjs`) into one **ESM** file, `dist/s3cab.js`. esbuild is
   invoked **bundle-only** — `--bundle`, no `--target`/`--minify`, so it inlines imports
   without down-levelling or otherwise rewriting the JS; the output is the same modern syntax
   that runs from source. The `#!/usr/bin/env node` shebang lives in the entry source
   (`src/s3cab.mjs`, so that file _also_ works as the npm `bin` — see "npm package" below);
   esbuild **preserves an entry point's shebang** into the bundle, so no banner is needed (a
   banner would duplicate it, and a second `#!` line is a syntax error). `--external:aws-crt`
   keeps the AWS SDK's optional native addon out of the bundle. esbuild exists purely because
   SEA needs a **single standalone file** (a SEA main may only `import`/`require` built-ins,
   not other files) — _not_ to convert module format. The bundle is a generated, gitignored
   artifact. (The CLI defaults to `--log-level=info`, so the build still prints the output
   path + size; it exits non-zero on failure for free — which is why the old `build.cjs`
   wrapper, a CommonJS file just to set those, was dropped.) `npm run clean` removes the
   bundle and every other build/test artifact; it delegates to `git clean -fdX` rather than
   listing paths, so it stays in sync with `.gitignore` for free and needs no `rimraf`-style
   dep (#5) and works on Windows (the primary target). `clean:dry` (`-n`) previews first —
   worth it because `-X` also wipes _all_ ignored files — including `node_modules/` (so a
   reinstall follows), `.claude/settings.local.json`, `.env`, and dogfood snapshots under
   `/.s3cab/snapshots/`. Full clean by design. Note `git clean -e <pattern>` can _not_ spare a
   specific file here: `-e` only **adds** patterns to the ignore set, and under `-X` (remove
   ignored) that makes a file _more_ likely to be deleted, not less (verified). The only way
   to keep an ignored file across a clean is to stop ignoring it (a `!`negation in
   `.gitignore`), which then makes it show as untracked — not worth it for a personal/local
   file, so the clean stays a true reset-to-fresh-checkout.
2. **Package** (`node --build-sea=sea/<target>.json`, Node ≥ 26) embeds the bundle into a
   copy of the node binary and writes the executable in one step — no `postject`, no extra
   dependency. The per-target configs live in [sea/](sea/) and are **static, committed
   JSON** (not generated): they differ in exactly one field, `output` — and even that only
   by extension (`dist/s3cab.exe` on Windows, `dist/s3cab` elsewhere). The binary is
   deliberately just **`s3cab`** on every platform; the per-platform tag belongs on the
   _release archive_, not the executable (see Releases). Each config sets
   `"mainFormat": "module"`, which is what lets SEA run an **ESM** main (without it SEA
   defaults to CommonJS and rejects the `import` syntax; caveat: it can't be combined with
   `"useSnapshot"`). They deliberately **omit `executable`**, so SEA injects into the node
   _running_ `--build-sea` — i.e. you always get a native binary for the host you build on.

**Build model: each OS builds its own binary; no cross-compilation.** `--build-sea` _can_
cross-inject (its `executable` field plus an injector that understands ELF / Mach-O / PE),
but a binary built for another OS can't be run or smoke-tested where it's built, and mac
binaries built off-Mac can't be codesigned (so won't launch). So we don't: the local
`npm run build:win` / `npm run build:linux` build those targets from their static
[sea/](sea/) configs (`sea/win-x64.json` / `sea/linux-x64.json`; Windows is the primary
dev target — on another OS run `node --build-sea=sea/<your-target>.json` directly after
`npm run build`), and the full matrix is built in CI.

**Releases** ([.github/workflows/release.yml](.github/workflows/release.yml)) build each
platform **natively on its own runner**: `setup-node` provisions the pinned node (so the
"base binary must match the running node version" rule holds by construction — that node is
both builder and base), the job runs `--build-sea=sea/<target>.json`, and the macOS runner
signs with the real `codesign`. The bare `s3cab[.exe]` is then wrapped in a per-platform
**archive** — `s3cab-<target>.tar.gz` everywhere, `s3cab-win-x64.zip` on Windows — so the
four release assets don't collide while the binary _inside_ stays plainly `s3cab`. (Bonus:
the archive roughly thirds the ~100 MB download.) A `v*` tag publishes a GitHub Release via
the `gh` CLI (no marketplace actions beyond the official `actions/*`), attaching a
`SHA256SUMS` file so downloads are verifiable — apt for a SHA-256-addressed tool — and
marking `v0.x`/`-alpha` tags `--prerelease`. Node provisioning is thus the pipeline's job —
there is no longer any in-repo node-download/checksum/extract step.

**A fifth release asset — the portable Node bundle.** Alongside the four native binaries,
the `bundle` job ships the esbuild bundle (`dist/s3cab.js`) itself as a release asset: the
same single ESM file that feeds SEA, but run directly with `node s3cab.js`. It's the
**any-platform, bring-your-own-Node** channel — built **once** (the bundle is
platform-independent, so no matrix) and uploaded **un-archived** (it's a tiny self-contained
script, not a ~100 MB binary, and won't name-collide with the `s3cab-<target>` archives). It
carries the entry's `#!/usr/bin/env node` shebang, so on unix it's directly executable. This
is a third distribution channel, parallel to the native binaries and the npm package — and
note the bundle is now built in CI for _two_ reasons (SEA input **and** a shipped asset),
where before it was purely SEA's single-file input.

**glibc floor — the Linux build targets pin `ubuntu-22.04`, not `-latest`.** A native
binary links against the _builder's_ glibc, so building on 24.04 would refuse to start on
older distros (`GLIBC_2.3x not found`); 22.04 (glibc 2.35) widens the supported floor while
still meeting Node 26's own glibc minimum. This applies only to the **build** matrix — the
test/release jobs stay on `-latest`, since glibc only constrains the artifact we _ship_.

This is the **`pkg` → native SEA migration** (per #3/#5) now done: `pkg` is gone, and the
in-philosophy native tooling produces the binary. esbuild stays only as long as Node needs
a separate single-file bundling step; if Node gains native multi-file SEA, esbuild can go too.

**CI vs release — two workflows, deliberately split.**
[.github/workflows/ci.yml](.github/workflows/ci.yml) is the everyday gate: lint +
test on every push to `main` and every PR. Tests run a **three-OS matrix**
(ubuntu/windows/macos) because the code genuinely branches on platform
(case-insensitive glob matching on `win32`, `\`→`/` normalization, `.exe`/zstd
handling) — a Linux-only run wouldn't exercise those paths; lint runs once (it's
OS-independent). `release.yml` deliberately does **not** trigger on branches/PRs (only
`v*` tags + manual dispatch), so CI is what keeps the tree green between releases; the
release workflow keeps its own single-OS lint+test gate to re-check the one commit CI
doesn't see — the tag. Both pin the same `NODE_VERSION` and default to
`permissions: contents: read` (the release job alone opts up to `contents: write`).

**Dependency updates — Dependabot, not Renovate** ([.github\dependabot.yml](.github\dependabot.yml)).
Native to GitHub and zero extra accounts/config, so it fits #5/#6 where Renovate's extra
machinery would be over-engineering for a ~5-line dependency surface. **Weekly version
updates, grouped on purpose:** the five `@aws-sdk/*` packages version in lockstep and publish
near-daily, so an ungrouped config would flood the PR queue — they're one group; dev deps are
a second; the `github-actions` ecosystem is covered too (keeps the pinned `actions/*` /
`setup-node` current). CI gates every PR. The **security** half — vulnerability + malware
alerts and immediate security PRs — is enabled in repo _settings_ (UI-only, can't live in the
file): the YAML is scheduled freshness, the settings are CVE-driven reaction. Auto-merge of
green patch/minor PRs is deliberately **not** enabled yet (a "robot merges to `main`" trust
call to revisit once the cadence is observed).

**npm package — ships source, not the bundle.** There are now three distribution channels —
the native binaries, the portable `dist/s3cab.js` bundle (both above), and the npm package —
and the npm one has **opposite** needs to the bundle. npm installs a file tree and lets Node
resolve imports across files, so the npm package ships the plain `src/` modules and points
`bin` at `src/s3cab.mjs` directly — **no bundle, no build step on publish.** (Shipping
readable source rather than an opaque blob is also the #2/#7 choice: the code you install is
the code that runs.) The bundle is _not_ what npm ships — it exists for SEA's single-file
constraint and, now, as the portable release asset. Consequences worth knowing:

- The `files` allowlist uses **negation** (`"!src/**/*.test.mjs"`) to keep the co-located
  tests out of the tarball. Verify with `npm pack --dry-run` after touching it — that's the
  source of truth (currently 21 files).
- The **AWS SDK is a normal npm `dependency`** here (npm installs it). In the SEA channel
  the _same_ dep is instead inlined into the bundle (`aws-crt` left external → JS fallback).
  One dependency, two fates. NB: the production CLI now imports it from exactly one module,
  `src/lib/s3.mjs` (used so far by `objects` and `upload`); the download/restore path is still to
  come, so much of the SDK's surface is still unused until the rest of the S3 milestone lands —
  and it bloats the SEA binary as soon as it's imported at all.
- **Publishing** is the `publish-npm` job in `release.yml` (tag-gated, parallel to the
  binary `release` job). It uses npm **Trusted Publishing** — the job authenticates to the
  registry via its **OIDC** token (`id-token: write` + a public repo), so there is **no
  long-lived `NPM_TOKEN` secret** at all; provenance attestation is produced automatically
  (no explicit token in the publish step fits #2). This needs a one-time **trusted
  publisher** configured for the `s3cab` package on npmjs.com (publisher: GitHub Actions,
  repo `allens/s3cab`, workflow `release.yml`), and npm ≥ 11.5.1 — so the job refreshes npm
  (`npm install -g npm@latest`) before publishing, since Node's bundled npm may predate OIDC
  support. A guard fails the job if the `v*` tag doesn't equal `package.json` `version`.
  **dist-tag logic differs from
  the GitHub-release prerelease rule on purpose:** only a semver-prerelease tag
  (`v*-alpha.N`) goes to npm's `next`; a plain `v0.x` publishes to `latest` (the default
  `npm install`).

Tests deliberately use the built-in `node:test` runner with no framework (see #5).

---

## Formatting, line endings & tooling (the non-obvious why)

- **Line endings are normalised to LF via [.gitattributes](.gitattributes)**
  (`* text=auto eol=lf`). This is deliberate and load-bearing: the working tree is LF on
  every platform, so Prettier's default `endOfLine` is satisfied with **no `.prettierrc`
  needed**. Beware the Windows trap that motivated it — PowerShell's `>` / `Out-File`
  (and some editors) emit **UTF-16 + CRLF**; `.nvmrc` had silently become UTF-16 this way,
  which `nvm`/`fnm` can't parse. Author dotfiles as plain UTF-8/ASCII with LF.
- **Prettier formats code only; Markdown is excluded** ([.prettierignore](.prettierignore)).
  Its prose-emphasis restyle (`*x*` → `_x_`) and table-cell padding add churn and make the
  frequently AI-edited CLAUDE.md tables fragile to edit, for no real gain (`proseWrap`
  doesn't reflow prose). ESLint defers to Prettier (`eslint-config-prettier`) and **ignores
  generated build artifacts** (`build/`, `coverage/`, `dist/`) — otherwise it lints
  the bundled output.
- **Don't bury `await` inside a larger statement** (a compound `if`/`while` condition, a
  ternary, a call argument). Await into a named local on its own line first, then use it:
  `const exists = await objectExists(uri); if (exists) …`, not
  `if (… && (await objectExists(uri)))`. The suspension point stays visible and the value
  gets a name. Neither Prettier nor ESLint enforces this — it's a house style. (When the
  inline form was guarding a short-circuit, a nested `if` preserves the same conditional
  evaluation without the inline await.)
- **`.gitignore` ignores the repo's own snapshot output with a root-anchored
  `/.s3cab/snapshots/`**, so committed test fixtures under
  `test/fixtures/**/.s3cab/snapshots/` stay tracked. Don't broaden it to `**/.s3cab/`.
- **The repo dogfoods itself:** the root [.s3cab/exclude.txt](.s3cab/exclude.txt) is a real
  exclude config (node_modules, .git, build output…), so `s3cab tree .` / `snapshot .`
  works on the repo itself. Exclude behaviour is covered by
  [src/commands/tree.test.mjs](src/commands/tree.test.mjs); end-to-end CLI behaviour by
  [test/e2e.mjs](test/e2e.mjs), which spawns `node src/s3cab.mjs` as a subprocess.
- **Test layout convention:** unit tests are **co-located** with their source as
  `*.test.mjs`; [test/](test/) holds only cross-cutting tests (`e2e.mjs`) and shared
  `fixtures/`. See [test/README.md](test/README.md). Node's runner executes **every**
  `*.{js,mjs,cjs}` under a `test/` dir (not just `*.test.*`), so keep non-test `.mjs`
  (scratch scripts, shared helpers) **out** of `test/` or they run as phantom empty tests —
  scratch and throwaway experiments go in [scripts/](scripts/), and a test's shared helper
  lives beside the test that uses it.

---

## Known gaps & cleanup items

Pre-release housekeeping and open decisions surfaced from the code:

- **Snapshot-driven backup/restore flow not built yet.** The object-store plumbing works —
  `objects` lists stored hashes and `upload` PUTs a single file at `objects/<sha256>`, both via
  the [src/lib/s3.mjs](src/lib/s3.mjs) SDK boundary — but the snapshot-driven `backup` that uploads a
  whole manifest's worth of objects, the remote-snapshot wiring under `snapshots/`, and the
  download/`restore` path don't exist (the read-stream/bucket ops in `src/lib/s3.mjs` still have no
  caller). `upload` also still owes its **`--if-modified-from <snapshot>` skip** — the
  snapshot-aware "only upload what changed" optimization `backup` is built on, carried over from
  the POC but not yet wired (see the TODO in [src/commands/upload.mjs](src/commands/upload.mjs)).
  SSO login has been promoted to an experimental `login` command (still hardcoded —
  see its TODOs). The old `src/_poc/` sandbox has been **retired** — its last occupant became
  the `upload` command — so future scratch/experiments go in [scripts/](scripts/), not a parked
  sandbox under `src/`. The **CLI surface is scaffolded ahead of the rest**:
  `setup`/`backup`/`restore`/`status`/`verify` are inline stubs and `--remote` is wired onto
  `list`/`compare`, all throwing `notImplemented()` for now (see the Commands table); promote
  each stub into its own `src/commands/` file as it gains a real body.
- **Native-executable packaging works and is validated on real runners.** `npm run
  build:win` / `npm run build:linux` build those binaries from their static [sea/](sea/)
  configs, and CI ([.github/workflows/release.yml](.github/workflows/release.yml)) builds
  every platform natively on its own runner (the `pkg` → SEA migration is done;
  cross-compilation from one host was deliberately dropped — see Build). The full matrix has
  now run for real (a `workflow_dispatch` dry-run plus the `v0.0.1-rc.1` and `v0.0.1` tags):
  all four binaries build, smoke-test, and archive, and the macOS ad-hoc sign + npm publish
  + GitHub Release all succeed. Open items:
  - **macOS notarization — deliberately skipped (costs money).** CI ad-hoc-signs the mac
    binary, enough to _run_; Gatekeeper-clean _distribution_ would need a paid Apple
    Developer ID + notarization, which we're not doing. Browser-downloaded copies hit a
    quarantine warning; the README documents the `xattr -dr com.apple.quarantine` workaround
    (and that `curl`/`npm`/bundle installs avoid it). A local mac build is likewise unsigned
    until you `codesign` it (or use `rcodesign`).
  - **macOS is labelled `macos`, not `darwin`,** in the release-asset + `sea/` config names
    (friendlier on a download), even though `process.platform` is `darwin` — `test/e2e.mjs`
    maps the one to the other.
  - **Only `macos-arm64` ships** — no Intel `macos-x64` build, on purpose: Intel Macs are
    legacy and those users can still use `npm` or the portable bundle. Adding it later is a
    `sea/macos-x64.json` + one `macos-13` (Intel) matrix row.
  - **Drop esbuild** if Node ever bundles multi-file SEA inputs natively.
- **"Latest snapshot uncompressed"** currently only happens behind `S3CAB_DEBUG`. Decide
  whether keeping the latest manifest uncompressed for transparency is a real feature.
- **`tsc -p jsconfig.json` is not clean.** Most noise is _outside_ the shipping code — loose
  scratch files under [scripts/](scripts/) and JS pulled in transitively from the AWS SDK
  under `node_modules/` — so a type check is read by filtering to `src/`. But `src/` itself is
  **not** fully clean either: [src/commands/login.mjs](src/commands/login.mjs) still carries
  pre-existing errors (promoted-from-POC code that never got a typing pass). A typing pass over
  it would let a filtered `src/` check gate cleanly. ([src/lib/s3.mjs](src/lib/s3.mjs) was the
  other such file — its `getMetadata` errors are gone now that the dead metadata-parsing was
  collapsed into a boolean `objectExists` probe. The retired `_poc` sandbox used to be the bulk
  of this noise; it is gone.)
- **Revisit plain-JS-vs-TypeScript** now that Node runs TS natively (per #7).
- **Concurrency guard** for snapshots is only the temp-file check; a proper lock file is
  a `TODO` in [src/commands/snapshot.mjs](src/commands/snapshot.mjs).
- **Fix typos** in [doc/exclude.md](doc/exclude.md).
- **Define behaviour** for paths containing tabs/newlines in the TSV (see above).
- **Re-measure the slurp/stream hash boundary** in [src/commands/prop.mjs](src/commands/prop.mjs)
  during any future perf/test pass. Files `>= 5_000_000` bytes stream through `streamHash`;
  smaller ones slurp via one-shot `crypto.hash`. The 5 MB cutoff was chosen empirically on real
  data and looked good, but predates the one-shot-hash path, so the optimum may have moved. Note
  `streamHash` now reads at Node's default `highWaterMark` (64 KiB) — the old explicit 8 MB buffer
  was dropped as a pre-one-shot-hash relic with no measured benefit for SHA-256.

### [src/s3cab.mjs](src/s3cab.mjs) — deferred review observations

Open items from a review pass over the entry point. None block use; roughly ordered by
impact. (Already done: the error-path collapse, `errorHandler` inlining, `--debug` →
`S3CAB_DEBUG` env var, the malformed `@typedef` fixes, the global `--version`, terminal
output via `JSON.stringify` to stdout (never truncated, unlike `console.log`) with each
`exec` returning its core function's value unmodified, and top-level + per-command `--help`
— `usage()` now renders short-less options correctly and top-level help marks stub
commands `(not yet available)`.)

- **Help — remaining gaps.** Per-command `usage()` doesn't list the universal
  `--help`/`--version`, and nothing documents the global `S3CAB_DEBUG` env var.
- **Import side-effect / testability.** The registry (`commands.mjs`) and the help renderer
  (`help.mjs`, with its pure `usage(commands, …)`) now live in their own import-safe modules,
  so both are unit-testable on their own — which was the original motivation for an
  `import.meta.main` guard. `s3cab.mjs` itself still runs dispatch as a top-level side-effect
  and so can't be `import`ed, but it no longer `export`s anything to test; its behaviour is
  covered by [test/e2e.mjs](test/e2e.mjs). If the dispatch flow ever needs unit testing,
  guard the run block with `if (import.meta.main)`.
- **Consistency nits:** `tree`/`list` mark their `exec` arrows `async` while the others
  don't (none need to — `exec` is always awaited); the commented-out `SIGINT` handler at
  the bottom is dead code — wire up or delete (per #6). (Resolved: `compare`'s bare arg
  keys — it now takes `<dir>` + `--since`/`--until` options; `tree`'s empty `options: {}`.)
