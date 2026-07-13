# Setting up a cloud bucket

`s3cab aws <bucket>` helps you stand up an **AWS** S3 bucket as a backup
destination, together with a least-privilege identity for s3cab to use — without
s3cab becoming a manager of your cloud account. (Backing up to an S3-compatible
provider instead — Cloudflare R2, Backblaze B2, Wasabi, MinIO, …? See
[Non-AWS providers](#non-aws-providers) below: those have no IAM, so setup runs
through the `provider` command, not this one.)

It is **generative**: it _prints_ the exact `aws` commands and policy/lifecycle
JSON for you to run, and makes no AWS calls itself. So it needs **no credentials
to run** — you can read the whole plan before you have any — and you can see
exactly what will touch your account before anything happens.

```console
> s3cab aws my-backups --region eu-west-1 --profile admin
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

Those deletes are what `s3cab delete` (removing a snapshot) and `s3cab cleanup
--delete` (reclaiming unreferenced objects) issue. On a versioned bucket both are
soft deletes — they write delete markers and the bytes live on as noncurrent
versions — so **reclaimed space does not drop immediately**; the lifecycle above
frees it once the window elapses. That deferral is the safety net (a mistaken
`cleanup` is recoverable within the window), not a bug.

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
`aws configure` + `s3cab provider --profile s3cab`.

> AWS now steers even basic users toward IAM Identity Center over standalone IAM
> users. The IAM-user path is kept because it is the least moving parts when you
> have no SSO; if you _do_ sign in with SSO, prefer `--sso`.

### `--sso` — AWS IAM Identity Center

For accounts that sign in through IAM Identity Center (there is no long-lived
access key to mint). Two tiers are printed:

- **Reuse your existing sign-in** (the common case): attach the policy to the
  permission set you already use, `aws sso login`, then `s3cab provider --profile
  <your-sso-profile>`.
- **A dedicated s3cab-only permission set** (advanced, optional): tighter scope
  at the cost of more setup. It is shown console-first, with a `<placeholder>`
  CLI appendix for those who manage Identity Center from the command line (the
  SSO instance and permission-set ARNs can't be pre-filled).

The command does **not** teach standing up Identity Center from scratch — that
is heavy, serves a tiny audience, and re-treads ground s3cab deliberately left to
the standard AWS tooling.

## Non-AWS providers

S3-compatible services — Cloudflare R2, Backblaze B2, Wasabi, MinIO, and so on —
have no AWS IAM, so there is no policy JSON to attach and no `aws` CLI to
install. Onboarding reduces to three strings (endpoint, access key, secret key)
plus a region label, all recorded by the **`provider`** command
([ADR-0047](https://github.com/allens/s3cab/blob/main/docs/adr/0047-provider-command-neutral-config-door.md)).
The steps (also available offline via `s3cab help provider`):

1. **Create the bucket** in your provider's console (or its CLI).
2. **Turn on object versioning** if the provider supports it — your safety net,
   so a deleted or overwritten backup stays recoverable. Not every provider
   offers it; skip this if yours doesn't.
3. **Create an access key / token scoped to that bucket**, with read, write,
   delete, and list on its objects. Where to do this differs by provider
   (R2: API Tokens; B2: Application Keys; Wasabi: sub-users).
4. **Create the backup set, pointed at the provider in one command** — the
   endpoint and region by flag, the key + secret at the prompt (never flags,
   which would leak into shell history; piping two lines to `--keys` works for
   scripts). Config is per-set, so it goes on the set as you create it:

   ```console
   > s3cab setup <name> <directory>... --bucket <bucket> \
       --endpoint https://<your-endpoint> --region auto --keys
   Access key ID: …
   Secret access key (hidden):
   ```

   This writes the set's env file (`~/.s3cab/sets/<set>/env`, created
   owner-only). Some providers want a real region label (e.g. `us-east-1`); R2
   takes `auto`. To change any of it later, use `s3cab provider`
   (e.g. `s3cab provider --keys <set>`).

s3cab automatically drops AWS-only request features (server-side encryption,
intelligent-tiering, the default integrity-checksum trailer) when a custom
endpoint is set, so a plain bucket elsewhere just works.

### Keeping the secret out of plaintext

`--keys` stores the key pair in the set's env file (`~/.s3cab/sets/<set>/env`) —
owner-only (mode `0600`, directories `0700`), but still plaintext on disk. The
secret can stay out of the file entirely: keep it in a secret manager and hand it to s3cab through the
standard credential chain's **`credential_process`** hook, which s3cab already
supports with no extra configuration.

The recipe is manager-agnostic. Store this JSON document as a single secret in
whatever you use (1Password, `pass`, the OS keychain, …):

```json
{ "Version": 1, "AccessKeyId": "<your-access-key>", "SecretAccessKey": "<your-secret>" }
```

Then add a profile to `~/.aws/config` (yours to edit — s3cab never writes it)
whose `credential_process` prints that secret:

```ini
[profile r2-backup]
credential_process = op read op://Private/s3cab-r2/credential
; or:         pass show s3cab/r2
; or (macOS): security find-generic-password -s s3cab-r2 -w
; or (Linux): secret-tool lookup service s3cab-r2
```

Point s3cab at the profile, and keep only the endpoint (not a secret) in the
env file:

```console
> s3cab provider --profile r2-backup
```

```ini
AWS_ENDPOINT_URL_S3=https://<your-endpoint>
AWS_REGION=auto
```

Two honest caveats. This protects the secret **at rest** — encrypted on disk,
out of home-directory syncs, dotfile repos, and file-level backups — but on most
platforms it does not protect against code already running _as you_: any process
that can run your secret manager can usually read the secret too (macOS prompts
per app; Linux's Secret Service typically doesn't). And scheduled backups run
unattended, so the store must be unlockable when they fire — a locked vault
makes the backup fail until you sign in, which you may consider a feature or a
bug.

## A note on the `us-east-1` quirk

`us-east-1` is the S3 API's default region and must **not** carry a
`LocationConstraint` (S3 rejects the create-bucket call if it does); every other
region **requires** one. The generated create-bucket command handles this for you
— it includes `--create-bucket-configuration LocationConstraint=<region>` only
when the region isn't `us-east-1`.

## Next

Once the identity is wired up, create a backup set pointed at the bucket:

```console
> s3cab setup <name> <directory>... --bucket my-backups
```

See the [README](../README.md) for backing up and restoring.
