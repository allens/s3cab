# Setting up a cloud bucket

`s3cab bucket <bucket>` helps you stand up an S3 bucket as a backup destination,
together with a least-privilege identity for s3cab to use — without s3cab
becoming a manager of your cloud account.

It is **generative**: it _prints_ the exact `aws` commands and policy/lifecycle
JSON for you to run, and makes no AWS calls itself. So it needs **no credentials
to run** — you can read the whole plan before you have any — and you can see
exactly what will touch your account before anything happens. (It also means the
command works the same for the S3-compatible providers that have no AWS CLI at
all; see [Non-AWS providers](#non-aws-providers).)

```console
> s3cab bucket my-backups --region eu-west-1 --profile admin
```

- `<bucket>` — the bucket name to set up (one repository is one bucket).
- `--region <region>` — the bucket's AWS region. Defaults to `$AWS_REGION` /
  `$AWS_DEFAULT_REGION`, then `us-east-1`.
- `--profile <name>` — an **admin** AWS profile to drop into the printed `aws …`
  commands (the identity that _creates_ the bucket and the s3cab user). It is
  output sugar only — the command never uses it to authenticate.
- `--sso` — print the AWS IAM Identity Center (SSO) recipe instead of the default
  IAM-user one (see [Identity options](#identity-options)).

The steps are **sequential and human-in-the-loop**, not one paste-all: creating
the identity mints an access key that a later step consumes, so you run them in
order. Each policy/lifecycle document is printed inline for you to save as
`policy.json` / `lifecycle.json`; the `aws` commands reference those files with
`file://` to avoid wrestling with cross-shell JSON quoting.

## What it sets up

| Setting                                | Value           | Why                                                                          |
| -------------------------------------- | --------------- | ---------------------------------------------------------------------------- |
| Versioning                             | Enabled         | recover any deleted or overwritten backup                                    |
| Lifecycle: noncurrent-version expiry   | ~90 days        | the disaster-recovery window — reclaims space a delete freed (see below)     |
| Lifecycle: abort incomplete multipart  | 1 day           | clears stalled uploads, which accrue cost invisibly                          |
| Lifecycle: current-object expiry       | **none**        | the cardinal sin — never auto-delete a live backup                           |

The 90-day window is a deliberate cost/safety **dial**: longer is safer, shorter
reclaims pruned space sooner. In a content-addressable store this costs almost
nothing in steady state — stored objects are immutable, so noncurrent versions
only ever arise from deletes.

## The security model

The everyday identity and the bucket together give a backup tool the property it
should have: **a leaked everyday key can add to your backup and tweak its own set
markers, but can never _permanently destroy_ your content or history.**

The generated policy grants exactly:

- `s3:ListBucket` on the bucket, and
- `s3:GetObject` / `s3:PutObject` / `s3:DeleteObject` on its objects.

`DeleteObject` is a **soft** delete: on a versioned bucket it writes a delete
marker and the bytes survive as a noncurrent version (reclaimed by the lifecycle
after the window). The key deliberately has **no** `DeleteObjectVersion`, so it
cannot truly erase anything. Permanently scrubbing a version is a rare,
elevated-identity operation most people never need — and versioning is the
backstop that makes everyday soft-deletes safe.

## Identity options

The bucket and the policy are the same for everyone; only _which identity you
attach the policy to_ differs.

### Default — a dedicated IAM user

The simplest path if you don't use SSO. The command prints commands to create an
IAM user, attach the policy to it, mint an access key, and point s3cab at it with
`aws configure` + `s3cab aws --profile s3cab`.

> AWS now steers even basic users toward IAM Identity Center over standalone IAM
> users. The IAM-user path is kept because it is the least moving parts when you
> have no SSO; if you _do_ sign in with SSO, prefer `--sso`.

### `--sso` — AWS IAM Identity Center

For accounts that sign in through IAM Identity Center (there is no long-lived
access key to mint). Two tiers are printed:

- **Reuse your existing sign-in** (the common case): attach the policy to the
  permission set you already use, `aws sso login`, then `s3cab aws --profile
  <your-sso-profile>`.
- **A dedicated s3cab-only permission set** (advanced, optional): tighter scope
  at the cost of more setup. It is shown console-first, with a `<placeholder>`
  CLI appendix for those who manage Identity Center from the command line (the
  SSO instance and permission-set ARNs can't be pre-filled).

The command does **not** teach standing up Identity Center from scratch — that
is heavy, serves a tiny audience, and re-treads ground s3cab deliberately left to
the standard AWS tooling.

## Non-AWS providers

If a custom S3 endpoint is set (`AWS_ENDPOINT_URL_S3` or `AWS_ENDPOINT_URL`), the
command auto-selects **provider-neutral** guidance for any S3-compatible service
— Cloudflare R2, Backblaze B2, Wasabi, MinIO, and so on. These have no AWS IAM,
so there is no policy JSON to attach; instead you get best-effort console steps
(create the bucket, turn on versioning if supported, create a scoped token) and a
ready-to-paste `~/.s3cab/env` template with your endpoint pre-filled:

```ini
AWS_ENDPOINT_URL_S3=https://<your-endpoint>
AWS_ACCESS_KEY_ID=<your-access-key>
AWS_SECRET_ACCESS_KEY=<your-secret>
AWS_REGION=auto
```

s3cab automatically drops AWS-only request features (server-side encryption,
intelligent-tiering, the default integrity-checksum trailer) when a custom
endpoint is set, so a plain bucket elsewhere just works.

## A note on the `us-east-1` quirk

`us-east-1` is the S3 API's default region and must **not** carry a
`LocationConstraint` (S3 rejects the create-bucket call if it does); every other
region **requires** one. The generated create-bucket command handles this for you
— it includes `--create-bucket-configuration LocationConstraint=<region>` only
when the region isn't `us-east-1`.

## Next

Once the identity is wired up, create a backup set pointed at the bucket:

```console
> s3cab setup <name> <folder>... --bucket my-backups
```

See the [README](../README.md) for backing up and restoring.
