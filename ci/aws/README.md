# CI AWS resources (s3cab integration tests)

The JSON artifacts in this directory provision the real-AWS resources behind the
gated S3 integration suite (see [../../docs/design/testing.md](../../docs/design/testing.md) for
the strategy). They are applied with the AWS CLI following the full, cross-platform
walkthrough in **[../../docs/integration-testing.md](../../docs/integration-testing.md)**
— that guide is generic (anyone can follow it for their own fork/account); this file
only records **what this project uses**.

## Artifacts

- [`policy.json`](policy.json) — least-privilege IAM policy: `Get/Put/Delete` on
  objects, `ListBucket` on the bucket, scoped to the one test bucket. (`Delete`
  because test teardown deletes.)
- [`trust-policy.json`](trust-policy.json) — assume-role trust for the GitHub Actions
  OIDC role, scoped to three precise subjects, each reachable only by a **write-access**
  actor (fork PRs get no OIDC token at all):
  - `repo:allens/s3cab:pull_request` — ci.yml's `s3-integration` job on a same-repo PR
    (which only a collaborator can open).
  - `repo:allens/s3cab:ref:refs/heads/main` — release.yml's per-platform round-trip on a
    **`workflow_dispatch`** run (the dispatch-first, tag-when-green dry run; a dispatch
    runs from a branch, default `main`).
  - `repo:allens/s3cab:ref:refs/tags/v*` — release.yml's round-trip on a **`v*` tag** push
    (a `StringLike` wildcard on the tag; only a maintainer can push a tag).

  All three gate on the same boundary — write access — so this is 1→3 in surface count,
  not a new class of actor (see
  [../../docs/adr/0049-centralize-cross-cutting-test-tiers.md](../../docs/adr/0049-centralize-cross-cutting-test-tiers.md)).
  Carries an **`ACCOUNT_ID` placeholder** (substituted at apply time) so the real account
  ID never lands in this public repo.

## This project's values

| Resource | Name | Region |
| --- | --- | --- |
| Test bucket | `s3cab-ci-test` | `us-east-1` |
| IAM policy | `s3cab-ci-test-access` | — |
| OIDC role | `s3cab-ci` | — |

**Permissions:** creating the IAM policy/role needs an **AdministratorAccess** session
— `PowerUserAccess` excludes IAM writes. The bucket and the billing alarm need only
PowerUser.
