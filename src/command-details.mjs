// Command details — the multi-line `--help` bodies that help.mjs renders under
// "Description:" via each command's registry `details` field. Named `details`
// (not `description`) to avoid clashing with an arg/option's one-line
// `description`. The invariant: every command `details` string lives here, so the
// registry in commands.mjs stays a scannable table of one-line summaries and
// per-arg/option text rather than burying pages of prose. Plain strings only (no
// command/auth imports), so this stays as SDK-free as help.mjs. Short one-liners
// belong inline in the registry, not here.

export const compareDetails = `The report compares file content (SHA-256 hashes), never timestamps.
Renamed and Moved entries read 'old.txt → new.txt'; an added file whose
content already existed elsewhere is noted '(duplicate of ...)'.
Full guide: https://s3cab.plantegral.com/guide/compare`;

export const awsDetails = `It only PRINTS the steps — it never touches your account and needs no
credentials to run, so you can read the whole plan first. It emits a
CloudFormation template that stands up the bucket (versioning ON as your
safety net, and Retain-protected so a stack delete can't destroy it) plus a
least-privilege identity that can never permanently destroy backup history.
Deploy it, mint one access key, point s3cab at it.

Choosing an identity:
  (default)          a dedicated AWS IAM user with an access key
  --roles-anywhere   keyless, certificate-based access (recommended)

With --roles-anywhere it generates a machine-level CA + client certificate
under ~/.s3cab/roles-anywhere/ (the private key never leaves your machine),
emits a template embedding the public CA as a trust anchor, then captures the
deployed stack's ARNs back with:
  s3cab aws --roles-anywhere --save --from-stack s3cab-<bucket>

AWS only. For a non-AWS S3 provider (Cloudflare R2, Backblaze B2, Wasabi,
MinIO, …), run 's3cab help provider' for the setup steps instead. Signing in
with AWS IAM Identity Center (SSO)? It works through the standard credential
chain — no separate setup; see 's3cab help provider'.

Then create a backup set in it:
  s3cab setup --set <name> --bucket <bucket> <directory>...

Full guide: https://s3cab.plantegral.com/guide/aws`;

export const providerDetails = `Changes or shows how a set signs in to its storage provider — an AWS
profile, a custom S3 endpoint (any S3-compatible provider), a region, and
access keys. The initial setup is usually done when you create the set
('s3cab setup', same knobs); use this to change it later, or run it with no
flags to see the current setup.

Setting up a non-AWS S3 provider (Cloudflare R2, Backblaze B2, Wasabi,
MinIO, …):

1. Create your bucket in the provider's console (or its CLI).
2. Turn on object versioning if the provider supports it — your safety
   net, so a deleted or overwritten backup stays recoverable.
3. Create an access key / token scoped to that bucket, with read, write,
   delete, and list on its objects (R2: API Tokens; B2: Application Keys;
   Wasabi: sub-users).
4. Create the backup set, pointed at the provider in one command:
     s3cab setup --set <name> --bucket <bucket> --endpoint https://<your-endpoint> --region auto --keys <dir>...
   (--keys asks for the key + secret; some providers need a real region,
   e.g. us-east-1. Change these later with 's3cab provider'. s3cab drops
   AWS-only request features automatically when a custom endpoint is set.)

On AWS instead? 's3cab aws <bucket>' prints the full bucket + identity
recipe, ending back here at --profile.

How s3cab resolves credentials:

1. s3cab loads the active set's env file first, if present. It sets AWS_*
   variables — a profile, region, endpoint, or keys (all settable with
   this command). It is the one s3cab config layer, applied over your
   shell (a file always beats the shell):
     ~/.s3cab/sets/<set>/env  the set's bucket + how to reach it
                              (written by 's3cab setup' and this command)
   There is no per-user s3cab file; your machine-wide default is your
   ordinary AWS setup (step 2). s3cab does NOT read a .env from the
   current directory.

2. s3cab then uses the standard AWS SDK credential chain.
   This includes existing AWS_PROFILE, shared AWS profiles (including
   SSO sessions from 'aws sso login'), shared credential_process
   profiles, and AWS_* environment variables.

3. If nothing is configured, s3cab stops with an error explaining
   these options.

Notes:
  - s3cab does not modify ~/.aws/config or ~/.aws/credentials.
  - Keys are never taken via flags (they'd leak into shell history) —
    --keys prompts at a terminal, or reads two lines from stdin.
  - A set signs in one way: a profile OR keys, not both. Setting one
    with this command clears the other on that set.
  - For AWS, temporary credentials from profile-based setups are preferred
    over long-lived keys.
  - To keep a long-lived key/secret out of plaintext env files, store it
    in a secret manager and expose it through a credential_process profile
    — the full guide has the recipe.

When the server rejects your credentials:

s3cab names the cause and shows the raw error. By cause:

  Expired credentials
    - AWS IAM Identity Center (SSO): run 'aws sso login' again
    - temporary credentials (AWS_SESSION_TOKEN): request a fresh set
    - a named profile: renew it (and set AWS_PROFILE)

  Invalid / rejected credentials
    Replace the credentials s3cab is using, by their source:
    - the set's env file: re-enter the key + secret with
      's3cab provider --keys <set>', or re-check a temporary
      AWS_SESSION_TOKEN in your shell (no stray quotes or spaces)
    - a profile: renew it, and confirm AWS_PROFILE names the right one
    - SSO: run 'aws sso login' again

  Signature mismatch
    Almost always a wrong secret, region, or endpoint:
    - confirm AWS_SECRET_ACCESS_KEY is correct and complete
    - confirm AWS_REGION matches the bucket's region
    - non-AWS providers: confirm the endpoint (AWS_ENDPOINT_URL_S3) matches
      your provider — a wrong endpoint/region is the classic Cloudflare R2 /
      Backblaze B2 trap

  Permission denied (signed in, but not allowed)
    - on AWS, run 's3cab aws <bucket>' for the exact least-privilege policy
    - on another provider, grant the token list + read/write on the bucket

  Clock out of sync
    S3 rejects requests whose time drifts too far. Sync your clock:
    - Windows: Settings > Time & language > Date & time > Sync now
    - macOS:   sudo sntp -sS time.apple.com
    - Linux:   sudo timedatectl set-ntp true

Full guide: https://s3cab.plantegral.com/guide/auth`;
