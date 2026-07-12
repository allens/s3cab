# Split `setup --inherit` into its own `reconnect` command

**Status:** accepted (2026-07-12) — **implemented** (2026-07-12). **Resolves
[0036](0036-setup-mutates-list-shows-drop-sets.md)'s deferred "`--inherit` stays a flag" item**
and follows on from [0052](0052-retire-setup-update-mode.md) (which left `setup` as
create-or-inherit). `setup` is now create-only.

## Context

[0036](0036-setup-mutates-list-shows-drop-sets.md) made `setup` the set-write verb and
**deferred** one question: whether `--inherit` (adopt an existing remote set onto this machine)
should become its own verb, declining it then under [0006](0006-minimal-code.md) — "revisit only
if the flag-mode grates."

[0052](0052-retire-setup-update-mode.md) then retired update mode, leaving `setup` with exactly
two modes: **create** and **inherit** — and `--inherit` as the *only* remaining invisible-mode
toggle in the command. That sharpened the smell. The two modes are near-**opposite** acts:

| | create | inherit (`--inherit`) |
| --- | --- | --- |
| Precondition on the name | must be **free** in the bucket | must **already exist** in the bucket |
| Directories | **required** | **forbidden** (they come from the remote) |
| Remote effect | claim the marker, push config | read the marker, pull config **+ snapshot history**, re-stamp owner |

A single command whose required arguments and network preconditions **flip on one boolean flag**
is exactly the "invisible mode / don't surprise the user" smell clig.dev warns about — now
unmasked, because it is the last such flag in `setup`.

## Decision

**Split `--inherit` out into a standalone `reconnect` command.** `setup` becomes **create-only**
(make a *new* set); `reconnect <set> --bucket <b>` adopts an *existing* remote set onto this
machine. The `create()` and `inherit()` bodies were already separate functions sharing only
`writeSet` + the name/bucket validators, so this is a clean extraction, not a detangle
([src/commands/reconnect.mjs](../../src/commands/reconnect.mjs) is the moved `inherit()`).

**Name: `reconnect`** (reasoned under [0012](0012-consumer-vocabulary-naming.md), consumer
vocabulary, and the `cli-design` skill). The verb has to stand alone — `setup … --inherit` leaned
on the `setup` context to read; a bare `inherit photos` does not tell an ordinary person what
happens. `reconnect` says it: *this set already lives in the cloud — attach this machine to it.*
Rejected alternatives:

- **`inherit` (keep the word, promote to a verb)** — dev-ish; standalone it's non-obvious for
  "get my backups onto my new laptop."
- **`adopt`** — warm, but vague about the object ("adopt *what*?").
- **`recover` / `restore-from`** — collide with `restore` (which pulls *file contents*); a user
  would expect their files back, but `reconnect` pulls only config + snapshot history.
- **`import`** — implies the file contents come down; they don't (that's `restore`).
- **`connect` / `migrate`** — `connect` reads as provider/credentials setup (`provider`'s job);
  `migrate` implies the set *moves* (it never leaves the cloud).

The two cons of `reconnect` — it can imply a *live/persistent* connection (s3cab is snapshot-based,
not a live sync), and the "re-" presupposes a prior link a brand-new machine never had — were
judged shallow: the command's own output ("Pulled N snapshots — local history is ready") corrects
the first on first use, and the replacement/recovery case (where "re-" fits) is the dominant one.

**What `reconnect` does not do:** it never downloads the backed-up **file bytes**
(`objects/<sha256>`); only the set config and the snapshot *manifests* come down, which is what
lets `list`/`compare` run offline afterwards ([0027](0027-compare-local-only-adoption-syncs-manifests.md)).
Recovering files is `restore`. Like the old `--inherit`, it re-stamps `OWNER` only (never disables
the prior machine), so two live machines on one set stays possible ([0024](0024-set-name-is-the-whole-identity.md)).

Pre-1.0 (`package.json` major `0`), so `setup --inherit` is **removed**, not deprecated in place.

## Consequences

`setup` = create; `reconnect` = adopt. The pairing reads as "**`setup` a new set / `reconnect` to
an existing one**." Touched: the new command ([reconnect.mjs](../../src/commands/reconnect.mjs)) +
its offline tests; `setup` loses the `inherit()` function and `--inherit` option
([setup.mjs](../../src/commands/setup.mjs)), and its collision error now points at `reconnect`;
the registry ([commands.mjs](../../src/commands.mjs)) gains a `reconnect` entry in the **Setup**
group; `renderSetup` is shared by both (both return the stored `BackupSet`). Tests: new
`reconnect.test.mjs`, `setup.test.mjs` drops the inherit case, and the gated
`set-lifecycle.test.mjs` renames its inherit case to `reconnect`. Docs: README, CONTEXT.md (a new
`Reconnect` term; `Setup` narrows to create), design/backup.md, the guide, and a forward-pointer
on [0036](0036-setup-mutates-list-shows-drop-sets.md)'s deferred item. Historical ADRs that mention
`setup --inherit` (0024/0026/0027/0045/0048/0051/0052) keep their text as the record of the
decision at the time — the command's rename is captured here.
