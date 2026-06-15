# Running the S3 integration tests

s3cab's test suite has a tier of **real-S3 integration tests** — they round-trip
against an actual bucket (backup → restore, listing, verified download). They are
**opt-in**: each is gated on the `S3CAB_TEST_BUCKET` environment variable and is
skipped (with a message) when it is unset, so a normal `npm test` with no cloud
credentials stays green.

This guide shows how to point those tests at a bucket of your own — first the quick
local path, then a full GitHub Actions CI setup with short-lived OIDC credentials.
Everything works on **Windows, macOS and Linux**; where a command differs by shell,
both forms are given.

> The strategy and the *why* behind these choices live in
> [specs/testing.md](../specs/testing.md). This guide is the *how*.

---

## What the tests need

These environment inputs (the bucket and credentials are required; region defaults
to `us-east-1`):

| Variable | Purpose |
| --- | --- |
| `S3CAB_TEST_BUCKET` | the bucket to test against — its presence flips the gated suites on |
| `AWS_REGION` | the bucket's region (defaults to `us-east-1` if unset) |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` (+ `AWS_SESSION_TOKEN`) | credentials, **from the environment** |

> **Credentials must come from environment variables, not `~/.aws`.** The tests
> redirect `HOME` / `USERPROFILE` to a temp dir so they don't read your real config —
> which means an `~/.aws` profile or a cached SSO session is invisible to them. Export
> the keys explicitly (see below). The bucket may be on AWS or any S3-compatible
> provider (see [Non-AWS providers](#non-aws-providers)).

The credentials only need `Get/Put/Delete` on objects and `ListBucket` on the bucket —
see [least-privilege policy](#least-privilege-iam-policy). `Delete` is required because
tests clean up after themselves. Test content is unique per run, so concurrent runs
don't collide and cleanup is exact.

---

## Quick start: run locally against your own bucket

### 1. Create a bucket

From a clone of the repo, the bundled script creates the bucket and a 1-day
auto-expiry rule in one cross-platform step (it uses the AWS SDK s3cab already
depends on — no AWS CLI needed):

```sh
node scripts/setup-test-bucket.mjs your-test-bucket
```

Region comes from `AWS_REGION` / `AWS_DEFAULT_REGION` (default `us-east-1`). The
script is idempotent — re-running against a bucket you own is a no-op.

Prefer the raw AWS CLI, or not working from a clone? See
[Create the bucket by hand](#appendix-create-the-bucket-by-hand).

### 2. Export bucket + credentials

**Linux / macOS (bash/zsh):**

```sh
export S3CAB_TEST_BUCKET=your-test-bucket
export AWS_REGION=us-east-1
export AWS_ACCESS_KEY_ID=AKIA...
export AWS_SECRET_ACCESS_KEY=...
# export AWS_SESSION_TOKEN=...   # only if using temporary credentials
```

**Windows (PowerShell):**

```powershell
$env:S3CAB_TEST_BUCKET = "your-test-bucket"
$env:AWS_REGION = "us-east-1"
$env:AWS_ACCESS_KEY_ID = "AKIA..."
$env:AWS_SECRET_ACCESS_KEY = "..."
# $env:AWS_SESSION_TOKEN = "..."   # only if using temporary credentials
```

> Using AWS IAM Identity Center (SSO)? Turn an active session into environment
> variables with `aws configure export-credentials --format env` (bash) and paste the
> output, rather than logging in — remember the tests can't see the SSO cache.

### 3. Run the tests

```sh
npm test
```

The previously-skipped S3 suites now execute. Objects created during a run expire
within ~a day even if a run crashes before cleanup (see [Cost safety](#cost-safety)).

---

## Running in CI with GitHub Actions (OIDC)

For CI, avoid long-lived keys entirely: GitHub Actions can present a signed **OIDC**
token that AWS exchanges for a short-lived credential, gated so it is only ever issued
to an approved run. This is the setup s3cab itself uses.

The security model — **real S3 runs only on same-repo pull requests, behind a
required-reviewer approval gate; fork PRs get no credentials and skip** — is explained
in [specs/testing.md](../specs/testing.md). The pieces below implement it.

> Creating the IAM policy and role requires an **administrator** session.
> `PowerUserAccess` (and similar) cannot write IAM.

### 1. Least-privilege IAM policy

Grant only what the tests use, scoped to the one bucket. Save as `policy.json`
(substitute your bucket name):

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "TestBucketObjects",
      "Effect": "Allow",
      "Action": ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
      "Resource": "arn:aws:s3:::your-test-bucket/*"
    },
    {
      "Sid": "TestBucketList",
      "Effect": "Allow",
      "Action": ["s3:ListBucket"],
      "Resource": "arn:aws:s3:::your-test-bucket"
    }
  ]
}
```

Note the two-statement split: object actions target `…/*`, but the bucket-level
`ListBucket` targets the bare bucket ARN. Create it:

```sh
aws iam create-policy --policy-name s3cab-ci-test-access --policy-document file://policy.json
```

Keep the **policy ARN** it prints for the next step.

### 2. Register the GitHub OIDC provider (once per account)

Check whether it already exists — accounts often have it from other workflows:

```sh
aws iam list-open-id-connect-providers
```

If there is no `token.actions.githubusercontent.com` entry, create it:

```sh
aws iam create-open-id-connect-provider --url https://token.actions.githubusercontent.com --client-id-list sts.amazonaws.com --thumbprint-list 6938fd4d98bab03faadb97b34396831e3780aea1 1c58a3a8518e8759bf075b76b750d4f2df264fcd
```

(AWS no longer relies on the thumbprint to verify GitHub's IdP, but the API still
requires the parameter; those are the published values.)

### 3. Create the role with an environment-scoped trust policy

The trust policy is the heart of the gate. Scoping the `sub` claim to a GitHub
**Environment** means the role is **un-assumable except from a job running in that
environment** — and that environment requires reviewer approval. Save as
`trust-policy.json`, substituting your account ID and `your-org/your-repo`:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "Federated": "arn:aws:iam::<ACCOUNT_ID>:oidc-provider/token.actions.githubusercontent.com"
      },
      "Action": "sts:AssumeRoleWithWebIdentity",
      "Condition": {
        "StringEquals": {
          "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
          "token.actions.githubusercontent.com:sub": "repo:your-org/your-repo:environment:s3-integration-tests"
        }
      }
    }
  ]
}
```

Create the role and attach the policy from step 1:

```sh
aws iam create-role --role-name s3cab-ci --assume-role-policy-document file://trust-policy.json
aws iam attach-role-policy --role-name s3cab-ci --policy-arn arn:aws:iam::<ACCOUNT_ID>:policy/s3cab-ci-test-access
```

> Keeping your account ID out of a public repo: commit `trust-policy.json` with an
> `ACCOUNT_ID` placeholder and substitute it only at apply time —
> `sed "s/ACCOUNT_ID/<your-id>/" trust-policy.json > trust.tmp.json` (bash) or
> `(Get-Content trust-policy.json -Raw).Replace('ACCOUNT_ID','<your-id>') | Set-Content trust.tmp.json`
> (PowerShell) — then delete the temp file. Store the resulting **role ARN** as a
> GitHub secret (next step) rather than hard-coding it in the workflow.

### 4. Create the approval-gated GitHub Environment

In the repository on GitHub: **Settings → Environments → New environment**, named
`s3-integration-tests` (must match the trust policy's `sub`). Then:

- **Required reviewers** — add yourself / trusted maintainers. Nothing credentialed
  runs until a reviewer approves, so an untrusted PR cannot cause any spend.
- Add an environment **secret** `AWS_ROLE_ARN` = the role ARN from step 3 (keeps the
  account ID out of the workflow file).
- Add an environment **variable** `S3CAB_TEST_BUCKET` = your bucket name.

### 5. Add the workflow job

A job that references the environment, requests the OIDC token, assumes the role, and
runs the suite. Skip it on fork PRs (which get no secrets by design):

```yaml
s3-integration:
  # Same-repo PRs only — forks get no credentials and are covered by the
  # offline mocked-seam tests instead. (Also skips push/non-PR events: with no
  # PR context the comparison is false.)
  if: github.event.pull_request.head.repo.full_name == github.repository
  runs-on: ubuntu-latest
  environment: s3-integration-tests # the approval gate
  permissions:
    id-token: write # mint the OIDC token
    contents: read
  steps:
    - uses: actions/checkout@v6
    - uses: actions/setup-node@v6
      with:
        node-version: 26.3.0
    - run: npm ci
    - uses: aws-actions/configure-aws-credentials@v6
      with:
        role-to-assume: ${{ secrets.AWS_ROLE_ARN }}
        aws-region: us-east-1
    - run: npm test
      env:
        S3CAB_TEST_BUCKET: ${{ vars.S3CAB_TEST_BUCKET }}
```

Only **one** OS runs the S3 tests — the S3 code path doesn't branch on platform, so a
single `ubuntu-latest` runner is enough.

---

## Non-AWS providers

The tests are provider-agnostic: point them at any S3-compatible service (Cloudflare
R2, Backblaze B2, MinIO, …) by also setting an endpoint:

```sh
export AWS_ENDPOINT_URL_S3=https://<your-endpoint>
```

s3cab automatically drops AWS-only request features (SSE, intelligent-tiering, and the
default integrity-checksum trailer) when a custom endpoint is set, so a plain bucket on
another provider works. Credentials are still the provider's access key / secret in the
same `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` variables.

---

## Cost safety

A throwaway test bucket should never surprise you on the bill:

- **Lifecycle auto-expiry** — the setup script adds a rule expiring objects after 1 day
  (and aborting incomplete multipart uploads after 1 day). This caps cost and
  self-heals orphans left by a test that crashes before cleanup. To add it by hand, see
  the [appendix](#appendix-create-the-bucket-by-hand).
- **A cost backstop** guards against a runaway loop (a misbehaving test spamming
  requests). The simplest is an account-level **cost budget** in AWS Budgets that emails
  you when spend crosses a threshold. **Important caveat:** a budget with no cost filter
  tracks your **whole account's** spend, not this bucket's — so set its limit *above your
  normal monthly baseline* (a $5 budget on an account already spending $9 just fires
  immediately). It's an account safety net, not a per-bucket figure. If you already keep
  an account budget, you likely need nothing more here.

  ```json
  // budget.json — limit above your baseline
  { "BudgetName": "account-cost", "BudgetLimit": { "Amount": "<above-baseline>", "Unit": "USD" }, "TimeUnit": "MONTHLY", "BudgetType": "COST" }
  ```
  ```json
  // notifications.json — substitute your email
  [ { "Notification": { "NotificationType": "ACTUAL", "ComparisonOperator": "GREATER_THAN", "Threshold": 80, "ThresholdType": "PERCENTAGE" }, "Subscribers": [ { "SubscriptionType": "EMAIL", "Address": "you@example.com" } ] } ]
  ```
  ```sh
  aws budgets create-budget --account-id <ACCOUNT_ID> --budget file://budget.json --notifications-with-subscribers file://notifications.json
  ```

  To alert on *this bucket specifically* instead, add a cost-allocation tag to the bucket
  and filter the budget by it (the tag must be activated in Billing first, which can take
  ~a day) — usually overkill for a throwaway bucket the lifecycle rule already keeps near
  $0. AWS Budgets works in Organization member accounts; on a standalone or *management*
  account a CloudWatch `EstimatedCharges` alarm (us-east-1) + SNS email is an alternative.

---

## Appendix: create the bucket by hand

If you can't use the Node script, the equivalent AWS CLI is:

```sh
# us-east-1 is the API default and must NOT carry a LocationConstraint; any other
# region requires "--create-bucket-configuration LocationConstraint=<region>".
aws s3api create-bucket --bucket your-test-bucket --region us-east-1
aws s3api put-bucket-lifecycle-configuration --bucket your-test-bucket --lifecycle-configuration file://lifecycle.json
```

with `lifecycle.json`:

```json
{
  "Rules": [
    {
      "ID": "expire-test-objects",
      "Status": "Enabled",
      "Filter": {},
      "Expiration": { "Days": 1 },
      "AbortIncompleteMultipartUpload": { "DaysAfterInitiation": 1 }
    }
  ]
}
```
