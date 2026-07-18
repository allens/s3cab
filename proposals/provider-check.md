# `provider --check` — a connection probe

Split out of `provider-ux.md` 2026-07-18 for visibility: it is a fully-fledged item with a
problem, a sketch, and open shape questions, not a one-liner. Surfaced by the ADR-0047 session
(2026-07-09). **Needs a shape discussion before building** — start with the `cli-design` skill.

## Problem

After `provider --endpoint … --region … --keys`, there is no way to learn whether the
configuration *works* short of running a real, stateful command (`setup`, which also claims
the remote set name as a side effect). Every credential CLI has a "did it work?" probe
(`aws sts get-caller-identity`); s3cab has nothing between "configured" and "first backup".

The categorized error relay ([ADR-0037](../docs/adr/0037-aws-auth-error-categorization.md))
already produces good by-cause messages for exactly this moment — bad secret → signature
advice, wrong endpoint, clock skew, access denied. A probe would give it a deliberate trigger
instead of waiting for a real command to trip it.

## Sketch

One cheap authenticated call (e.g. LIST with `MaxKeys: 1`) against a bucket, reporting success
("Connected to `<endpoint/bucket>` as …") or relaying the categorized failure. Exit 0 /
non-zero so scripts can gate on it.

## Shape questions to grill

- **Operand:** a bucket (`provider --check <bucket>` — but the positional slot is `[<set>]`),
  a set (probe its bound bucket + its env layer — the realistic end-to-end check), or both
  (set when given, else… the user scope has no bucket to probe)?
- **Flag vs command:** `provider --check` mixes a *doing* mode into a config command (the
  ADR-0035 rejected-merge concern) — is a separate tiny command (`s3cab check`?
  `s3cab provider-check`?) cleaner, or is the mode acceptable because it reads (not writes)
  the same config the command owns?
- **Name:** `--check` vs `--test` vs `--verify` — avoid `verify`, which is taken by the
  repository-integrity command (real confusion risk).
- **What to probe with only user-scope config and no set/bucket yet?** `HeadBucket` needs a
  bucket; `ListBuckets` is often denied to scoped tokens.
