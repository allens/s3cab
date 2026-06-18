# Contributions take a CLA, not a DCO

Contributions require a **CLA** ([CLA.md](../../CLA.md) — Project Harmony HA-CLA-I v1.0,
"any-licence" outbound variant), not a DCO `Signed-off-by`. The onboarding flow and
one-comment sign-off live in [CONTRIBUTING.md](../../CONTRIBUTING.md).

_(Decided 2026-06-13 — don't re-litigate casually.)_

## Why

To preserve a future **dual-licensing** option: the user may someday want to offer s3cab
under commercial terms alongside the GPL. That only works if the project holds a broad enough
licence to *all* contributions — which a DCO does **not** grant, only a CLA does. Every
contribution still stays GPL for everyone regardless ([0008](0008-gpl-3-license.md)); the CLA
only adds relicensing headroom.

## Consequences

- The cheap moment to set this up was **while solo-authored** — before the first external PR,
  while the user held 100% of the copyright. After merging an outside contribution under plain
  GPL, that headroom would have been lost.
- Enforcement is deliberately **manual** (a PR comment) until volume justifies a CLA-assistant
  Action — the same "wait for the second case" bar as code ([0006](0006-minimal-code.md)).
