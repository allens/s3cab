# Consumer-vocabulary command and flag naming

**Status:** accepted

The audience is a **casual but technical user** — comfortable enough to stand up an
S3-compatible service, but not a developer who lives in git. So user-facing names favour plain
consumer backup vocabulary over git/dev jargon — **not** because the user can't handle a
technical term, but because plain language reads more clearly *for everyone* (Nielsen's
heuristic #9 urges plain language even for expert users —
[ADR-0030](0030-error-message-guidelines.md)). The bar is consumer-honest naming where it costs
nothing, **not** contorting to hide a genuinely technical concept from a technical user — which
is why `verify`, `--remote`, and the plumbing `prop`/`tree`/`upload` were weighed and *kept*
(see "Calls weighed but kept as-is" below). The canonical terms are pinned in
[CONTEXT.md](../../CONTEXT.md); this ADR records the naming *calls* — weighed on purpose,
don't re-litigate casually.

## The decisions

- **`backup` / `restore`** as the transfer verbs (not `push`/`pull` or `upload`/`download` at
  the porcelain level): the most domain-honest pair, avoiding the bidirectional *sync*
  connotation — s3cab is one-directional archival.
- **`setup`, not `init`** for the set-creation command.
- **`--remote`/`-r` flag**, not separate `*-remote` verbs or a `remote` noun-group, when a
  read command genuinely has both a local and a cloud mode — `list` (the surviving case):
  local and remote are the *same operation pointed elsewhere*, and a flag avoids a two-level
  dispatcher ([0006](0006-minimal-code.md)). Two read commands are *not* flagged, for opposite
  reasons: **`status` is remote-only** — "what a backup would upload" is *inherently* a
  local-vs-remote comparison, so there is no second mode for the flag to point at; and
  **`compare` is local-only** ([0027](0027-compare-local-only-adoption-syncs-manifests.md)) —
  remote snapshots are always a subset of local ones, so a `--remote` diff could only
  reproduce a local one. The flag earns its place only where both modes give distinct answers.
- **`hashes`**, renamed from `objects` (2026-06-17): the `objects` name was wanted for the
  object-store module ([src/lib/objects.mjs](../../src/lib/objects.mjs)), and `hashes` names
  what the command prints (one sha256 per line) more honestly. Its write sibling `upload` reads
  fine and was kept.
- **`compare` takes `--since` (older) / `--until` (newer) options, not positionals**: a leading
  defaultable `<dir>` would force `compare . <snap>`; `--since` reads naturally, fixes the
  direction old→new (like `diff`), and extends to dates later. Single-snapshot use is
  deliberately "since X → latest".
- **`snapshot --rehash`** is a plain positive flag, deliberately **not** `--no-lookup`: a
  camelCase `noLookup` key made the natural `--no-lookup` an unknown option (`allowNegative`
  only negates the literal key).

## Calls weighed but kept as-is

`--remote` over `--cloud`, `verify` over `check`, and the dev-flavoured plumbing
`upload`/`tree`/`prop` left alone. A bespoke SSO `login` command existed and was removed — see
[0015](0015-standard-aws-credential-chain.md).
