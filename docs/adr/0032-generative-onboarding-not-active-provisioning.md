# Cloud onboarding is generative, not active

**Status:** accepted (the `bucket` command is built; its *shape* is
[0034](0034-bucket-command-shape.md) and its *security model* [0033](0033-bucket-onboarding-security-model.md)).
Delivery form **amended by [0056](0056-onboarding-via-cloudformation.md)** — still generative, but
now a CloudFormation template the user applies, not imperative `aws` commands. The generative-not-active
decision this ADR records **stands**.

The cloud-onboarding command (`bucket`) helps a user stand up an S3
bucket + a least-privilege identity for s3cab. It does this **generatively** — it *prints* the
exact `aws` CLI commands and policy/lifecycle JSON for the user to run — rather than
**actively** calling AWS APIs (CreateBucket, CreateUser, PutUserPolicy, CreateAccessKey)
itself. This records why, because the question re-litigated itself twice during design and a
future reader will see a print-only command and reasonably wonder "why doesn't s3cab just
create the bucket — it already has the SDK?".

## Why generative

- **Active only helps a narrow group, and barely.** To run active provisioning you need admin
  credentials configured locally — which almost always means you already have the AWS CLI, so
  you can equally paste the generated commands. Active's only unique edge (auto-wiring the
  secret so it never hits the screen) applies to one sub-step for AWS-only users.
- **It optimizes the cheap part and leaves the fiddly part.** Only bucket creation /
  versioning / lifecycle could be done actively without new costs; the IAM user + access-key + secret
  transfer — the genuinely fiddly steps — must stay manual regardless. Low return.
- **It would reverse a settled posture.** Active means s3cab wields your admin credentials to
  mutate your account and (for the key path) owns secret material again — the exact "manager,
  not consumer" role [ADR-0015](0015-standard-aws-credential-chain.md) deliberately shed.
- **Generative serves everyone.** S3-compatible providers (R2/B2/Wasabi/…) have **no IAM** and
  no uniform provisioning API, so active could never serve them; generative degrades naturally
  to per-provider console steps + an env template. It is also transparent (you read exactly
  what will touch your data before anything happens) and adds no dependency or error-handling /
  idempotency burden — the `aws` CLI reports its own errors.

## Rejected alternatives

- **Fully active (SDK).** Needs `@aws-sdk/client-iam` (a heavyweight new dependency,
  [ADR-0005](0005-builtins-over-dependencies.md)) and forces s3cab to handle the minted secret.
  Rejected for the posture + dependency + secret-ownership costs above.
- **Active via shelling out to the `aws` CLI.** Requires the CLI present anyway, is less
  transparent, and is harder to error-handle than simply printing the commands — strictly worse
  than generative. Rejected.
- **Bucket-only active** (s3cab actively does the non-secret create/versioning/lifecycle steps,
  generates the IAM steps). Tempting because those calls need no IAM dep and touch no secret —
  but it saves only the *cheapest* pastes, reintroduces s3cab using admin creds to mutate the
  account, and creates a confusing half-active/half-generative seam (worse mental model than one
  consistent "here's the plan, you run it"). Rejected for v1; an optional `--run` for these
  steps is left open as possible future work, not built.

## Consequences

- The command is purely local/offline — no S3, no credentials needed to *run* it.
- One source of truth for the bucket IAM policy: the command emits `bucketPolicy()`, which the
  integration-testing docs also reference (the dogfood decision, now built — see
  [0033](0033-bucket-onboarding-security-model.md)).
- An optional future `--run` mode (actively performing the non-secret bucket steps) stays open
  but out of scope — recorded in [proposals/cloud-cleanup.md](../../proposals/cloud-cleanup.md).
