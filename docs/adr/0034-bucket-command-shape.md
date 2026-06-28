# The `bucket` command: a separate, generative cloud-onboarding command

> **Command name superseded by [0035](0035-aws-profile-sets-command-rationalization.md)**
> (accepted): the cloud-onboarding command described here is now **`s3cab aws`**. Its
> separateness, generative posture, and flags below all stand unchanged — only the
> "## The name `bucket`" section's naming argument is what 0035 replaces. The `bucket`
> form throughout this ADR (and the then-current `s3cab aws`/`s3cab setup` in its compose
> example, now `s3cab profile`/`s3cab sets`) is the *historical* naming.

`s3cab bucket <bucket>` prints the steps to stand up an S3 bucket as a backup destination plus
a least-privilege identity for s3cab. This ADR records its *shape* — name, where it sits among
the commands, and its flags — which are not obvious from the code. Its two other pillars have
their own ADRs: it is **generative, not active** ([0032](0032-generative-onboarding-not-active-provisioning.md)),
and its **security model** is [0033](0033-bucket-onboarding-security-model.md).

## A separate top-level command — not part of `setup` or `aws`

Provisioning a bucket + identity is a **rare, one-time, per-bucket bootstrap**, so it is its own
command rather than folded into either neighbour:

- **Not `setup`** — `setup` is a per-set operation run many times; bucket onboarding happens
  once per bucket, before any set exists.
- **Not `aws`** — `aws` is the narrow "point at an *existing* profile" door
  ([0031](0031-aws-profile-config-door.md)); `bucket` *creates* the destination + scoped
  identity.

They **compose** rather than overlap: `bucket`'s final step is `s3cab aws --profile <name>`,
then `s3cab setup … --bucket <bucket>`.

## The name `bucket`

A **noun-command** (à la `git remote`). It is honest for a generative command — it does not
over-claim creation the way a verb (`provision`, `create`) would — and `bucket` is already
first-class s3cab vocabulary (`setup --bucket`, `hashes <bucket>`, "one repository is one
bucket"). Consumer-vocabulary naming, [0012](0012-consumer-vocabulary-naming.md).

## Flags

- **positional `<bucket>`** (required) — the bucket name; validated by `validateBucketName`.
- **`--sso`** (boolean) — print the AWS IAM Identity Center recipe instead of the IAM-user one.
  Boolean rather than `--identity iam|sso` so the simplest user (who may not know the term
  "IAM") types *nothing* for the default, and `--sso` is the word its own audience reaches for.
  The default (IAM) output ends with a one-line *"…Re-run with `--sso`"* pointer, so SSO is
  advertised, not hidden.
- **`--profile <name>`** — output *sugar* only: interpolated into the printed `aws …` commands
  (`--profile admin`). Never used to authenticate — the command is offline (generative).
- **`--region <region>`** — for the create-bucket command; defaults `$AWS_REGION` →
  `$AWS_DEFAULT_REGION` → `us-east-1`, like `scripts/setup-test-bucket.mjs`. The us-east-1
  `LocationConstraint` quirk (the API default rejects a `LocationConstraint`; every other region
  requires one) is handled in the generated text.
- **Non-AWS is auto-detected, not a flag** — a custom endpoint (`AWS_ENDPOINT_URL_S3` /
  `AWS_ENDPOINT_URL`, the same signal `s3.mjs`'s `customEndpoint()` reads) selects the
  provider-neutral recipe and wins over `--sso` (there is no Identity Center off AWS).

## Three pieces; only the identity step forks

The feature decomposes so the variants stay small: **(1)** bucket setup (create + versioning +
lifecycle) and **(2)** the policy are *identity-agnostic* — identical for everyone; only **(3)**
the identity step forks, into the IAM-user default, the `--sso` recipe (B-light = reuse your
sign-in, plus a separated advanced dedicated-permission-set block), and the non-AWS path (no
IAM, so a `~/.s3cab/env` template instead of a policy). The plan text lives in pure, testable
generators in [src/lib/onboarding.mjs](../../src/lib/onboarding.mjs); the command is a thin
porcelain that resolves region/profile/endpoint, routes, and writes to stdout
([0010](0010-cli-output-conventions.md)) — the plan *is* the result.

## Consequences

- A new top-level command and one `src/commands/` file (one export — [0023](0023-porcelain-plumbing-lib-layers.md)),
  plus the `lib/onboarding.mjs` generators.
- Purely local/offline: no S3, no credentials needed to *run* it, so the whole plan can be read
  before any credential exists.
- `--run` (an optional future mode that would *actively* perform the non-secret bucket steps) and
  a future **cleanup** command are out of scope — recorded in
  [proposals/cloud-cleanup.md](../../proposals/cloud-cleanup.md).
