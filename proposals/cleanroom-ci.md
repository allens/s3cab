# Clean rooms in GitHub Actions

**Proposed, not yet reviewed.** My idea: run the clean-room *sessions* themselves in GitHub
Actions — **macOS only**, the one platform I can't easily run locally. Windows and Linux stay on
my machine, where runs use my subscription; a CI run bills the API key, which costs far more.
Builds on [cleanroom-harness.md](cleanroom-harness.md).

Distinct from what ADR-0096 already settles for CI: a matrix that builds and runs the committed
programs and never writes them. This is about writing them there. It reopens ADR-0096's "the
macOS programs wait for a Mac", whose case against a hosted runner was that a job checks out the
repo the clean room mustn't see, can't ask anything mid-run, and stops at six hours. Runs are
headless now, so only the first still stands, and it is what this design answers.

## Why a runner

- **A platform I don't have:** macOS.
- **Cleaner than home.** A runner's home is empty: no `~/.s3cab` with real snapshots, no
  `~/.claude` holding every s3cab session's transcripts and memory. Those are the two leaks the
  harness README says only the transcript audit catches locally.

## One run is one job

One job, because each job gets a fresh machine and the sandbox has to stay where it was built:
the fixtures' natural mtimes don't survive a copy, and the checkers run s3cab against the same
trees. Triggered by hand (`workflow_dispatch`), with role, platform, model and effort as inputs.

1. **Check out and build.** `actions/checkout` with `persist-credentials: false`, `npm ci`, bucket
   credentials through OIDC, then `build-…-cleanroom.mjs ~/s3cab.sandbox`, which writes static
   session keys into the clean room as it does locally.
2. **Delete what the session mustn't see:** the checkout with its `node_modules`, and the npm
   cache.
3. **Run the session:** install `claude`, then the same `claude -p --safe-mode …` from
   `~/s3cab.sandbox/cleanroom`. The API key goes to this step alone; the GitHub token to none.
4. **Check out again and check:** `npm ci`, the role's checker, `audit-transcript.mjs`.
5. **Keep:** delete the credentials, upload the clean room with `check.txt` and `audit.txt` as a
   build artifact. Harvesting stays human: download it and read the report.

(Checking out, deleting the checkout and carrying on is my idea too.) The platform input exists
so the same workflow can run Windows or Linux if ever wanted, but the default use is macOS.

**Not three copied files instead of a checkout** (`format.md`, the brief and a `bootstrap.mjs`
fetched from GitHub): steps 1 and 4 need s3cab *at the commit under test*, which isn't
published. The clean room receives only the spec and the brief either way; the harness never
enters it. The stronger form of that idea is a Linux prep job bundling s3cab and the harness into
one artifact, so the platform job never holds the repo at all — more to build, so start with
checkout-and-delete.

## What the delete doesn't cover

Each is reachable during step 3, and needs handling or the audit watching it:

- **`$GITHUB_EVENT_PATH` and the `GITHUB_*` variables** name the repo and the commit, and the
  payload can carry commit messages. Delete the file and unset the variables for the run step.
- **The repo is public,** so the session can browse it, as it can at home. Same defences: the
  brief, and the audit flagging any web access, which voids the run. On Linux a firewall rule
  could block `github.com`; harder on macOS and Windows.
- **The audit learns CI's paths:** the runner's work and temp directories, and the payload file.

## Before it can run

- CI-owned clean-room buckets, `test-s3cab-ci-cleanroom-restore` and `-backup` (ADR-0096's
  naming), with their IAM in the platform repo's Terraform.
- An `ANTHROPIC_API_KEY` secret; spend capped by `--max-budget-usd` as now.
- A concurrency group on the backup bucket, since backup runs take turns emptying it. Restore runs
  only read, so they can run side by side.

## Seeding the golden set per platform

Every golden-set snapshot today is a Linux backup, so no restorer ever reads one with drive
letters and backslashes, and a Windows backup restored on Windows — the commonest real restore —
is the case nothing tests. Seed per platform into the one golden bucket, sets suffixed by the
platform that backed them up (`edge-linux`, `edge-windows`, …): a matrix job, one runner per OS,
taking turns on the bucket. Linux keeps the POSIX-only fixtures; Windows adds drive letters,
backslashes, Windows-reported casing and long paths; macOS adds APFS's view. Every restorer
restores every platform's sets, and each restore build already makes its reference with s3cab's
own restore on the OS under test. Sets sharing objects is harmless here: everything in the golden
bucket is s3cab's own backup. The stamp then has to cover each platform's seed. **Seeded in CI on
all three platforms:** seeding runs no Claude session, so it costs runner minutes and no tokens,
and one job keeps the three seeds consistent.

## Left to the implementing session

Making a CI run and a local run work the same way — the buckets, credentials and paths each
uses — is refined when this is built, not here.

## Unverified

- Runner minutes on a public repo are free on the standard runners, macOS included — current
  terms not checked.
- Whether a Windows runner creates symlinks without elevation (it did on the local machine).
