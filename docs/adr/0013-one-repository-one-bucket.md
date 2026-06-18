# One s3cab repository == one bucket, fixed layout

The remote layout — `objects/<sha256>` + `snapshots/` at the **bucket root** — is fixed by
convention, *not* an arbitrary prefix within a shared bucket.

## Why

A fixed, well-known structure is what lets a tool (or a person) find everything by convention
alone — directly serving [0002](0002-no-lock-in-hard-constraint.md). `hashes` and `upload`
follow it, and the snapshot-driven `backup` that populates `snapshots/` does too.

## Consequences

One bucket holds **multiple backup sets** ([0014](0014-backup-sets.md)): dedup is shared via a
single `objects/` pool, while manifests are namespaced as
`snapshots/<user>@<machine>/<set>/`. The object-store half is owned by
[src/lib/objects.mjs](../../src/lib/objects.mjs); the `snapshots/<namespace>/` half by
[src/lib/remote.mjs](../../src/lib/remote.mjs). `s3.mjs` stays the generic SDK boundary and
never learns the layout.
