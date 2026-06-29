# Built-ins over dependencies

**Status:** accepted

Prefer Node/JS built-ins; the bar to add a third-party dependency is high and applies to
runtime deps, CLI ergonomics, and dev tooling alike. Arg parsing → `node:util` `parseArgs`,
not commander. Terminal output → plain ANSI / `process.stderr`, not chalk. Tests → `node:test`,
**not** Jest or Vitest — contributors should not introduce a test framework.

_(Foundational design principle #5; resolves in tension with [0006](0006-minimal-code.md).)_

## Why

Every dependency is surface area, supply-chain risk, and a potential lock-in vector. Modern
Node usually makes the bespoke alternative *tiny* (parseArgs vs commander, ANSI vs chalk), so
both this ADR and [0006](0006-minimal-code.md) win at once.

## The permitted exceptions

Runtime dependencies are exactly two kinds:

1. **Genuinely too big to hand-craft** → the **AWS SDK** (SigV4, multipart, the credential
   chain). This is *the* sanctioned exception; reimplementing it would be absurd.
2. **Polyfills of actual standards**, accepted *temporarily*, removed when the native version
   ships ([0003](0003-modern-open-tech-only.md)). Currently **none** — `@js-temporal/polyfill`
   was the worked example, since dropped. **The AWS SDK is therefore the only runtime dep.**

**Dev dependencies get a more relaxed bar** — they never ship to users and don't affect
recoverability. The notable one is **esbuild** (see
[0016](0016-native-executable-build.md)), which exists only to bridge SEA's
single-file requirement.
