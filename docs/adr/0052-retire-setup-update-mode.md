# Retire `setup`'s update mode; a set's directories are edited in `dirs.txt`

**Status:** accepted (2026-07-12) — **implemented** (2026-07-12). **Partly supersedes
[0036](0036-setup-mutates-list-shows-drop-sets.md)** — its §2 made `setup` an upsert
(create *then update*); the update half is removed here. Create and inherit are untouched.

## Context

[0036](0036-setup-mutates-list-shows-drop-sets.md) made `setup` the set-**mutation** verb: a
declarative upsert that **creates** a set the first time and **updates** it (refresh member
directories, re-publish config) on every run after, with `--inherit` as a third mode. The upsert
was justified by analogy to `kubectl apply` / `terraform`.

Looking again at what "update" actually *does*, it earns very little:

- Its **only** mutation is the set's member directories (`dirs.txt`). The bucket is fixed at
  creation (a differing `--bucket` was already rejected), the exclude file is never written by
  `setup`, and the per-set profile lives in `profile`/`provider` ([0036](0036-setup-mutates-list-shows-drop-sets.md) §4).
- `dirs.txt` is a **public, user-editable file** — the set store is designed as plain-text files
  a user opens in an editor ("the files are the API", [0002](0002-no-lock-in-hard-constraint.md)),
  exactly like `exclude.txt`. Local commands (`snapshot`/`backup`/`compare`/`walk`) read `dirs.txt`
  directly, so a hand-edit already takes effect with no command.
- That leaves an inconsistency: `exclude.txt` — the file a user changes *most* — has no command
  and is edited by hand, while `dirs.txt` — changed rarely — had a whole command mode. The odd one
  out is update mode, not the missing exclude command.

The one thing update did beyond a file-edit was re-publish `dirs.txt`/`exclude.txt` to the remote
`sets/<name>/` marker (`pushSetConfig`) — and it did **not** do that for a hand-edited
`exclude.txt` either, so it was never a coherent "sync my config" step.

## Decision

**Remove `setup`'s update mode.** `setup` becomes create-or-inherit only — it brings a set into
being on this machine and nothing more. Re-running `setup <name> …` on a set that already exists
locally is **refused** with a message pointing at the two real ways to change what a set backs up
([0030](0030-error-message-guidelines.md) wording): edit its public `dirs.txt` (and `exclude.txt`),
or create a **new set** for a different scope.

**A set's member directories are edited in `dirs.txt`, like `exclude.txt`.** `dirs.txt` is public
by design; that is now the whole story for changing directories in place. There is no private,
command-only path.

**A fresh scope belongs in a new set.** To back up a different set of directories, create a new
set (its own name → own remote namespace → own snapshot timeline, a clean fork). Content dedup and
the upload skip come free — objects are content-addressed **bucket-wide**
([0013](0013-one-repository-one-bucket.md)), so a new set re-uploading an already-stored file finds
it via `planUpload`'s LIST and skips it.

**The remote config re-syncs on `backup`, best-effort.** Update mode was the only thing that
re-published `dirs.txt`/`exclude.txt` to the remote `sets/<name>/` marker (which a later
`setup --inherit` reads). That job moves to `backup`: after the objects + snapshot are up, it
pushes the current config to the marker. It is **best-effort** — the backup has already succeeded,
so a marker-push hiccup warns and leaves the marker stale until the next backup, never failing the
backup. Eventual consistency is safe here because the marker only feeds `--inherit`, and every
snapshot embeds its own `#DIR` lines. (Direct `upload --snapshot` — the plumbing hatch — does not
re-sync; `backup` is the porcelain everyone runs.)

This is pre-1.0 (`package.json` major `0`), so the behaviour change — `setup <existing>` upserts →
errors — ships without a deprecation cycle.

## Rejected alternatives

- **Keep the upsert.** Rejected: update's sole job (re-point `dirs.txt`) duplicates editing a
  public file, and the command-for-`dirs.txt`-but-not-`exclude.txt` asymmetry is the real smell.
- **Make `dirs.txt` private and keep an update command.** Rejected: it reverses the "files are the
  API" design ([0002](0002-no-lock-in-hard-constraint.md)) for the sole purpose of re-justifying
  the command we are removing.
- **Discourage dir changes by removing the command.** Rejected as the *motivation* (though not the
  outcome): swapping directories mid-timeline can make a `compare` read as a mass deletion, but
  that hazard exists whether the change is made by command or by file-edit, so removing the command
  does not address it. The removal stands on "doesn't earn its place", not on "editing dirs is
  dangerous".

## Deferred, not decided here

These follow from removing update mode but are **not** settled by this ADR:

- **Validation/feedback for a hand-edited `dirs.txt`** (e.g. warn when a listed directory no longer
  exists), and **whether/where to warn** when a snapshot's directory scope changes from the
  previous one. Left to a later pass.

## Consequences

`setup` is create-or-inherit; the `update()` mode and its remote-first ordering test
(`setup.remote-first.test.mjs`, a property only update had) are gone. Because directories are now
edited in `dirs.txt`, two spots that steered the user to a `setup` re-run to add directories — the
setup confirmation (`renderSetup`) and `inherit`'s empty-dirs warning — would have pointed at a
command that now errors; both now surface the `dirs.txt` **path** to click/edit instead (which also
answers the "make `dirs.txt` discoverable like `exclude.txt`" nicety). Touched: the command
([src/commands/setup.mjs](../../src/commands/setup.mjs)) + registry
([src/commands.mjs](../../src/commands.mjs)); the config re-sync in
[src/commands/backup.mjs](../../src/commands/backup.mjs); the `renderSetup` output
([src/render.mjs](../../src/render.mjs)); the offline unit tests
([src/commands/setup.test.mjs](../../src/commands/setup.test.mjs)) gain the "refuse on existing set"
case, `backup.test.mjs` gains the re-sync cases, and the gated
`test/integration/set-lifecycle.test.mjs` drops its update case; and the docs (README,
[CONTEXT.md](../../CONTEXT.md), [docs/design/backup.md](../design/backup.md)).
