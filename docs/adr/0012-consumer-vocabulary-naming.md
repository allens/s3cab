# Consumer-vocabulary command and flag naming

The audience is **ordinary, non-technical people**, so user-facing names favour consumer
backup vocabulary over git/dev jargon. The canonical terms are pinned in
[CONTEXT.md](../../CONTEXT.md); this ADR records the naming *calls* — weighed on purpose,
don't re-litigate casually.

## The decisions

- **`backup` / `restore`** as the transfer verbs (not `push`/`pull` or `upload`/`download` at
  the porcelain level): the most domain-honest pair, avoiding the bidirectional *sync*
  connotation — s3cab is one-directional archival.
- **`setup`, not `init`** for the set-creation command.
- **`--remote`/`-r` flag**, not separate `*-remote` verbs or a `remote` noun-group, for the
  read commands `list`/`compare` — local and remote are the *same operation pointed
  elsewhere*, and a flag avoids a two-level dispatcher ([0006](0006-minimal-code.md)).
  **`status` is the exception: remote-only, no `--remote` flag** — "what a backup would upload"
  is *inherently* a local-snapshot-vs-remote-manifest comparison, so there is no second mode
  for the flag to point at.
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
