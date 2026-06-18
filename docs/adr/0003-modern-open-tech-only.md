# Target modern tech, but only open standards

Deliberately target the newest OS, runtime, and language features — **provided they are
standard and open**. Modern ≠ proprietary. The project happily requires recent tech (see
`engines.node`), but only open, widely-implemented tech.

_(Foundational design principle #3.)_

## Why

Open + modern lets us delete dependencies and bespoke code at once: a native built-in is
both the most modern and the most lock-in-free option. Worked examples:

- **zstd** — an open standard, native in Node and in Windows 11 (not Win10 out of the box).
  Chosen for snapshot compression after testing several algorithms; best speed/ratio balance.
- **Node 26+** — for native built-ins that remove dependencies (see
  [0005](0005-builtins-over-dependencies.md)).
- **Temporal** — the `@js-temporal/polyfill` was used temporarily and **dropped** the moment
  native `Temporal` shipped in the target Node (≥ 26.3.0); it is now used as a global.

## Consequences

Polyfills of real standards are accepted only as temporary bridges, removed when the native
version lands. A proprietary-but-convenient technology is rejected even when it is newer.
