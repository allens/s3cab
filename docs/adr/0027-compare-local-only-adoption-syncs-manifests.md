# `compare` is local-only; adoption syncs the manifests

**Status:** proposed (2026-06-21) — pending implementation. Replaces the deferred
`compare --remote` (a `notImplemented()` stub since slice 4); full design in
[docs/specs/backup.md](../specs/backup.md).

`compare` has **no `--remote` mode**: the `--remote` flag and its `notImplemented()` stub are
removed, and `compare` only ever diffs two *local* snapshots. To make a fresh / replacement
machine able to diff history, **`setup --inherit` pulls down all of the set's remote snapshot
manifests** into `~/.s3cab/sets/<set>/snapshots/` (verbatim `.tsv.zst` byte-copies — no
objects), so plain local `compare`/`list`/`restore` just work against full history.

## Why

Local snapshots are a **superset** of remote ones: every backed-up snapshot also sits in
`~/.s3cab/`, and the owning machine additionally holds the snapshots it has taken but not yet
uploaded (the "un-backed-up tail"). `backup` = `snapshot()` + upload (the snapshot file itself
is upload step 5), so after a backup the latest local snapshot *is* the latest remote one, and
local history never auto-shrinks.

Given that, `compare --remote` is **pure redundancy**. `compare` diffs two snapshots you *name*
(`--since`/`--until`); both operands are arbitrary historical points; and every remote snapshot
already exists locally — so a remote diff could only ever reproduce an answer plain local
`compare` already gives. The flag would toggle between two modes with identical output.

The one genuine gap is the **fresh-machine / recovery** case: after `setup --inherit` the remote
holds months of backups but `~/.s3cab/` is empty, so local `compare` has nothing to diff.
Manifests are cheap to sync — they live on a separate prefix (`snapshots/<set>/*.tsv.zst`) from
the content (`objects/<sha256>`), listing/downloading them touches **zero** objects, and their
size scales with file *count*, not backup *size* (a 100k-file manifest is a few MB; even hundreds
of snapshots is tens-to-low-hundreds of MB, versus the terabytes of objects deliberately left in
the cloud). So the fix is to bring the metadata local once, at adoption, rather than to grow a
remote-reading variant of every browse/diff command.

This is sufficient, not just convenient: under the succession model
([0024](0024-set-name-is-the-whole-identity.md), `--inherit` re-stamps ownership), one machine
owns a set at a time, so the remote never gains snapshots the live machine lacks *except* at the
instant of inheritance — which is exactly when the pull runs. No standing/standalone `pull` is
needed ([0006](0006-minimal-code.md): don't build the second caller before it appears).

## The line: which commands keep `--remote`

The cut is **not** "no command reads the remote." It is: a command that reports **what is
actually backed up** touches a fact local does not store, so it justifies hitting S3; a command
that **diffs two named historical points** has both points locally already, so going remote is
redundant.

| command | question | needs remote? | why |
| --- | --- | --- | --- |
| `list --remote` | "what's actually in the cloud?" | **yes** | local never records *which* snapshots were uploaded |
| `status` | "how far behind is the cloud?" | **yes, always** (no flag) | it *is* a local↔remote diff — nothing to toggle |
| `compare --remote` | "diff snapshot X vs Y" | **no — removed** | X and Y always exist locally too ⇒ same answer |

`list --remote` and `status` survive because the un-backed-up tail makes "what's in the cloud"
genuinely different from "what's on this machine," and that difference is unknowable without
asking S3. The adoption pull does not change this: it syncs the *backed-up* history down once,
after which the live machine immediately starts building a new un-backed-up tail — so
`list --remote`/`status` stay meaningful, while `compare --remote` would not.

## Consequences

- `compare`'s `--remote` flag and the `notImplemented("compare --remote")` stub are removed;
  `compare` is documented and implemented as local-only.
- `setup --inherit` gains a manifest-sync step: list `snapshots/<set>/` and download each
  `.tsv.zst` **verbatim** into the local snapshots dir. Don't parse-and-recompress — a remote
  manifest is byte-identical to its local form ([0004](0004-tsv-snapshot-manifests.md)), so a
  raw object-to-file copy is correct and avoids a needless re-encode. (This is a new small
  plumbing op — download-object-to-file — distinct from `readRemoteSnapshot`'s stream-and-parse.)
- Closes the long-deferred `compare --remote` item (slice 4 / slice 5 scaffold).
