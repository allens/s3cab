# Cloud onboarding emits CloudFormation templates; `--sso` retired

**Status:** accepted. Amends
[0032](0032-generative-onboarding-not-active-provisioning.md) — its generative principle stands,
only the delivery form changes; carries [0033](0033-bucket-onboarding-security-model.md)'s
protections into the template; amends [0035](0035-aws-profile-sets-command-rationalization.md) —
the `--sso` identity fork is dropped.

`s3cab aws` onboards a bucket + a backup identity. [ADR-0032](0032-generative-onboarding-not-active-provisioning.md)
framed the delivery choice as *print imperative `aws` commands* (generative) vs *s3cab calls the
AWS APIs* (active), and chose generative. It never weighed a **third** generative form: emit a
declarative **CloudFormation template** the user applies with one `aws cloudformation deploy`. We
adopt that for every `s3cab aws` path.

## Still generative — 0032 preserved, not overturned

s3cab writes a local file; the **user** applies it with **their** admin creds. s3cab makes no AWS
calls, needs no creds to generate, owns no secret, adds no `client-iam`. Every property 0032
protected holds; only imperative→declarative changes — and a reviewable YAML is if anything *more*
transparent than an ordered command sequence.

## Why it beats a command list

- **No ARN threading.** The RA path ([0057](0057-roles-anywhere-credential-mode.md)) has
  inter-resource dependencies (trust-anchor ARN → profile; role ARN → profile). Imperative
  commands force the user to capture ARNs from one output and paste into the next — the classic
  error. CloudFormation resolves references itself.
- **One shell-agnostic command.** `aws cloudformation deploy … --capabilities CAPABILITY_NAMED_IAM`,
  identical on PowerShell/bash — no shell-quoting variance.
- **Updatable + teardownable.** Change the lifecycle window → redeploy; regenerate RA →
  `delete-stack`.

## The one thing kept out of CF: the access-key secret

The default IAM-user identity's payload is an AWS-generated **access-key secret**.
`AWS::IAM::AccessKey` would materialize it in **CloudFormation stack state/outputs** (retrievable
via `GetTemplate`/`DescribeStacks`) — worse than printing it once to a terminal, and the "owns
secret material" trap 0032 named. So **`create-access-key` stays a single manual step** (secret to
terminal only). This yields the governing rule: **the delivery form tracks the secret.** Secretless
identities (Roles Anywhere — the private key is local, never in the template) go fully into CF; the
secret-bearing IAM-user path puts everything *except* the key into CF. RA fits CF *because* it has
no AWS secret — a deliberate asymmetry, not an inconsistency.

## `--sso` is retired

SSO had no self-contained onboarding recipe, and CloudFormation makes that plain. SSO access is a
permission set → an assumed IAM role; for that role to reach the bucket, either (a) an **admin**
widens the permission set (org management/delegated account — not self-serve), or (b) a **bucket
resource policy** names the role ARN. The dedicated-IAM-user path sidesteps this by *creating its
own identity* with the policy attached; SSO creates none. Note the least-privilege policy is an
**identity** policy on the dedicated user/role — **not a bucket resource policy** — so it never
gates other principals: a broadly-privileged SSO user (e.g. PowerUser, which includes `s3:*`)
already reaches the bucket with **nothing** SSO-specific — create the bucket, then
`provider --profile`. A narrowly-scoped one needs their admin. Either way there is nothing for a
`--sso` flag to usefully script, so it is dropped (amending
[0035](0035-aws-profile-sets-command-rationalization.md)). SSO still works through the standard
chain; the guide keeps a one-line pointer, not a command path.

## Command shape

`s3cab aws <bucket>` (no flag) is the **IAM-user** path — now three short steps: deploy the
template, `aws iam create-access-key --user-name s3cab-<bucket>-user`, `provider --keys`. Its
closing line advertises **`--roles-anywhere`** (recommended, keyless —
[0057](0057-roles-anywhere-credential-mode.md)) as the alternative. `--roles-anywhere` stays a
**flag**, not a display section, because it is a different *action* (it writes local certs + a
different template); one invocation cannot produce both. Net identity fork: **default = IAM-user
(keys), `--roles-anywhere` = keyless, `--sso` gone.**

## Resources & names

One template + one stack per `s3cab aws <bucket>` run (bucket + that run's identity); single-bucket
common case ([0013](0013-one-repository-one-bucket.md)); multi-bucket RA-identity reuse deferred
([0006](0006-minimal-code.md)). Named for predictability (hence `CAPABILITY_NAMED_IAM`):

| Resource | Name |
| --- | --- |
| S3 bucket | `<bucket>` *(verbatim — the user's own name)* |
| Stack | `s3cab-<bucket>` |
| IAM user (default) | `s3cab-<bucket>-user` |
| IAM **managed** policy (`bucketPolicy()`) | `s3cab-<bucket>-policy` |
| IAM role (RA) | `s3cab-<bucket>-role` |
| RA trust anchor | `s3cab-<bucket>-trust-anchor` |
| RA profile | `s3cab-<bucket>-profile` |

**Naming scheme:** the **stack** is the *container* and takes the bare `s3cab-<bucket>` stem;
everything it creates hangs off that stem with an **AWS-type suffix** (`-user`, `-role`, `-policy`,
…), so a name is predictable from the bucket + the resource type and one bucket's whole footprint
sorts contiguously (the stack heads it) in any name-ordered view. The **bucket** is the one name the
user owns, so it is used **verbatim** — no `s3cab-` prefix, no suffix. Because bucket names are
global, users often prefix theirs with `s3cab-` for uniqueness; a single leading `s3cab-` is
therefore **stripped** from the bucket before it goes into a derived name, so `s3cab aws
s3cab-photos` yields `s3cab-photos-user` (not `s3cab-s3cab-photos-user`) — the bucket itself stays
`s3cab-photos`.

`bucketPolicy()` becomes a **managed** policy so the *same* object attaches to the IAM user
(default) and the RA role (RA path) — one policy, reused (cleaner than 0033's inline
`put-user-policy`).

**Tags:** every taggable resource carries `ManagedBy=s3cab` (attribution) and `s3cab:bucket=<bucket>`
(association), applied as `Tags:` **in the template** — not the deploy `--tags` — so they travel with
the artifact however the user applies it (console, CLI, CI), and the whole footprint is discoverable
by tag, not only by name. The one exception is `AWS::IAM::ManagedPolicy`, which CloudFormation gives
no `Tags` property (the IAM API tags managed policies, the CFN resource does not) — tagging it fails
early validation, so it is left untagged.

## Bucket protections in the template ([0033](0033-bucket-onboarding-security-model.md))

Versioning ON, noncurrent-version lifecycle window, the managed `bucketPolicy()`, **SSE-S3 default
encryption** (new — explicit though AWS now defaults it), and **`DeletionPolicy: Retain` +
`UpdateReplacePolicy: Retain` on the bucket** so a stack delete can never destroy backups. RA trust
anchor/role/profile carry no such guard — regenerable.

## Rejected

- **Keep imperative print** — loses ARN-threading, cross-platform, updatability; RA especially
  suffers.
- **Active SDK provisioning** — rejected exactly as 0032 did (admin creds, `client-iam`, secret
  ownership, can't serve non-AWS).
- **Half CF / half inline** — the split-delivery seam 0032 rejected.
- **SSO permission sets in CF** (`AWS::SSO::PermissionSet`/`Assignment`) — needs
  org-management/delegated-admin context and identity-store lookups, and pollutes org-wide identity
  config; wrong for a self-service backup tool.

## Consequences

`awsIamPlan`/`awsSsoPlan` (`src/lib/aws.mjs`) change from command text to a CF template;
`awsSsoPlan` is removed. Non-AWS providers keep the `help provider` redirect.
