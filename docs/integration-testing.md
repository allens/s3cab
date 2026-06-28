# Running the S3 integration tests

s3cab's test suite has a tier of **real-S3 integration tests** — they round-trip against
an actual bucket (backup → restore, listing, verified download). They are **opt-in**:
each is gated on the `S3CAB_TEST_BUCKET` environment variable and is skipped (with a
message) when it is unset, so a plain `npm test` with no credentials stays green.

This guide is the **how**: first **[local development](#local-development)** (run them on
your machine), then **[continuous integration](#continuous-integration-github-actions)**
(run them in GitHub Actions with short-lived OIDC credentials). Everything works on
**Windows, macOS and Linux** — where a command differs by shell, both forms are given.

> The strategy and the *why* live in [docs/specs/testing.md](specs/testing.md).

---

## What the tests need

| Input | Notes |
| --- | --- |
| `S3CAB_TEST_BUCKET` | the bucket to test against — its presence flips the gated suites on |
| AWS credentials | resolved from your AWS config (profile / SSO / env), with `Get/Put/Delete` on objects + `ListBucket` |
| `AWS_REGION` | the bucket's region (defaults to `us-east-1`) |

`Delete` is required because the tests clean up after themselves (content is unique per
run, so cleanup is exact and concurrent runs don't collide).

> The tests isolate s3cab's own state by pointing **`S3CAB_HOME`** at a temp dir — they
> leave the OS `HOME` alone, so your real `~/.aws` (profiles, SSO sessions) resolves
> normally and any identity the AWS CLI/SDK can use just works.

---

## Create a bucket

Needed for both local and CI. From a clone, the bundled script creates the bucket **and**
a 1-day auto-expiry rule in one cross-platform step (it uses the AWS SDK s3cab already
depends on — no AWS CLI needed):

```sh
node scripts/setup-test-bucket.mjs your-test-bucket
```

Region comes from `AWS_REGION` / `AWS_DEFAULT_REGION` (default `us-east-1`); the script is
idempotent. Prefer raw `aws` CLI, or not in a clone? See the
[appendix](#appendix-create-the-bucket-by-hand).

---

## Local development

### Configure once

Put your non-secret settings in a gitignored `.env.test` (copy
[`.env.test.example`](../.env.test.example)) — **no credentials go here**:

```ini
S3CAB_TEST_BUCKET=your-test-bucket
AWS_REGION=us-east-1
AWS_PROFILE=your-profile   # the ~/.aws profile to use; omit for the default
```

### Run

```sh
aws sso login          # only if your profile is SSO and the session has expired
npm run test:s3
```

`test:s3` loads `.env.test` and runs the gated suites. Because the tests relocate only
s3cab's own home (via `S3CAB_HOME`) and leave `HOME` alone, the AWS SDK resolves
credentials from your `~/.aws` profile exactly as the real app would — so **any** identity
works, no credential juggling:

| Identity | One-time setup | Per session |
| --- | --- | --- |
| **IAM user** (long-lived keys) | `aws iam create-access-key --user-name <you>` (or the IAM console) | — (keys don't expire) |
| **IAM Identity Center (SSO)** | `aws configure sso` | `aws sso login` |
| **Assumed role** (profile with `role_arn` + `source_profile`) | add the profile to `~/.aws/config` | depends on the source identity |

For least privilege, point `AWS_PROFILE` at an identity scoped to just the test bucket
(`Get/Put/Delete` + `ListBucket` — the [same policy CI uses](#1-least-privilege-iam-policy));
your normal admin/PowerUser profile works too. Prefer not to keep a `.env.test`? Set those
three variables in your shell instead and run `npm test`.

---

## Continuous integration (GitHub Actions)

For CI, avoid long-lived keys entirely: GitHub Actions presents a signed **OIDC** token
that AWS exchanges for a short-lived credential. This is the setup s3cab itself uses; its
security model (real S3 runs automatically on **same-repo** PRs — which only collaborators
can open — while fork PRs get no credentials and skip) is in
[docs/specs/testing.md](specs/testing.md).

> Creating the IAM policy and role needs an **administrator** session — `PowerUserAccess`
> (and similar) cannot write IAM.

### 1. Least-privilege IAM policy

This is the **same** least-privilege policy s3cab's onboarding generates — `bucketPolicy()`
in [`src/lib/s3.mjs`](../src/lib/s3.mjs), which `s3cab aws` emits and the everyday backup
identity is scoped to. With explicit verbs the backup and test policies are identical, so one
definition serves both; on AWS (with no custom endpoint set), `s3cab aws your-test-bucket`
prints exactly this JSON.

Save as `policy.json` (substitute your bucket). The two-statement split matters: object
actions target `…/*`, the bucket-level `ListBucket` targets the bare bucket ARN.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "ListBucket",
      "Effect": "Allow",
      "Action": ["s3:ListBucket"],
      "Resource": ["arn:aws:s3:::your-test-bucket"]
    },
    {
      "Sid": "ObjectAccess",
      "Effect": "Allow",
      "Action": ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
      "Resource": ["arn:aws:s3:::your-test-bucket/*"]
    }
  ]
}
```

```sh
aws iam create-policy --policy-name s3cab-ci-test-access --policy-document file://policy.json
```

### 2. Register the GitHub OIDC provider (once per account)

```sh
aws iam list-open-id-connect-providers   # skip the next step if it already lists one
aws iam create-open-id-connect-provider --url https://token.actions.githubusercontent.com --client-id-list sts.amazonaws.com --thumbprint-list 6938fd4d98bab03faadb97b34396831e3780aea1 1c58a3a8518e8759bf075b76b750d4f2df264fcd
```

(AWS no longer relies on the thumbprint to verify GitHub's IdP, but the API still requires
the parameter; those are the published values.)

### 3. Create the role with a pull-request-scoped trust policy

Scoping the `sub` claim to `:pull_request` makes the role **assumable only from a workflow
running on a pull request in this repo**. A same-repo PR can only be opened by a
collaborator with push access, so an untrusted actor can't reach it — and a fork PR gets no
OIDC token at all (GitHub's design), so it can't either. Save as `trust-policy.json`
(substitute account ID + `your-org/your-repo`):

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
          "token.actions.githubusercontent.com:sub": "repo:your-org/your-repo:pull_request"
        }
      }
    }
  ]
}
```

```sh
aws iam create-role --role-name s3cab-ci --assume-role-policy-document file://trust-policy.json
aws iam attach-role-policy --role-name s3cab-ci --policy-arn arn:aws:iam::<ACCOUNT_ID>:policy/s3cab-ci-test-access
```

> Keep your account ID out of a public repo: commit `trust-policy.json` with an
> `ACCOUNT_ID` placeholder, substitute it only at apply time (`sed`, or PowerShell's
> `(Get-Content … -Raw).Replace(…)`) into a temp file you delete, and store the resulting
> **role ARN** as a GitHub secret (next step) rather than hard-coding it.

### 4. Add the repo secret and variable

In the repo on GitHub: **Settings → Secrets and variables → Actions**:

- **Secret** `AWS_ROLE_ARN` = the role ARN (keeps the account ID out of the workflow file).
- **Variable** `S3CAB_TEST_BUCKET` = your bucket name.

> **Want an explicit approval click too?** If you grant push access broadly and don't want
> every collaborator's PR to spend automatically, add a GitHub **Environment** with required
> reviewers: scope the trust policy's `sub` to `…:environment:<name>` instead of
> `:pull_request`, put the secret/var on the Environment, and add `environment: <name>` to
> the job below. s3cab itself doesn't — a same-repo PR already implies a trusted author, and
> spend is capped by the IAM scope + 1-day lifecycle + cost backstop (below).

### 5. Add the workflow job

```yaml
s3-integration:
  # Same-repo PRs only — forks get no credentials and are covered by the offline
  # mocked-seam tests instead. Only collaborators can open a same-repo PR, so the
  # credentialed run never triggers for an untrusted actor. (No `environment:` line:
  # it runs automatically — no approval click.)
  if: github.event.pull_request.head.repo.full_name == github.repository
  runs-on: ubuntu-latest
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

One OS only — the S3 code path doesn't branch on platform.

### 6. (Optional) enforce it as a required check

Because this job is **skipped** on fork PRs, marking it directly as a required status check
would leave every fork PR forever-pending (a skipped required check never reports). Instead
add a tiny always-running gate job that fails only if a job that actually ran failed (a
skipped job is not a failure), and make **that** the required check. See `ci-gate` in
[`.github/workflows/ci.yml`](../.github/workflows/ci.yml) for the pattern s3cab uses.

---

## Non-AWS providers

The tests are provider-agnostic: point them at any S3-compatible service (Cloudflare R2,
Backblaze B2, MinIO, …) by also setting an endpoint:

```sh
export AWS_ENDPOINT_URL_S3=https://<your-endpoint>
```

s3cab automatically drops AWS-only request features (SSE, intelligent-tiering, the default
integrity-checksum trailer) when a custom endpoint is set, so a plain bucket elsewhere
works. Credentials are still the provider's access key / secret in the same `AWS_*` vars.

---

## Cost safety

A throwaway test bucket should never surprise you on the bill:

- **Lifecycle auto-expiry** — the setup script adds a rule expiring objects after 1 day
  (and aborting incomplete multipart uploads after 1 day). This caps cost and self-heals
  orphans from a crashed run. To add it by hand, see the [appendix](#appendix-create-the-bucket-by-hand).
- **A cost backstop** guards against a runaway loop. The simplest is an account-level **cost
  budget** in AWS Budgets that emails you. **Caveat:** a budget with no cost filter tracks
  your *whole account's* spend — set its limit *above your normal baseline* (a $5 budget on
  an account already spending $9 just fires immediately). To alert on this bucket
  specifically, tag it and filter the budget by a cost-allocation tag (activated in Billing,
  ~a day to take effect) — usually overkill for a bucket the lifecycle keeps near $0. If you
  already keep an account budget, you need nothing more.

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
