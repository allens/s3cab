# CI AWS setup (s3cab integration tests)

One-time, owner-only provisioning for the real-AWS integration-test suite (see
[../../specs/testing.md](../../specs/testing.md)). These resources let the
approval-gated CI job run the gated S3 round-trips against a throwaway bucket.

**This is project-CI setup, not the contributor path.** A contributor running the
gated suites against their *own* bucket needs only [the bucket
script](../../scripts/setup-test-bucket.mjs) plus their own ambient `AWS_*`
credentials — none of the IAM/OIDC/billing below.

The JSON artifacts here are the source of truth; the `aws` CLI commands apply them.
Region throughout: `us-east-1`.

## 1. Bucket + lifecycle

Created by the portable Node script (cross-platform, no AWS CLI needed):

```sh
node scripts/setup-test-bucket.mjs s3cab-ci-test
```

Equivalent raw CLI is documented in that script's header.

## 2. Least-privilege IAM permission policy

[`policy.json`](policy.json) grants exactly `Get/Put/Delete` on objects and
`ListBucket` on the bucket — nothing else, scoped to the one bucket. (`Delete`
because test teardown deletes; object actions target `…/*`, the bucket-level
`ListBucket` targets the bare bucket ARN.)

```sh
aws iam create-policy \
  --policy-name s3cab-ci-test-access \
  --policy-document file://ci/aws/policy.json
```

Note the **policy ARN** it prints
(`arn:aws:iam::<account>:policy/s3cab-ci-test-access`) — it's attached to the OIDC
role in step 3.
