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

The split itself: **README.md** and **[doc/](doc/)** are user-facing (what it is, why,
status, commands, install/usage, user-level reference like `doc/exclude.md` — examples use
Windows paths, the primary target; note `doc/` ships to users in the npm tarball).
**CLAUDE.md** is for contributors/AI (the design philosophy below, architecture decisions,
conventions, and the pre-release TODO list). User docs describe the *contract*, not the
internals — e.g. `doc/exclude.md` says which separators you may write in a pattern, while
the normalize-to-`/` matching machinery is documented where it lives, in
`src/commands/tree.mjs`.

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
6. **Don't delete commented-out code or TODO notes as "dead code" without asking.** They may
   be the user's parked reminders of an unresolved question, not cruft — e.g. the
   commented-out SIGINT handler in `src/s3cab.mjs` and the `objectPaths.delete` note in
   `src/commands/compare.mjs` are kept on purpose. Flag them as candidates instead.

---

## What this project is

**s3cab** = **S3 C**ontent **A**ddressable **B**ackup. [README.md](README.md) covers what
it is, why, what works today, and what's coming — not repeated here. Treat the README's
S3/backup descriptions as the _target_; treat `src/` as _what works now_. Two notes the
README and code don't carry:

- **Scratch and throwaway experiments go in [scripts/](scripts/)** — never a parked sandbox
  under `src/` (the old `src/_poc/` folder is retired) and never under `test/` (see the
  test-layout convention below).
- **A bespoke SSO `login` command was built and deliberately removed** (2026-06), along with
  its `credential-process` companion and the `~/.s3cab/auth.json` session cache — see the
  History note in [specs/auth.md](specs/auth.md) for the full rationale. **Don't rebuild
  it:** interactive sign-in is the AWS CLI's job; s3cab consumes the session via the
  standard credential chain. The planned alternative for long-lived keys (the real gap,
  mainly non-AWS providers) is an optional **OS secure-storage** layer (DPAPI / Keychain /
  libsecret — likely via OS CLIs, no native dep, per #5), slotting into `resolveCredentials`
  as another source.

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

Snapshots are tab-separated values. This flows directly from #2. (The format spec lives
at the top of [src/lib/snapshot-file.mjs](src/lib/snapshot-file.mjs); the README shows the
user-visible layout.) The reasoning:

- **Editor-readable.** Fixed-width leading columns scan cleanly even unaligned —
  fixed-width fields first (`hash` → `size` → `mtime`), variable-length `path` **last**,
  so the left edge stays aligned and the ragged part is pushed right.
- **Opens cleanly in Excel** (treated as an "open enough" standard) → instant
  sort/filter/pivot over a backup manifest. (Caveat: don't let Excel re-save and mangle
  it.)
- **TSV > CSV > JSON** for this job: tabs almost never occur in real paths, so we avoid
  CSV's comma-quoting _and_ JSON's escaping — notably JSON would force escaping every
  Windows backslash (`C:\\Users\\...`). Less escaping = more directly recoverable.
- **Hashes are lowercase hex, not base64url.** Base64url was an abandoned space-saving
  experiment (43 chars vs 64) — dropped because the gain is negligible once the manifest
  is zstd-compressed, and hex is more recognizable and hand-recoverable, per #2.

> **Edge case to handle before release:** a path containing a literal tab or newline
> would break a manifest line. Needs a documented rule (reject / encode / comment).

### 5. Built-ins over dependencies (high bar for libraries)

Prefer Node/JS built-ins. The bar to add a third-party dependency is high, and applies
to **runtime deps, CLI ergonomics, and dev tooling** alike:

- Arg parsing → Node's `node:util` **`parseArgs`**, _not_ commander.
- Terminal output → plain ANSI / `process.stderr`, _not_ chalk.
- Tests → Node's built-in **`node:test`** runner, _not_ Jest (especially) or Vitest.
  This is a deliberate choice; contributors should **not** introduce a test framework.

**Permitted runtime dependencies are exactly two kinds:**

1. **Genuinely too big to hand-craft** → the **AWS SDK** (SigV4, multipart, the credential
   chain). This is _the_ sanctioned exception; reimplementing it by hand would be absurd.
2. **Polyfills of actual standards**, accepted _temporarily_, removed the moment the
   native version ships. Filling a standards gap is fine; reaching for a convenience lib
   is not. There are currently **none**: `@js-temporal/polyfill` was the worked example,
   and it was duly dropped once native `Temporal` landed in the target Node (≥26.3.0) —
   `Temporal` is now used as a global. The AWS SDK is therefore the only runtime dep.

**Dev dependencies get a more relaxed bar** — they never ship to users and don't affect
recoverability. The notable one is **esbuild**, used only to bundle the ESM source into
a single ESM file for native-executable packaging (see Build). Even here
the same instinct applies: it exists to bridge a gap (SEA needs one standalone file),
and Node's growing native capabilities may remove the need for it over time.

### 6. Minimal, simple code

Code should be as **small and low-surface-area** as possible — easy for a newcomer (or
future maintainer) to pick up. This is in honest **tension** with #5: avoiding a library
can mean writing bespoke code, which _adds_ code.

**Resolution — minimize total complexity (bespoke code + dependency weight):**

- Modern Node usually makes the bespoke alternative _tiny_ (parseArgs vs commander,
  ANSI vs chalk) → write the small code, skip the dep. Both #5 and #6 win.
- When an honest reimplementation would be **large or risky** (SigV4, multipart, the
  credential chain), the library wins. The AWS SDK is the worked example of #5 yielding
  to #6.

**Keep the count of functions and modules down.** Fewer named units = less surface
area to learn, the same instinct as preferring built-ins over deps. The bar for
extracting a function or a shared module is *reuse*, not tidiness:

- Extract a **function** when the code is actually reused. Don't split code out
  purely to give a block a name or to shorten a function — inline, locally-obvious code
  beats a one-call helper.
- Promote code into a **shared module** only once it's used by **more than one of the
  main command modules** (`src/commands/`). Until a second command needs it, let it live
  where it's used. (This is exactly how the existing core modules in `src/lib/` earned
  their place. The one deliberate exception: `s3.mjs` was promoted *ahead* of its second
  caller, because keeping the heavyweight AWS SDK behind a single lazy boundary matters
  more than the promotion bar — and its not-yet-called operations are tree-shaken out of
  the SEA bundle until a command imports them.)

Where #2 protects the **format**, #6 protects the **tool**: transparent format +
transparent code = nothing about this project is a black box.

### 7. Plain JavaScript, typed via JSDoc

Source is plain JS; full type-checking comes from **JSDoc annotations +
`jsconfig.json`**, enforced in the editor (and runnable as a whole-project check — see
`package.json`). In the spirit of open & simple: no build/transpile step for source —
the code you read is the code that runs.

**Flagged for reconsideration:** the original draw of pure JS was avoiding a toolchain.
Node now runs TypeScript natively and non-experimentally, so that argument is much
weaker. JS for now, but this is an open question — parallel to the Temporal polyfill,
which modern Node _did_ make obsolete (it has since been removed): a stance modern Node
may likewise overtake.

---

## Architecture decisions

What follows is the *why* behind the structure; the *what* is best read from the code
itself ([src/s3cab.mjs](src/s3cab.mjs) is an ~80-line entry point, the registry in
[src/commands.mjs](src/commands.mjs) is the command list, and each command file carries
its own doc comment).

### Dispatch & CLI shell

- **Adding a command = adding one entry to the registry.** Stubs for unbuilt commands are
  kept *inline* in the registry (not given their own `src/commands/` files) until they gain
  real bodies — per #6, a file is earned by logic, not reserved ahead of it. They carry
  `planned: true`, which help renders as `(not yet available)`.
- **Debug output is gated by the `S3CAB_DEBUG` env var, not a CLI flag** — it's a
  cross-cutting concern, so it lives outside per-command option parsing and is merged into
  the options bag passed to each `exec`.
- **Results are serialized with `JSON.stringify`, never `console.log`:** `console.log`
  routes large structures through `util.inspect`, which **truncates** (`… N more items`) —
  fatal for a backup tool whose whole job is "show me everything that changed". One uniform
  serializer also means no bespoke per-command printer to maintain (#6). The one deliberate
  exception is `objects` (bare hash-per-line output — see its doc comment).
- **Stream discipline:** a command's _real output_ — results, `--version`, explicitly
  requested `--help` — goes to **stdout**; everything else — progress, warnings, usage
  shown as part of an _error_ — goes to **stderr**. So `s3cab tree . > files.txt` captures
  just the file list and `s3cab --help | less` works. This is why `usage()` _returns_ text
  rather than printing it: the caller chooses the stream, visibly, at the call site.
- **There is deliberately no `package.json` `main` and no `src/index.mjs` barrel:** s3cab
  is a CLI, not a library, and the entry point runs dispatch as a top-level side-effect
  (unsafe to `import`). The per-command functions in `src/commands/` are already cleanly
  exported, so a side-effect-free re-export barrel is trivial to add the day a real library
  consumer appears — until then it would be speculative structure (#6). (If the dispatch
  flow itself ever needs unit testing, guard the run block with `if (import.meta.main)`;
  today [test/e2e.mjs](test/e2e.mjs) covers it as a subprocess.)
- **`--version` is the single source of truth chain:** `package.json` `version` → imported
  as a JSON module → inlined by esbuild into the SEA bundle, so the native binary reports
  the same number without reading a file at runtime. The release guard keeps the git tag in
  lockstep; docs avoid pinning the number (README uses a live npm badge) so nothing drifts.

### Argument validation lives in the command functions, not the dispatcher

A command that needs a positional checks it itself (`requireArg()` →
`ParseArgsError`). This is deliberate: the per-command functions are the **library
surface**, so a direct caller of `objects(bucket)` must get the same guard a CLI user
does — validation in the dispatcher would protect only the CLI path. A registry-driven
scheme (the dispatcher inferring required-ness from the `args` keys) was considered and
**rejected** for that reason, and because deriving required-ness by parsing
`<name>`/`[<name>]` display strings is stringly-typed and couples help formatting to
validation. The `args` keys are therefore **honest about optionality and nothing more** —
`[brackets]` = optional, bare `<name>` = required — and `usage()` prints them verbatim,
never parses them. The same reasoning puts **env-file loading in the command functions**
(each calls `loadEnv` for its scope right after validating args): a direct library caller
resolves env exactly as the CLI does, and `s3.mjs` stays a pure SDK boundary that only
reads `process.env`.

### Naming decisions (weighed on purpose — don't re-litigate casually)

**Audience is ordinary, non-technical folks**, so user-facing names favour consumer
backup vocabulary over git/dev jargon:

- The read commands (`list`, `compare`, `status`) take a **`--remote`/`-r` flag** rather
  than separate `*-remote` verbs or a `remote` noun-group — local and remote are the *same
  operation pointed elsewhere*, and a flag avoids a two-level dispatcher (#6).
- The transfer verbs are **`backup`/`restore`** (not `push`/`pull` or
  `upload`/`download` at the porcelain level): the most domain-honest pair, avoiding the
  bidirectional *sync* connotation of `push`/`pull` — s3cab is one-directional archival.
- The setup command is **`setup`, not `init`** (consumer vocabulary).
- Calls weighed but *kept* as-is: `--remote` over `--cloud`, `verify` over `check`, and
  the dev-flavoured plumbing/diagnostics `objects`/`upload`/`tree`/`prop` left alone.
- `compare` takes **`--since` (older) / `--until` (newer) options, not positionals**: a
  leading defaultable `<dir>` positional would otherwise force `compare . <snap>`, and
  `--since` reads naturally, fixes the direction to old→new (like `diff`), and extends to
  dates later. Single-snapshot use is deliberately "since X → latest" (the useful baseline
  case), not "X vs its predecessor".
- The `snapshot` option is **`--rehash`, a plain positive flag — deliberately not a
  `--no-lookup` negation**: a camelCase `noLookup` key made the natural `--no-lookup` an
  unknown option (`allowNegative` only negates the literal key).
- A bespoke SSO `login` command existed and was removed — the once-open question ("bespoke
  SSO flow vs the standard AWS credential chain") is **settled** in favour of the standard
  chain (see "What this project is" above).

### Source layout

App-level shell files at the `src/` root (`s3cab.mjs` entry, `commands.mjs` registry,
`help.mjs` renderer — root, not `lib/`, because it's bespoke CLI-shell glue tied to the
registry shape, not a reusable primitive); the rest splits into **sibling** folders
[src/commands/](src/commands/) (one file per command) and [src/lib/](src/lib/) (shared
modules). The siblings sit beside each other on purpose — the shared modules are
_depended on by_ the commands, not a layer above — and it's a taste-driven arrangement,
not a hard boundary (e.g. `lib/snapshot-file.mjs` importing `commands/prop.mjs` is fine).
Grouping is by **subsystem/cohesion, not abstract layer**: no `lib/util/` junk-drawer
split. If `lib/` ever grows enough to cleave, extract a folder named for the subsystem
(likely `lib/s3/` as the S3 milestone lands) and leave the generic leaves (`format`,
`read-lines`, `error`) flat at the root.

### One s3cab repository == one bucket

The remote layout (`objects/<sha256>` + `snapshots/` at the **bucket root**, shown in the
README) is fixed by convention, *not* an arbitrary prefix within a shared bucket — a fixed,
well-known structure is what lets a tool (or a person) find everything by convention alone
(#2). `objects` and `upload` already follow it; the snapshot-driven `backup` that populates
`snapshots/` is the remaining piece.

### Auth model (the short version — [specs/auth.md](specs/auth.md) is the spec)

Credential resolution is `resolveCredentials` in [src/lib/auth.mjs](src/lib/auth.mjs):
s3cab's layered env files → the standard AWS SDK chain → an actionable error. The
layering, precedence, and security guards are documented in that file's comments; the
spec records the model and the History of the removed Tier 2 SSO machinery. Two
non-obvious points worth pinning here:

- **Files beat the shell** ("Model A"): a value in an s3cab env file wins over the
  inherited environment, enforced by s3cab's own merge (built-in `util.parseEnv`, no
  dotenv dep) rather than any loader's fixed semantics.
- The **dir layer (`<dir>/.s3cab/env`) exists and is tested but is not wired to any
  command yet** — it lands with the dir-scoped commands (`setup`/`backup`/…), which will
  call `loadEnv({ dir })` at entry, likely via a `repoConfig(dir)` helper (`setup` writes
  the folder↔bucket link). s3cab never writes `~/.aws/*`.

---

## Build → native executable (the non-obvious parts)

> The exact npm scripts live in [package.json](package.json) and aren't repeated here.
> This section records only the _why_.

The distribution goal is a **single native executable** — a user shouldn't need Node
installed to run s3cab. Producing it is two steps:

1. **Bundle**: a one-line **esbuild** invocation (no wrapper script) bundles the ESM
   source into one ESM file, `dist/s3cab.js`. esbuild is invoked **bundle-only** — no
   `--target`/`--minify` — so the output is the same modern syntax that runs from source.
   The `#!/usr/bin/env node` shebang lives in the entry source (so that file _also_ works
   as the npm `bin`); esbuild **preserves an entry point's shebang**, so no banner is
   needed (a second `#!` line would be a syntax error). `--external:aws-crt` keeps the AWS
   SDK's optional native addon out. esbuild exists purely because SEA needs a **single
   standalone file** (a SEA main may only import built-ins) — _not_ to convert module
   format.
2. **Package** (`node --build-sea=sea/<target>.json`, Node ≥ 26) embeds the bundle into a
   copy of the node binary in one step — no `postject`. The [sea/](sea/) configs are
   **static, committed JSON** differing only in `output` extension. Each sets
   `"mainFormat": "module"` (without it SEA defaults to CommonJS and rejects `import`;
   caveat: incompatible with `"useSnapshot"`). They deliberately **omit `executable`**, so
   SEA injects into the node _running_ the build — you always get a binary for the host
   you build on. The binary is plainly **`s3cab`** on every platform; the per-platform tag
   belongs on the _release archive_, not the executable.

**Build model: each OS builds its own binary; no cross-compilation.** `--build-sea` _can_
cross-inject, but a binary for another OS can't be smoke-tested where it's built, and mac
binaries built off-Mac can't be codesigned (so won't launch). CI builds the full matrix
natively, one runner per platform.

**`npm run clean` delegates to `git clean -fdX`** rather than listing paths, so it stays
in sync with `.gitignore` for free, needs no `rimraf`-style dep (#5), and works on
Windows. `clean:dry` previews first — worth it because `-X` wipes _all_ ignored files,
including `node_modules/`, `.claude/settings.local.json`, and dogfood snapshots. Full
clean by design. Note `git clean -e <pattern>` can _not_ spare a file here: under `-X`,
`-e` makes a file _more_ likely to be deleted, not less (verified). The only way to keep
an ignored file across a clean is to stop ignoring it — not worth it.

**Releases** ([.github/workflows/release.yml](.github/workflows/release.yml)): `setup-node`
provisions the pinned node, so the "SEA base binary must match the running node version"
rule holds by construction. The bare `s3cab[.exe]` is wrapped in a per-platform archive
(`s3cab-<target>.tar.gz` / `.zip`) so the assets don't collide while the binary inside
stays plainly `s3cab` (bonus: roughly thirds the ~100 MB download). A `v*` tag publishes a
GitHub Release via the `gh` CLI (no marketplace actions beyond official `actions/*`), with
a `SHA256SUMS` file — apt for a SHA-256-addressed tool — and `v0.x`/`-alpha` tags marked
`--prerelease`. A **fifth asset** is the esbuild bundle itself (`dist/s3cab.js`): the
any-platform, bring-your-own-Node channel — built once (platform-independent), uploaded
un-archived. **glibc floor:** the Linux build job pins `ubuntu-22.04`, not `-latest` — a
native binary links the _builder's_ glibc, so building on a newer image would refuse to
start on older distros; this constrains only the build matrix, not test jobs.

**CI vs release — two workflows, deliberately split.** [ci.yml](.github/workflows/ci.yml)
is the everyday gate (every push/PR). Tests run a **three-OS matrix** because the code
genuinely branches on platform (case-insensitive globs on `win32`, `\`→`/` normalization);
lint runs once. `release.yml` triggers only on `v*` tags + manual dispatch, and keeps its
own single-OS lint+test gate to re-check the one commit CI doesn't see — the tag.

**Dependency updates — Dependabot, not Renovate:** native to GitHub, zero extra
accounts/config (#5/#6 — Renovate would be over-engineering for this dependency surface).
Weekly, **grouped on purpose**: the `@aws-sdk/*` packages version in lockstep and publish
near-daily, so ungrouped PRs would flood the queue. The **security** half (CVE-driven
alerts/PRs) is enabled in repo _settings_ — UI-only, can't live in the YAML. Auto-merge of
green patch/minor PRs is deliberately **not** enabled yet (a trust call to revisit).

**npm package — ships source, not the bundle.** npm installs a file tree and resolves
imports, so the package ships the plain `src/` modules with `bin` pointing at the entry —
no bundle, no build step on publish. (Readable source over an opaque blob is also the
#2/#7 choice: the code you install is the code that runs.) Worth knowing:

- The `files` allowlist uses **negation** (`"!src/**/*.test.mjs"`) to keep co-located
  tests out of the tarball. Verify with `npm pack --dry-run` after touching it.
- The **AWS SDK is a normal npm `dependency`** here; in the SEA channel the _same_ dep is
  inlined into the bundle (`aws-crt` external → JS fallback). One dependency, two fates.
- **Publishing uses npm Trusted Publishing (OIDC)** — no long-lived `NPM_TOKEN` secret;
  provenance attestation comes free (fits #2). Needs the one-time trusted-publisher config
  on npmjs.com and npm ≥ 11.5.1 (the job refreshes npm first, since Node's bundled npm may
  predate OIDC support). A guard fails the job if the tag ≠ `package.json` version.
  **dist-tags differ from the GitHub prerelease rule on purpose:** only a semver
  prerelease (`v*-alpha.N`) goes to npm's `next`; a plain `v0.x` publishes to `latest`.

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
  frequently AI-edited docs fragile to edit, for no real gain (`proseWrap` doesn't reflow
  prose). ESLint defers to Prettier (`eslint-config-prettier`) and **ignores generated
  build artifacts** — otherwise it lints the bundled output.
- **Don't bury `await` inside a larger statement** (a compound `if`/`while` condition, a
  ternary, a call argument). Await into a named local on its own line first, then use it:
  `const exists = await objectExists(uri); if (exists) …`, not
  `if (… && (await objectExists(uri)))`. The suspension point stays visible and the value
  gets a name. Neither Prettier nor ESLint enforces this — it's a house style. (When the
  inline form was guarding a short-circuit, a nested `if` preserves the same conditional
  evaluation without the inline await.)
- **The whole-project type check (`tsc -p jsconfig.json`) is kept clean** and runnable via
  the `typecheck` script. Two non-obvious bits make that possible: `scripts/` (untyped
  scratch) is excluded, and `jsconfig.json` maps `events`/`punycode`/`string_decoder` back
  to the builtin type declarations — transitive deps install npm shims of those Node
  builtins, which would otherwise shadow them at type-resolution time and drag their
  untyped CJS internals into the check (see the comment in jsconfig.json).
- **`.gitignore` ignores the repo's own snapshot output with a root-anchored
  `/.s3cab/snapshots/`**, so committed test fixtures under
  `test/fixtures/**/.s3cab/snapshots/` stay tracked. Don't broaden it to `**/.s3cab/`.
- **The repo dogfoods itself:** the root [.s3cab/exclude.txt](.s3cab/exclude.txt) is a real
  exclude config, so `s3cab tree .` / `snapshot .` works on the repo itself.
- **Test layout convention:** unit tests are **co-located** with their source as
  `*.test.mjs`; [test/](test/) holds only cross-cutting tests (`e2e.mjs`) and shared
  `fixtures/`. See [test/README.md](test/README.md). Node's runner executes **every**
  `*.{js,mjs,cjs}` under a `test/` dir (not just `*.test.*`), so keep non-test `.mjs`
  (scratch scripts, shared helpers) **out** of `test/` or they run as phantom empty tests —
  scratch goes in [scripts/](scripts/), and a test's shared helper lives beside the test
  that uses it.

---

## Known gaps & cleanup items

Pre-release housekeeping and open decisions surfaced from the code:

- **Snapshot-driven backup/restore flow not built yet.** The object-store plumbing works
  (`objects`, `upload`, via the `src/lib/s3.mjs` boundary), but the snapshot-driven `backup`,
  the remote-snapshot wiring under `snapshots/`, and the download/`restore` path don't
  exist — the read-stream/bucket ops in `s3.mjs` still have no caller (promoted ahead of
  need, deliberately). `upload` still owes its **`--if-modified-from <snapshot>` skip** —
  the snapshot-aware "only upload what changed" optimization `backup` is built on (see the
  TODO in [src/commands/upload.mjs](src/commands/upload.mjs); load-bearing, don't lose it).
  The CLI surface is scaffolded ahead of the rest: `setup`/`backup`/`restore`/`status`/
  `verify` are inline registry stubs and `--remote` is wired onto `list`/`compare`, all
  throwing `notImplemented()`; promote each stub into its own `src/commands/` file as it
  gains a real body.
- **Native-executable packaging works and is validated on real runners** (the full matrix
  has run for real: binaries build, smoke-test, archive; macOS ad-hoc sign, npm publish,
  and GitHub Release all succeed). Open items:
  - **macOS notarization — deliberately skipped (costs money).** Ad-hoc signing is enough
    to _run_; Gatekeeper-clean distribution would need a paid Apple Developer ID. The
    README documents the `xattr` workaround for browser downloads.
  - **macOS is labelled `macos`, not `darwin`,** in release-asset + `sea/` config names
    (friendlier on a download); `test/e2e.mjs` maps `process.platform` to the label.
  - **Only `macos-arm64` ships** — Intel Macs are legacy; those users have `npm` or the
    portable bundle. Adding it later is one `sea/` config + one `macos-13` matrix row.
  - **Drop esbuild** if Node ever bundles multi-file SEA inputs natively.
- **"Latest snapshot uncompressed"** currently only happens behind `S3CAB_DEBUG`. Decide
  whether keeping the latest manifest uncompressed for transparency is a real feature.
- **Wire `typecheck` into CI.** The whole-project `tsc` check is clean as of the auth
  removal (the promoted-from-POC `login.mjs` was the last `src/` offender); ci.yml doesn't
  run it yet.
- **Revisit plain-JS-vs-TypeScript** now that Node runs TS natively (per #7).
- **Concurrency guard** for snapshots is only the temp-file check (its existence doubles
  as a crude in-progress lock); a proper lock file is a `TODO` in
  [src/commands/snapshot.mjs](src/commands/snapshot.mjs).
- **Define behaviour** for paths containing tabs/newlines in the TSV (see #4 above).
- **Help gaps:** per-command `usage()` doesn't list the universal `--help`/`--version`,
  and nothing documents the `S3CAB_DEBUG` env var in the help output.
- **SIGINT handling:** the commented-out handler at the bottom of
  [src/s3cab.mjs](src/s3cab.mjs) is a parked reminder (kept on purpose — convention 6). It
  was disabled for a reason since forgotten; work out whether the CLI needs one, then wire
  it up or remove it.
- **Revisit `compare`/`diff` in detail.** The classification logic works and is
  well-tested, but it's due a careful pass — including the parked
  `objectPaths.delete(path)` question commented inside `diff()`.
- **Re-measure the slurp/stream hash boundary** in [src/commands/prop.mjs](src/commands/prop.mjs)
  during any future perf/test pass. Files ≥ 5 MB stream through a hash; smaller ones slurp
  via one-shot `crypto.hash`. The 5 MB cutoff was chosen empirically on real data but
  predates the one-shot-hash path, so the optimum may have moved. (`streamHash`'s old
  explicit 8 MB buffer was already dropped as a relic — reads now use Node's default
  `highWaterMark`, with no measured loss for SHA-256.)
