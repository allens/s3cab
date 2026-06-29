# One s3cab repository == one bucket, fixed layout

**Status:** partly superseded by [0024](0024-set-name-is-the-whole-identity.md)

> **Partly superseded by [0024](0024-set-name-is-the-whole-identity.md)** (accepted): the
> snapshot namespace flattened from `snapshots/<user>@<machine>/<set>/` to `snapshots/<set>/`,
> and a `sets/<set>/` config/marker area was added. The "one bucket == one repository, fixed
> layout" principle itself is unchanged; only the namespace shape below changed — the
> `snapshots/<user>@<machine>/<set>/` form here is the *historical* layout.

The remote layout — `objects/<sha256>` + `snapshots/` at the **bucket root** — is fixed by
convention, *not* an arbitrary prefix within a shared bucket.

## Why

A fixed, well-known structure is what lets a tool (or a person) find everything by convention
alone — directly serving [0002](0002-no-lock-in-hard-constraint.md). `hashes` and `upload`
follow it, and the snapshot-driven `backup` that populates `snapshots/` does too.

## Consequences

One bucket holds **multiple backup sets** ([0014](0014-backup-sets.md)): dedup is shared via a
single `objects/` pool, while snapshots are namespaced as `snapshots/<set>/` (the set name is
the whole namespace, [0024](0024-set-name-is-the-whole-identity.md)). The object-store half is
owned by [src/lib/objects.mjs](../../src/lib/objects.mjs); the `snapshots/<set>/` half by
[src/lib/remote.mjs](../../src/lib/remote.mjs), and the `sets/<set>/` marker by
[src/lib/set-marker.mjs](../../src/lib/set-marker.mjs). `s3.mjs` stays the generic SDK boundary
and never learns the layout.
