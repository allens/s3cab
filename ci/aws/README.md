# CI AWS resources (s3cab integration tests)

The JSON artifacts in this directory provision the real-AWS resources behind the
gated S3 integration suite (see [../../specs/testing.md](../../specs/testing.md) for
the strategy). They are applied with the AWS CLI following the full, cross-platform
walkthrough in **[../../docs/integration-testing.md](../../docs/integration-testing.md)**
— that guide is generic (anyone can follow it for their own fork/account); this file
only records **what this project uses**.

## Artifacts

- [`policy.json`](policy.json) — least-privilege IAM policy: `Get/Put/Delete` on
  objects, `ListBucket` on the bucket, scoped to the one test bucket. (`Delete`
  because test teardown deletes.)
- [`trust-policy.json`](trust-policy.json) — assume-role trust for the GitHub Actions
  OIDC role, scoped to this repo's `:pull_request` subject so the role is assumable only
  from a workflow running on a same-repo PR (which only a collaborator can open; fork PRs
  get no OIDC token at all). Carries an **`ACCOUNT_ID` placeholder** (substituted at apply
  time) so the real account ID never lands in this public repo.

## This project's values

| Resource | Name | Region |
| --- | --- | --- |
| Test bucket | `s3cab-ci-test` | `us-east-1` |
| IAM policy | `s3cab-ci-test-access` | — |
| OIDC role | `s3cab-ci` | — |

**Permissions:** creating the IAM policy/role needs an **AdministratorAccess** session
— `PowerUserAccess` excludes IAM writes. The bucket and the billing alarm need only
PowerUser.
