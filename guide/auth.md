# Signing in to your storage

s3cab needs permission to reach your bucket. It has **no sign-in of its own** and stores no
credentials: it uses the AWS credentials your machine already has, or the ones you record
against a backup set. It never reads or writes `~/.aws/config` or `~/.aws/credentials` — that
file is yours, and s3cab only ever looks at it.

> Mid-task in a terminal? `s3cab help provider` carries the same material without a browser.
> This page is the fuller read.

## The four ways a set signs in

Each backup set signs in **one** way. Pick whichever fits:

| Mode                | What it is                                                          | Best for                       |
| ------------------- | ------------------------------------------------------------------- | ------------------------------ |
| **Profile**         | a named profile in your existing AWS config                         | AWS users who already have one |
| **Access keys**     | an access key ID + secret key, stored on the set                    | non-AWS providers              |
| **Roles Anywhere**  | a certificate that mints short-lived credentials — no long-lived key | AWS, recommended               |
| **Ambient**         | the set records nothing; your machine's AWS setup supplies it        | one obvious AWS identity       |

Set them with `s3cab provider`, or on the set as you create it — `s3cab setup` takes the same
flags:

```console
> s3cab provider --profile s3cab-backup                      # an AWS profile
> s3cab provider --endpoint https://<id>.r2.cloudflarestorage.com --region auto --keys
> s3cab provider --roles-anywhere photos                     # keyless, AWS only
> s3cab provider                                             # show what's set now
```

**One mode per set, enforced.** Setting one clears the others — `--keys` drops a profile,
`--profile` drops saved keys. That's deliberate: with both recorded, the AWS SDK silently
prefers the keys, and you'd be signing in as someone other than who you think. Making that
unrepresentable is worth more than the flexibility. (Endpoint and region are separate
connection settings and stay put.)

Remove one with `--unset`:

```console
> s3cab provider --unset keys photos
```

### Access keys are never flags

`--keys` prompts for the key and secret at the terminal (the secret is hidden), or reads two
lines from stdin for scripts. It never takes them as flag values — those end up in your shell
history and in the process list, where they linger long after you've forgotten them.

They're written to the set's own env file (`~/.s3cab/sets/<set>/env`), owner-only. To keep a
long-lived secret out of a plaintext file entirely, see
[keeping the secret out of plaintext](aws.md#keeping-the-secret-out-of-plaintext) — the
recipe serves it from a secret manager, and s3cab needs no extra configuration to use it.

### AWS IAM Identity Center (single sign-on)

There's nothing to set up in s3cab. Sign in the normal way and point a set at the profile:

```console
> aws sso login --profile my-sso-profile
> s3cab provider --profile my-sso-profile
```

s3cab picks the session up through the standard AWS chain. When it expires, `aws sso login`
again — s3cab has no session of its own to refresh.

### Roles Anywhere (keyless)

Your machine authenticates with a certificate and receives credentials that last about an
hour, so no long-lived AWS key sits on disk. Set it up with `s3cab aws <bucket>
--roles-anywhere`, then point a set at it. It's AWS-only, so it can't be combined with a
custom endpoint. [The cloud-bucket guide](aws.md#--roles-anywhere--keyless-certificate-based-access)
has the full model, including an honest account of what it does and doesn't protect against.

## Where s3cab looks

Two steps, in order:

1. **The set's own settings** — `~/.s3cab/sets/<set>/env`, if it has any. This is the one
   file s3cab owns. It holds the set's bucket and how to reach it, and its values are applied
   over your shell, so **a value here beats the same variable in your environment**.
2. **Your standard AWS setup** — `AWS_PROFILE`, the shared profiles in `~/.aws` (including
   single sign-on sessions and `credential_process`), and `AWS_*` variables in your
   environment. This is the ordinary AWS chain, used unchanged.

There is **no per-user s3cab file** and s3cab does **not** read a `.env` from the directory
you happen to be in. Your machine-wide default is simply your ordinary AWS setup — s3cab
deliberately doesn't compete with it.

If a set is in Roles Anywhere mode, its certificate supplies the credentials instead of
step 2.

## Checking what's set

```console
> s3cab provider photos
AWS profile for set 'photos': s3cab-backup   (~/.s3cab/sets/photos/env)
AWS region for set 'photos': eu-west-1   (~/.s3cab/sets/photos/env)
```

Each line names the setting, the set, and the file it came from. A set with nothing of its own
says so, and points at your ambient AWS setup instead:

```console
> s3cab provider photos
No provider settings for set 'photos' — it uses your ambient AWS setup.
Give this set its own with:
  s3cab provider --profile <name> photos
```

A bare `s3cab provider` summarizes every set. Access keys report as **present** with only the
last few characters (`set (…WXYZ)`), never the secret. It also cross-checks a profile name
against your AWS config and tells you if it isn't there — a typo caught now rather than on
your next backup:

```console
AWS profile for set 'photos': typo-profile   (~/.s3cab/sets/photos/env)
Not in your AWS config — no credentials to use.
To fix it:  aws configure --profile typo-profile
```

## When it doesn't work

### s3cab can't find any credentials

```text
No credentials found for set 'photos'.

Set 'photos' uses profile 's3cab-backup', but it isn't in your AWS config.
...
```

The error names the set, says where it looked, and — where it can pinpoint the cause — leads
with the specific problem: a profile that isn't in your AWS config, or a non-AWS endpoint with
no keys saved. Follow the fix it prints.

### The server rejects your credentials

s3cab names the cause and shows the raw error. By cause:

| What you see             | Usually means                    | Fix                                                                  |
| ------------------------ | -------------------------------- | -------------------------------------------------------------------- |
| **Expired credentials**  | a session ran out                | `aws sso login` again, or refresh the temporary credentials           |
| **Invalid credentials**  | wrong or stale key               | re-enter them: `s3cab provider --keys <set>`                          |
| **Signature mismatch**   | wrong secret, region, or endpoint | check the secret is complete; confirm region/endpoint match the bucket |
| **Permission denied**    | signed in, but not allowed       | on AWS, `s3cab aws <bucket>` prints the least-privilege policy        |
| **Clock out of sync**    | your clock drifted               | sync it — S3 rejects requests too far off                            |

**Signature mismatch is the classic non-AWS trap**: a Cloudflare R2 or Backblaze B2 bucket
with the wrong endpoint or region label produces exactly this. Check both before suspecting
the secret.

## What s3cab will never do

- **Write your AWS config.** `~/.aws/config` and `~/.aws/credentials` are yours. s3cab reads
  them (to use a profile, and to check a name for typos) and never edits them.
- **Take a secret as a flag.** See above.
- **Keep a login session.** Interactive sign-in is the AWS CLI's job; s3cab consumes the
  result.
- **Log a credential.** Not to the terminal, not under `S3CAB_DEBUG`.
