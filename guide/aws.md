# Setting up a cloud bucket

`s3cab aws <bucket>` helps you stand up an **AWS** S3 bucket as a backup
destination, together with a least-privilege identity for s3cab to use — without
s3cab becoming a manager of your cloud account. (Backing up to an S3-compatible
provider instead — Cloudflare R2, Backblaze B2, Wasabi, MinIO, …? See
[Non-AWS providers](#non-aws-providers) below: those have no IAM, so setup runs
through the `provider` command, not this one.)

It is **generative**: it _prints_ a CloudFormation template and the handful of
`aws` commands to deploy it, and makes no AWS calls itself. So it needs **no
credentials to run** — you can read the whole plan (and the exact template) before
you have any — and you can see exactly what will touch your account before
anything happens.

```console
> s3cab aws my-backups --region eu-west-1 --profile admin
```

- `<bucket>` — the bucket name to set up (one repository is one bucket).
- `--region <region>` — the AWS region to deploy into. Defaults to `$AWS_REGION` /
  `$AWS_DEFAULT_REGION`, then `us-east-1`. It is dropped into the `--region` of
  the printed deploy command; the bucket lands wherever the stack deploys.
- `--profile <name>` — an **admin** AWS profile to drop into the printed `aws …`
  commands (the identity that _deploys_ the stack and mints the key). It is output
  sugar only — the command never uses it to authenticate.
- `--roles-anywhere` — use the keyless, certificate-based Roles Anywhere identity
  instead of the default IAM-user one: generate the local CA + client certificate
  and write its CloudFormation template (see [Identity options](#identity-options)).
  Recommended. Combine with `--save --from-stack <stack>` to capture the deployed
  stack's ARNs.

It writes a **CloudFormation template** — a single declarative file describing the
bucket, its least-privilege policy, and the s3cab identity — to
`~/.s3cab/<bucket>.yaml`, and prints the recipe to deploy it with one `aws
cloudformation deploy`. Writing the file (rather than dumping YAML to the terminal
for you to copy) means the deploy command just points `--template-file` at it.
CloudFormation resolves every cross-resource reference itself, so there are no ARNs
to copy from one command's output into the next, and the same command works
identically on PowerShell and bash. The stack is updatable (change the lifecycle
window, redeploy) and teardownable — though the bucket carries
`DeletionPolicy: Retain`, so deleting the stack **never** destroys your backups.

The three steps that follow the template are **sequential and human-in-the-loop**,
not one paste-all: minting the identity's access key is a deliberate manual step
whose secret a later step consumes.

## What it sets up

| Setting                               | Value               | Why                                                                      |
| ------------------------------------- | ------------------- | ------------------------------------------------------------------------ |
| Versioning                            | Enabled             | recover any deleted or overwritten backup                                |
| Default encryption                    | SSE-S3 (AES256)     | backups encrypted at rest, spelled out rather than left to the default   |
| Deletion / update-replace policy      | Retain              | deleting the stack can never destroy the bucket or its contents          |
| Lifecycle: noncurrent-version expiry  | ~90 days            | the disaster-recovery window — reclaims space a delete freed (see below)  |
| Lifecycle: abort incomplete multipart | 1 day               | clears stalled uploads, which accrue cost invisibly                      |
| Lifecycle: current-object expiry      | **none**            | the cardinal sin — never auto-delete a live backup                       |

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

The bucket and the policy are the same for everyone; only _which identity gets the
policy attached_ differs.

### Default — a dedicated IAM user

The CloudFormation template creates an IAM user (`s3cab-user-<bucket>`) with the
managed policy attached. After you deploy it, the only manual step is minting that
user's access key:

```console
> aws iam create-access-key --user-name s3cab-user-<bucket>
```

This is the **one thing kept out of the template**. `AWS::IAM::AccessKey` would
materialize the secret in CloudFormation's stack state (readable afterward), so the
secret is instead printed once to your terminal and never persisted. Then create
your first backup set and store the key on it in one step — `setup` is the
initial-config door (`--keys` prompts for the key + secret, never taken as flags):

```console
> s3cab setup <name> <directory>... --bucket <bucket> --keys
```

> AWS now steers even basic users toward short-lived credentials over standalone
> access keys. The IAM-user path is the least moving parts today; if you'd rather
> not hold a long-lived key, `--roles-anywhere` (below) is the recommended
> alternative.

### `--roles-anywhere` — keyless, certificate-based access

The recommended alternative to a long-lived access key. With IAM Roles Anywhere
your machine authenticates using an X.509 client certificate and receives
short-lived session credentials — no long-lived AWS key ever lives on disk. It is
one level above access keys, deliberately not an enterprise PKI.

`s3cab aws <bucket> --roles-anywhere` generates a machine-level CA + client
certificate under `~/.s3cab/roles-anywhere/` (the private key never leaves your
machine) and writes a CloudFormation template to `~/.s3cab/<bucket>.yaml` that
stands up the bucket plus the keyless identity — a trust anchor over the public
CA, an IAM role carrying the same least-privilege policy, and a profile. Deploy
it, then capture the stack's ARNs back into the local identity. s3cab prints the
deploy command ready to paste, with `--template-file` pointing at the absolute
path it just wrote (the `~/.s3cab/<bucket>.yaml` below is illustrative):

```console
> s3cab aws <bucket> --roles-anywhere          # generates certs + writes the template
> aws cloudformation deploy --template-file ~/.s3cab/<bucket>.yaml --stack-name s3cab-<bucket> --capabilities CAPABILITY_NAMED_IAM
> s3cab aws --roles-anywhere --save --from-stack s3cab-<bucket>   # read-only ARN capture
```

Re-running the first step reuses the existing identity (it never silently mints a
new CA, which would orphan the deployed trust anchor).

Then point a backup set at the identity — either as you create it, or by switching
an existing set:

```console
> s3cab setup <name> <directory>... --bucket <bucket> --roles-anywhere
> s3cab provider --roles-anywhere <set>          # switch an existing set
```

From then on s3cab signs a short request with the client certificate, receives
short-lived AWS credentials, and refreshes them automatically before they expire —
so a backup runs with no long-lived key anywhere on disk. (Roles Anywhere is
AWS-only, so it can't be combined with a custom `--endpoint`.)

#### Why it's better than an access key — and the honest caveat

The advantages are real, but none of them is "the local secret is better
protected" — so it's worth being precise about what you do and don't gain:

- **The durable secret never travels.** The client private key is generated
  locally, never displayed, never sent to AWS (only the public CA is uploaded, as
  the trust anchor). An access-key secret, by contrast, is _designed_ to be shown
  once and pasted around — shell history, clipboard, config sync.
- **What flows to AWS, logs, and process memory is a ~1-hour session token**, not a
  permanent key. A token scraped from a log is game-over for an hour, not forever.
- **Central revocation.** Disable or delete the trust anchor and every session from
  that CA dies immediately — nothing to rotate on the machine. Roles Anywhere also
  supports importing a CRL to revoke one specific client certificate.
- **AWS-side scoping** — session-duration caps, scoped session policies, and the
  certificate as the logged CloudTrail identity.

The honest caveat: **against pure file exfiltration, the `0600` PEM on disk is only
marginally better than an access key.** If someone steals `client.key`, they can
mint fresh short-lived credentials repeatedly for the certificate's life (or until
you disable the trust anchor) — "short-lived credentials" does not rescue a
long-lived _signing key_. True machine-binding would need an OS keystore/TPM, which
s3cab deliberately doesn't require (see
[ADR-0058](https://github.com/allens/s3cab/blob/main/docs/adr/0058-roles-anywhere-cert-generation.md)).

What actually bounds the damage is the same backstop as everywhere in s3cab: the
least-privilege policy is **soft-delete-only** (`DeleteObject`, never
`DeleteObjectVersion`) on a versioned, `Retain`-protected bucket, so even a fully
compromised identity **cannot permanently destroy your backup history** — a leaked
key is "rotate the trust anchor," not "backups gone." Keep the key file `0600`,
watch CloudTrail's `CreateSession` events, and you have detection plus a bounded
blast radius.

### AWS IAM Identity Center (SSO)

There is no separate SSO onboarding path (and no `--sso` flag). If you already sign
in through IAM Identity Center with a broadly-privileged role that can reach the
bucket, just create the bucket and point s3cab at your SSO profile — SSO flows
through the standard AWS credential chain, which s3cab uses unchanged:

```console
> s3cab provider --profile <your-sso-profile>
```

A narrowly-scoped SSO permission set needs your account admin to grant it bucket
access (the least-privilege policy above is an _identity_ policy on a dedicated
user/role, not a bucket resource policy, so it can't widen an SSO role for you).
That is an admin task s3cab deliberately leaves to the standard AWS tooling. See
`s3cab help provider` for the credential-chain details.

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
   > s3cab setup <name> <directory>... --bucket <bucket> --endpoint https://<your-endpoint> --region auto --keys
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

## Next

The recipe's last step already created your first backup set in the bucket, so
you're ready to back up:

```console
> s3cab backup <name>
```

See the [README](../README.md) for backing up and restoring.
