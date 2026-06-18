# GPL-3.0-or-later license

s3cab is licensed **GPL-3.0-or-later**, chosen on purpose to keep derivatives open. The
LICENSE file is the verbatim FSF text — leave it untouched.

_(Decided 2026-06-13 — don't re-litigate casually.)_

## Why

The deciding question was "is a *distributed* closed-source proprietary fork acceptable?" —
answer: no. GPL's copyleft requires anyone who distributes a modified s3cab to release their
source, so a shipped closed fork isn't permitted. (It doesn't restrain purely private,
undistributed changes; stronger network copyleft like AGPL exists, but plain GPL fits a local
CLI.) This aligns with the anti-black-box ethos
([0002](0002-no-lock-in-hard-constraint.md), [0006](0006-minimal-code.md)).

## Considered options

- **Apache / MIT** — rejected *because* they permit closed-source forks.
- **GPL v2** — rejected: **v3** specifically is one-way compatible with the AWS SDK's
  Apache-2.0; v2 would not be.

See also [0009](0009-cla-not-dco.md) on how contributions preserve a future dual-licensing
option.
