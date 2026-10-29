# Setting up a cloud bucket

`s3cab aws <bucket>` helps you stand up an **AWS** S3 bucket as a backup
destination, together with a least-privilege identity for s3cab to use — without
s3cab becoming a manager of your cloud account. (Backing up to an S3-compatible
provider instead — Cloudflare R2, Backblaze B2, Wasabi, …? See
[Non-AWS providers](#non-aws-providers) below: those have no IAM, so setup runs
through the `provider` command, not this one.)

It is **generative**: it _writes_ CloudFormation templates and _prints_ the
handful of `aws` commands to deploy them, and makes no AWS calls itself (the one
exception is `--save`, a read-only lookup of an already-deployed stack). So it
needs **no credentials to run** — you can read the whole plan (and the exact
templates) before you have any — and you can see exactly what will touch your
account before anything happens.

```console
> s3cab aws my-backups --region eu-west-1 --profile admin
```

- `<bucket>` — the bucket name to set up (one repository is one bucket).
- `--region <region>` — the AWS region to deploy into. Defaults to `$AWS_REGION` /
  `$AWS_DEFAULT_REGION`, then `us-east-1`. It is dropped into the `--region` of
  the printed deploy command; the bucket lands wherever the stack deploys.
- `--profile <name>` — an **admin** AWS profile to drop into the printed `aws …`
  commands (the identity that _deploys_ the stack and mints the key). Output
  sugar, except with `--save`, which signs its read-only stack lookup with it.
- `--roles-anywhere` — use the keyless, certificate-based Roles Anywhere identity
  instead of the default IAM-user one: generate the local CA + client certificate
  and write its CloudFormation template (see [Identity options](#identity-options)).
  Combine with `--save --from-stack <stack>` to capture the deployed stack's ARNs.

It writes two **CloudFormation templates** — declarative files that each become
one stack — and prints the recipe to deploy them:

| Template                              | Stack                        | Holds                                                   |
| ------------------------------------- | ---------------------------- | ------------------------------------------------------- |
| `~/.s3cab/<bucket>-bucket.yaml`       | `s3cab-<bucket>-bucket`      | the bucket and its protections — nothing else           |
| `~/.s3cab/<bucket>-user.yaml`         | `s3cab-<bucket>-user`        | the IAM user, carrying the least-privilege policy       |
| `~/.s3cab/<bucket>-<fingerprint>.yaml` | `s3cab-<bucket>-<fingerprint>` | with `--roles-anywhere`, instead: this machine's keyless identity |

The bucket stack is the same for everyone, so deploying it again changes
nothing — a second machine, or a switch between identities, runs every step as
printed. **If the bucket already exists** and s3cab didn't create it, skip that
step: the identity stack carries its own policy, so it works on any bucket
(check the bucket against the table in [What it sets up](#what-it-sets-up)).

Writing files (rather than dumping YAML to the terminal for you to copy) means
each deploy command just points `--template-file` at one. CloudFormation resolves
every cross-resource reference itself, so there are no ARNs to copy from one
command's output into the next, and the same command works identically on
PowerShell and bash. The stacks are updatable (change the lifecycle window,
redeploy) and teardownable — though the bucket carries `DeletionPolicy: Retain`,
so deleting its stack **never** destroys your backups.

The steps are **sequential and human-in-the-loop**, not one paste-all: minting
the identity's access key is a deliberate manual step whose secret a later step
consumes.

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
reclaims freed space sooner. In a content-addressable store this costs almost
nothing in steady state — stored objects are immutable, so noncurrent versions
only ever arise from deletes.

Those deletes are what `s3cab forget` (removing a snapshot) and `s3cab cleanup`
(reclaiming unreferenced objects) issue. On a versioned bucket both are
soft deletes — they write delete markers and the bytes live on as noncurrent
versions — so **reclaimed space does not drop immediately**; the lifecycle above
frees it once the window elapses. That deferral is the safety net (a mistaken
`cleanup` is recoverable within the window), not a bug.

## How your backups are stored: the Glacier Instant Retrieval tier

s3cab uploads every object to AWS's **Glacier Instant Retrieval** storage class —
the cheapest tier that still reads back **instantly** (millisecond retrieval, just
like S3 Standard; it is _not_ one of the slow archive tiers that make you wait
hours). Storage costs roughly a sixth of Standard, which suits what a backup is:
written once, read only on the rare occasion you restore.

There are three costs to know about up front — s3cab picks this tier for you, but
it should be your informed choice:

- **A 128 KB minimum billable size.** Objects smaller than 128 KB are billed as if
  they were 128 KB. Even so, anything larger than ~22 KB is still cheaper here than
  on Standard; only very small files cost fractionally more, and in absolute terms
  that is rounding error.
- **A 90-day minimum storage duration.** An object deleted sooner than 90 days is
  still billed for the full 90. This mostly matters if you back up and then remove
  the same content quickly — `s3cab forget` and `s3cab cleanup` on a bucket whose
  contents churn a lot. The bucket's 90-day noncurrent-version window (above) lines
  up with this, so the normal reclamation path pays no early-deletion penalty.
- **A per-GB retrieval fee** when you read data back. A restore therefore costs a
  little, but a backup you restore rarely barely notices it.

This tier is AWS-specific. On a non-AWS provider s3cab leaves the storage class
alone (see [Non-AWS providers](#non-aws-providers)).

**Already have a bucket full of backups?** This applies to _new_ uploads; objects
already in your bucket stay on whatever tier they were uploaded with. To move the
existing ones too, add a one-off lifecycle rule that transitions everything to
Glacier IR.

> **Careful — this replaces the bucket's whole lifecycle configuration, it does
> not merge.** `put-bucket-lifecycle-configuration` overwrites _every_ existing
> rule with what you send. A bucket created by `s3cab aws` already has rules that
> matter (the 90-day noncurrent-version expiry and the incomplete-multipart abort),
> so you must include the transition **alongside** them, not on its own — sending
> the transition by itself would silently delete those safety rules.

First read what's already there, so you don't drop anything:

```console
> aws s3api get-bucket-lifecycle-configuration --bucket <bucket>
```

Then write a `lifecycle.json` containing **all** the rules you want — the existing
ones plus the new transition. For a bucket set up by `s3cab aws`, that is:

```json
{
  "Rules": [
    {
      "ID": "reclaim-deleted-backups",
      "Status": "Enabled",
      "Filter": {},
      "NoncurrentVersionExpiration": { "NoncurrentDays": 90 },
      "AbortIncompleteMultipartUpload": { "DaysAfterInitiation": 1 }
    },
    {
      "ID": "s3cab-glacier-ir",
      "Status": "Enabled",
      "Filter": { "ObjectSizeGreaterThan": 0 },
      "Transitions": [{ "Days": 0, "StorageClass": "GLACIER_IR" }]
    }
  ]
}
```

The `"ObjectSizeGreaterThan": 0` on the transition rule is deliberate. By default
S3 **won't** transition objects smaller than 128 KB to any storage class — and a
content-addressed store like s3cab holds plenty of those, so without this they'd
be left behind on their original tier. Adding an explicit object-size filter
overrides that default (any size filter does; `0` means "every object"), so the
small ones move to Glacier IR too. The trade-off S3 is guarding against: you pay a
one-time transition request per object (~$0.02 per 1,000), and objects under
~22 KB cost fractionally more to store on Glacier IR than on Standard because of
its 128 KB billing floor — pennies either way, but that's why it isn't the
default. Drop the filter (`"Filter": {}`) if you'd rather leave sub-128 KB objects
where they are.

If your `get` above showed different rules, copy _those_ in instead of the first
rule shown here. Then apply the merged set (leaving the transition rule in place
afterwards is fine — new objects already arrive as Glacier IR, so it finds nothing
to move):

```console
> aws s3api put-bucket-lifecycle-configuration --bucket <bucket> --lifecycle-configuration file://lifecycle.json
```

## The security model

The everyday identity and the bucket together give a backup tool the property it
should have: **a leaked everyday key can add to your backup and tweak its own set
markers, but can never _permanently destroy_ your content or history.**

The generated policy grants exactly:

- `s3:ListBucket` on the bucket, and
- `s3:GetObject` / `s3:PutObject` / `s3:DeleteObject` /
  `s3:AbortMultipartUpload` on its objects. The last lets a large upload that
  failed partway clear the parts it already sent.

The `locks/` keys that keep backups and clean-ups apart
([looking after a backup](maintenance.md#locks-backups-and-clean-ups-take-turns)) are
ordinary objects, so that grant covers them. A policy you write by hand must let every
identity that backs up, uploads, cleans up or deletes put, list and delete under `locks/`;
an identity that only verifies or restores needs nothing there.

`DeleteObject` is a **soft** delete: on a versioned bucket it writes a delete
marker and the bytes survive as a noncurrent version (reclaimed by the lifecycle
after the window). The key deliberately has **no** `DeleteObjectVersion`, so it
cannot truly erase anything. Permanently scrubbing a version is a rare,
elevated-identity operation most people never need — and versioning is the
backstop that makes everyday soft-deletes safe.

## Identity options

The bucket and the policy are the same for everyone; only _which identity carries
the policy_ differs.

### Default — a dedicated IAM user

The identity template creates an IAM user (`s3cab-<bucket>-user`) carrying the
policy. After you deploy it, the only manual step is minting that user's access
key:

```console
> aws iam create-access-key --user-name s3cab-<bucket>-user
```

This is the **one thing kept out of the template**. `AWS::IAM::AccessKey` would
materialize the secret in CloudFormation's stack state (readable afterward), so the
secret is instead printed once to your terminal and never persisted. Then create
your first backup set and store the key on it in one step — `setup` is the
initial-config door (`--keys` prompts for the key + secret, never taken as flags):

```console
> s3cab setup --set <name> --bucket <bucket> --keys <directory>...
```

> AWS now steers even basic users toward short-lived credentials over standalone
> access keys. The IAM-user path has the fewest moving parts; if you'd rather not
> hold a long-lived key, `--roles-anywhere` (below) is the alternative, at the
> cost of more setup steps.

### `--roles-anywhere` — keyless, certificate-based access

An alternative to a long-lived access key, for those willing to do more setup.
With IAM Roles Anywhere your machine authenticates using an X.509 client
certificate and receives short-lived session credentials — no long-lived AWS key
ever lives on disk. It is one level above access keys, deliberately not an
enterprise PKI.

`s3cab aws <bucket> --roles-anywhere` generates a machine-level CA + client
certificate under `~/.s3cab/roles-anywhere/` (the private key never leaves your
machine). Beside the bucket template, it writes an identity template for this
machine: a trust anchor over the public CA, an IAM role carrying the same
least-privilege policy, and a profile. Its stack is named for the CA —
`s3cab-<bucket>-<fingerprint>`, the first eight hex digits of the CA
certificate's SHA-256 — so it belongs to this machine alone. Deploy both, then
capture the identity stack's ARNs back to this machine. s3cab prints every
command ready to paste, with the real paths and fingerprint; in outline:

```console
> s3cab aws <bucket> --roles-anywhere          # generates certs + writes the templates
> aws cloudformation deploy --template-file ~/.s3cab/<bucket>-bucket.yaml --stack-name s3cab-<bucket>-bucket --no-fail-on-empty-changeset
> aws cloudformation deploy --template-file ~/.s3cab/<bucket>-<fingerprint>.yaml --stack-name s3cab-<bucket>-<fingerprint> --capabilities CAPABILITY_NAMED_IAM
> s3cab aws --roles-anywhere --save --from-stack s3cab-<bucket>-<fingerprint>   # read-only ARN capture
```

`--save` writes the ARNs to `~/.s3cab/roles-anywhere/<bucket>.env`, one file per
bucket, so a set signs in with the identity for its own bucket. Re-running the
first step reuses the existing certificate (it never silently mints a new CA,
which would orphan the deployed trust anchor).

Then point a backup set at the identity — either as you create it, or by switching
an existing set:

```console
> s3cab setup --set <name> --bucket <bucket> --roles-anywhere <directory>...
> s3cab provider --roles-anywhere <set>          # switch an existing set
```

From then on s3cab signs a short request with the client certificate, receives
short-lived AWS credentials, and refreshes them automatically before they expire —
so a backup runs with no long-lived key anywhere on disk. (Roles Anywhere is
AWS-only, so it can't be combined with a custom `--endpoint`.)

#### More buckets, more machines

- **Another bucket on this machine:** run `s3cab aws <other-bucket> --roles-anywhere`
  and its steps. The same certificate gets a trust anchor in that bucket's own
  identity stack, and its ARNs go in that bucket's own file.
- **Another machine on this bucket:** run the same steps on that machine. It
  generates its own certificate, so its identity stack has a different name and
  leaves this machine's alone; the bucket step finds nothing to change. Don't copy
  `~/.s3cab/roles-anywhere/` across instead: that spreads the CA key, and you lose
  the ability to cut off one machine without the other.
- **Cutting off one machine:** delete its identity stack on each bucket it uses
  (`aws cloudformation delete-stack --stack-name s3cab-<bucket>-<fingerprint>`).
  The bucket and every other machine's identity are untouched.
- **Switching a bucket from access keys to Roles Anywhere (or back):** the new
  identity stack deploys beside the old one. Delete the one you no longer use; for
  the IAM user, AWS requires its access key deleted first
  (`aws iam delete-access-key --user-name s3cab-<bucket>-user --access-key-id <key-id>`).

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
  that CA dies immediately — nothing to rotate on the machine. Each machine has its
  own trust anchor on each bucket, so this cuts off one machine from one bucket and
  nothing else. Roles Anywhere also
  supports importing a CRL to revoke one specific client certificate.
- **AWS-side scoping** — session-duration caps, scoped session policies, and the
  certificate as the logged CloudTrail identity.

The honest caveat: **against pure file exfiltration, the `0600` PEM on disk is only
marginally better than an access key.** If someone steals `client.key`, they can
mint fresh short-lived credentials repeatedly for the certificate's life (or until
you disable the trust anchor) — "short-lived credentials" does not rescue a
long-lived _signing key_. True machine-binding would need an OS keystore/TPM, which
s3cab deliberately doesn't require.

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
bucket, just create the bucket — giving it the same versioning and lifecycle
housekeeping as the table above — and point s3cab at your SSO profile;
SSO flows through the standard AWS credential chain, which s3cab uses unchanged:

```console
> s3cab provider --profile <your-sso-profile>
```

A narrowly-scoped SSO permission set needs your account admin to grant it bucket
access (the least-privilege policy above is an _identity_ policy on a dedicated
user/role, not a bucket resource policy, so it can't widen an SSO role for you).
That is an admin task s3cab deliberately leaves to the standard AWS tooling. See
`s3cab help provider` for the credential-chain details.

## Non-AWS providers

S3-compatible services — Cloudflare R2, Backblaze B2, Wasabi, and so on —
have no AWS IAM, so there is no policy JSON to attach and no `aws` CLI to
install. Onboarding reduces to three strings (endpoint, access key, secret key)
plus a region label, all recorded by the **`provider`** command.
The steps (also available offline via `s3cab help provider`):

1. **Create the bucket** in your provider's console (or its CLI).
2. **Turn on object versioning** if the provider supports it — your safety net,
   so a deleted or overwritten backup stays recoverable. Not every provider
   offers it; skip this if yours doesn't.
3. **Add a cleanup rule for interrupted uploads** if the provider supports
   lifecycle rules. Large files upload in pieces (a "multipart upload"), and an
   upload that dies partway — a crash, a dropped connection — leaves its
   already-uploaded pieces behind: invisible in the bucket's file listing, but
   still billed. A lifecycle rule that aborts incomplete multipart uploads
   after a day cleans them up automatically; most consoles name the rule close
   to that. (Buckets created by the AWS recipe above get this rule built in.)
4. **Create an access key / token scoped to that bucket**, with read, write,
   delete, and list on its objects. Where to do this differs by provider
   (R2: API Tokens; B2: Application Keys; Wasabi: sub-users).
5. **Create the backup set, pointed at the provider in one command** — the
   endpoint and region by flag, the key + secret at the prompt (never flags,
   which would leak into shell history; piping two lines to `--keys` works for
   scripts). Config is per-set, so it goes on the set as you create it:

   ```console
   > s3cab setup --set <name> --bucket <bucket> --endpoint https://<your-endpoint> --region auto --keys <directory>...
   Access key ID: …
   Secret access key (hidden):
   ```

   This writes the set's env file (`~/.s3cab/sets/<set>/env`, created
   owner-only). Some providers want a real region label (e.g. `us-east-1`); R2
   takes `auto`. To change any of it later, use `s3cab provider`
   (e.g. `s3cab provider --keys <set>`).

s3cab automatically drops AWS-only request features (server-side encryption, the
Glacier Instant Retrieval storage class, the default integrity-checksum trailer)
when a custom endpoint is set, so a plain bucket elsewhere just works.

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
