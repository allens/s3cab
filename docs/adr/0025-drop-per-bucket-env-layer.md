# Drop the per-bucket env layer

**Status:** accepted (2026-06-21) — implemented; **user layer later dropped by
[0055](0055-per-set-credentials-one-mode.md)** (the three layers below become **set > shell**).
Part of the 2026-06-20 redesign with the sibling
[ADR-0024](0024-set-name-is-the-whole-identity.md) /
[ADR-0026](0026-bucket-required-at-setup.md); full design in
[docs/design/backup.md](../design/backup.md).

> **Superseded in part by [ADR-0055](0055-per-set-credentials-one-mode.md):** the **user** layer
> (`~/.s3cab/env`) is removed as a parallel-default mechanism, leaving **set > shell**. The
> reasoning below — why the *per-bucket* layer went — still stands; only the surviving layer count
> changed.

s3cab's env-file layering drops from four layers to three: the per-bucket
`~/.s3cab/env.<bucket>` file is removed, leaving **set > user > shell**. Auth
(`AWS_PROFILE`/region/endpoint/keys) lives in the user env (single-bucket common case) or the
set env (overrides); it is no longer treated as a property of the bucket.

## Why

The per-bucket layer existed to let several sets sharing one bucket share one auth config.
That payoff only materialises for *multiple* sets on *one* bucket all wanting the *same* auth —
a fleet-shaped case s3cab is not chasing. For the real target (one user, one bucket, a set or
two, usually one provider and one set of creds) the per-bucket file is redundant with the
set/user layers, and even the AWS-plus-R2 edge case is no more than setting up each set's env
once. Per [0006](0006-minimal-code.md) / the don't-over-engineer edict, that fails the
"generalise when the second case actually appears" bar.

Removing it deletes a whole precedence layer plus the circular-resolution dance (resolve the
bucket from set/user/shell *first*, then load its env) and the "resolve only from
authoritative signals" subtlety in `loadEnv`. It is cheaply reversible while pre-1.0 if the
multi-bucket/multi-set-same-auth case ever shows up.

## Consequences

- `bucketEnvPath` and the per-bucket branch of `loadEnv` go.
- The bucket-name-in-path guard `assertPathSegment` is **not** retired by this — the
  `objects.<bucket>` cache file ([objects.mjs](../../src/lib/objects.mjs)) still interpolates
  the bucket name into a local path and keeps the guard earning its keep.
- This refines, not reopens, [0015](0015-standard-aws-credential-chain.md) (the standard AWS
  credential chain) and [0022](0022-prepare-remote-set-front-door.md) (the env-load front
  door); the front door stays, with one fewer layer to load.
