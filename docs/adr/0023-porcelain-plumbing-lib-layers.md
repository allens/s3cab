# Commands are porcelain or plumbing, over a shared lib

**Status:** accepted

The source has three dependency layers, and the allowed dependency directions are fixed:

- **`lib/`** — shared primitives (deep modules: `s3`, `remote`, `objects`, `snapshot-file`,
  `sets`, …). No CLI concerns; depends on nothing in `commands/`.
- **Plumbing commands** — low-level, single-purpose building blocks a user *can* invoke but
  that mostly exist to be composed (`upload`, `hashes`, `prop`). Depend only on `lib/`.
- **Porcelain commands** — user-facing workflow verbs (`backup`, `restore`, `snapshot`,
  `status`, …). May depend on plumbing commands **and/or** on `lib/` primitives directly.

Allowed edges: porcelain → plumbing, porcelain → `lib/`, plumbing → `lib/`. Forbidden:
`lib/ → commands/` (a `snapshot-file.mjs → commands/prop.mjs` import was retired for this
reason) and plumbing → porcelain.

This **retracts** the earlier informal rule "no command imports another command." That rule
was too strong: a porcelain command composing a plumbing command is legitimate.

## Why

The flat prohibition mislabeled a real, healthy pattern as a smell. Git is the canonical
counter-example — porcelain (`pull`) composes plumbing (`fetch` + `merge`) — and s3cab's
porcelain/plumbing *verb* split (CONTEXT.md: `backup` is porcelain, `upload`/`download` are
plumbing) already implied the layering; this just states the dependency rule that follows
from it. With the rule named, "may a command depend on another command?" stops being a flat
no and becomes a *direction* check: down the layers, never up or sideways within a layer.

The remaining discipline the flat rule was groping at is real and kept: a command must not
reach *sideways* into a same-layer peer, and a porcelain command should depend on a plumbing
command through that command's **deliberate interface**, not by importing whatever helper
happens to co-reside in its file. An exported internal that two commands both pull on is not
a plumbing interface — it is a `lib/` primitive that hasn't moved yet.

**And the inverse, which this ADR was silent on for long enough to mislead: a pure helper with
one production caller is not a `lib/` primitive either.** `lib/` is defined above as *shared*
primitives; a module nothing shares has the layer's cost — a second file to open, an interface
to keep honest, an import edge — and none of its benefit. Such a helper lives **private to its
one caller**, and `lib/` earns a module at the *second* consumer, counted in call sites that
already exist ([0006](0006-minimal-code.md)). The one-export rule makes this concrete: a
private helper is unexported, so a *test* reaching for it is the signal that it has become
shared and should move — the same test the outward half of this rule applies. (Worked example:
`collectHashes` was extracted to `lib/delete.mjs` alongside the `delete` rewrite of
[0089](0089-hash-operand-delete.md), where it sat with exactly one caller and one test until it
was folded back into `commands/delete.mjs`. What *was* genuinely shared inside it — the
`#`-comment-and-blank line filter — turned out to be `read-lines.mjs`'s `parseLines`, already
in `lib/`, and had been re-implemented rather than imported.)

## Consequences

- **Classification is per command, and now a deliberate call.** `upload`/`hashes`/`prop` are
  plumbing; `backup`/`restore`/`snapshot`/`status`/`compare`/`list`/`setup` are
  porcelain. A command whose home is genuinely contested — `tree`, which is both a user
  diagnostic and the walk that `snapshot` consumes — is now a decision the model lets us make
  on purpose, rather than an accident.
- **The test for "extract to `lib/` vs. keep as plumbing":** does the shared thing have a
  CLI shape (argv in, presented output, exit code) or a primitive shape (takes resolved
  values, returns data, no I/O ceremony)? Primitive shape → `lib/`. CLI shape that porcelain
  legitimately composes → plumbing command, depended on through its interface.
- **Structural enforcement, not directional.** The one-export corollary — a `commands/` file
  exports exactly one symbol, its command function — *is* enforced, by the
  `local/one-export-per-command` ESLint rule (a cheap structural check; see CLAUDE.md coding
  conventions). The broader layer *directions* (porcelain → plumbing → `lib`, never up or
  sideways) stay a reviewer-applied convention, not a token threaded through signatures
  (against [0006](0006-minimal-code.md)), as [0022](0022-prepare-remote-set-front-door.md)
  chose.
- Refines, doesn't reopen, [0011](0011-validation-in-command-functions.md) (validation lives
  in command functions) and the `lib/ → commands/` prohibition (still in force).
