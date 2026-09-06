# The referenced-enumeration vocabulary lives in a pure module, not with its producer

**Status:** accepted & implemented; amended 2026-09-06 (the constructor moved in). Applies
[0023](0023-porcelain-plumbing-lib-layers.md)'s lib layering and
[0006](0006-minimal-code.md)'s minimal-code stance.

## Context

`referencedObjects` (`lib/remote.mjs`) reads every snapshot in a bucket and returns
`Map<set, ReferencedResult>`. Five modules consume it: `verify.mjs` computes a per-set report from
one entry, and `cleanup.mjs` / `delete.mjs` / `unrestorable.mjs` each plan over the whole map.

The shape it returns — `ReferencedResult`, `ReferencedObject`, `PathReference` — and the
classifier deciding which snapshot-read failures are *findings* rather than operational errors
(`isCorruptSnapshotError`) all lived in **`verify.mjs`**. That put two unrelated things in one
module: the verify command's planner, and the vocabulary of the enumeration itself. Two symptoms
made it visible:

- **The producer imported its own return type from a consumer.** `remote.mjs` carried
  `@import { ReferencedResult } from "./verify.mjs"`, and `verify.mjs`'s own typedef had to say
  "built by `referencedObjects` in remote.mjs".
- **`isCorruptSnapshotError`'s only caller was `remote.mjs`** — a function living in one module
  and used exclusively by another.

The obvious correction is to move the vocabulary to its producer, `remote.mjs`. **That does not
work**, and the reason is the whole decision: `remote.mjs` imports `s3.mjs`, which imports
`@aws-sdk/client-s3` and `@aws-sdk/lib-storage`. `cleanup.mjs` has **no runtime imports at all**,
and `delete.mjs` / `unrestorable.mjs` import only `format.mjs` / `restore.mjs`. They are pure
planners, unit-tested with no mocked seams and nothing to load. Moving the vocabulary to the
producer would make all three import the AWS SDK — plus their test files — to reach a typedef and
a string join.

The trigger was consolidating a duplicated derivation: all three planners independently flattened
the per-set `unreadable` lists into the same set-qualified bucket-wide view, and the derivation
needed a home neither `remote.mjs` nor `verify.mjs` could give it.

## Decision

**The enumeration's vocabulary lives in its own zero-import module, `lib/referenced.mjs`** — the
three typedefs, `isCorruptSnapshotError`, and the two shared helpers the bucket-wide consumers
need (`unreadableSnapshots`, `unreadableMessage`).

Every module depends on it and it depends on nothing:

```
referenced.mjs   (pure; imports nothing)
  ↑ remote.mjs                        builds results, classifies read failures
  ↑ verify.mjs                        consumes one set's result
  ↑ cleanup / delete / unrestorable   plan over the whole map
```

The `remote.mjs → verify.mjs` edge is gone, and `verify.mjs` is now only the verify command's
planner, which is what its name claims.

**The rule this generalizes:** where a produced *shape* is consumed by modules of a different
purity than its producer, the shape's home is decided by **what may import it**, not by who
builds it. A vocabulary module earns its place when it lets the strictest consumer stay strict.

## Consequences

- **Purity is preserved as a property, not a habit.** `cleanup.mjs` still imports nothing but
  `referenced.mjs`; its test still loads no SDK. Anyone tempted to "fix" the apparent inversion by
  moving the types to `remote.mjs` will find this ADR first — that is the reason it exists, since
  the resulting slowdown is silent and shows up only as heavier test startup.
- **One more file** (against [0006](0006-minimal-code.md)). Justified rather than speculative: it
  had six consumers before it was written, and it *removes* an import edge rather than adding
  indirection.
- **`unreadableMessage` returns text, not an `Error`.** It is shared by callers that throw it and
  callers that print it inside a summary, so the reusable part is the wording. That keeps it
  outside `error.mjs`'s factory taxonomy by design — and consistent with the house precedent that
  named message factories live with their subsystem (`noCredentialsError` in `auth.mjs`,
  `collisionError` in `commands/setup.mjs`), not centrally.
- **The `unreadable` list is `string[]`, not records.** The per-set `reason` is dropped when the
  view goes bucket-wide: `cleanup`/`delete`/`forget` report *which* snapshots and send the user to
  `verify` for *why*, and `verify` reads the per-set list where the reason is still carried.

## Amendment (2026-09-06): the shape's constructor lives with its vocabulary

The typedefs above described a shape that no function built: `remote.mjs` folded snapshot rows
into it inline, and the seven test files that plan over the shape each built it by hand — three
helpers named `ref`, two named `enumeration`, five incompatible signatures, five of them
hard-coding `snapshotsChecked`, and a new test picking one by proximity. Ten builders and no
definition as code, for the shape that decides what `cleanup` deletes.

**The per-snapshot fold is now `addSnapshotReferences(referenced, name, entries)` in
`referenced.mjs`**, called once per snapshot read by `referencedObjects` and once per snapshot in
a fixture by the one test builder, `enumeration(spec, unreadable)` in
`test/helpers/enumeration.mjs`. The fixture is written the way the bucket is — set → snapshot →
path → `[hash, size]` — so the derived facts (`snapshotsChecked`, which snapshots reference a
path, a path recorded at two sizes) fall out of the data rather than being spelled, and a test
cannot hold a shape a real read would not produce. `test/integration/remote.test.mjs` pins the
two against each other: a real read's `referenced` map is `deepEqual` to the builder's for the
same snapshot.

The fold has one production caller, which [0023](0023-porcelain-plumbing-lib-layers.md)'s
amendment says is not by itself a reason to export it. The reason here is the module's purpose:
this is the vocabulary module, and a shape's constructor is part of its vocabulary. The test
reaching for it is the intended second caller, not a symptom.
