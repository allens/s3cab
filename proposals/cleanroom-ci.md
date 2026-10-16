# Clean rooms in GitHub Actions

**Proposed, reviewed once.** My idea: run the clean-room *sessions* themselves in GitHub
Actions — **macOS only**, the one platform I can't easily run locally. Windows and Linux stay on
my machine, where runs use my subscription; a CI run bills the API key, which costs far more.
Builds on [cleanroom-harness.md](cleanroom-harness.md). Seeding the restore fixtures per platform is
[cleanroom-seeding.md](cleanroom-seeding.md).

Distinct from what ADR-0096 already settles for CI: a matrix that builds and runs the committed
programs and never writes them. This is about writing them there. It reopens ADR-0096's "the
macOS programs wait for a Mac", whose case against a hosted runner was that a job checks out the
repo the clean room mustn't see, can't ask anything mid-run, and stops at six hours. Runs are
headless now, so the second goes. The first is what this design answers. The six hours stand:
GitHub terminates a job at 6 hours of execution time, headless or not.

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

- **`$GITHUB_EVENT_PATH` and the `GITHUB_*` variables** name the repo and the commit; for
  `workflow_dispatch` the payload holds the inputs, ref, repository and sender. Delete the file
  and unset the variables inside the run step's script: a step's `env:` can't do it, since
  GitHub ignores an assignment to a `GITHUB_*` or `RUNNER_*` variable.
- **The repo is public,** so the session can browse it, as it can at home. Same defences: the
  brief, and the audit flagging any web access, which voids the run. A hosts-file entry blocks a
  host on all three platforms, though a session with `sudo` can undo it. Blocking `github.com`
  alone misses the docs site: every example in `format.md` names `s3cab.plantegral.com`, which
  renders the README and `guide/`.
- **The audit learns CI's paths:** the runner's work and temp directories, and the payload file.
  On Windows, `RUNNER_TEMP` (`D:\a\_temp`, which holds the payload) is outside both the home
  folder and temp, so today's audit doesn't watch it.

*Reviewer's findings*, also reachable during step 3, which no delete reaches:

- **The runner is an administrator.** Linux and macOS runners have passwordless `sudo`; Windows
  runners run as administrators with UAC disabled. With root, a session can read the
  `Runner.Worker` process's memory, which holds every secret in the job and the job's
  `GITHUB_TOKEN`, as the tj-actions compromise did in March 2025. Without root, it can still
  read the environment of the job's other processes (`/proc/<pid>/environ`, `ps -E`). So "the
  API key goes to this step alone; the GitHub token to none" holds for the workflow file, not
  for the session.
- **The job can mint its own OIDC token.** `id-token: write`, which steps 1 and 4 need, puts
  `ACTIONS_ID_TOKEN_REQUEST_URL` and `ACTIONS_ID_TOKEN_REQUEST_TOKEN` on the runner. The token
  names the owner, repo and workflow, and assumes `s3cab-ci`, whose policy covers every
  `test-s3cab-ci-*` bucket: integration, conformance, crash and the restore fixtures, with write
  access. Step 1's exported AWS keys also stay in every later step's environment.
- **`RUNNER_TEMP` holds more than the payload:** the `_runner_file_commands` files, which may
  still hold step 1's keys. The runner's own diagnostic logs (`_diag`) may name the repo; their
  path and contents are unchecked.
- **The repo's name can't be hidden,** since the spec carries the site's URL and the sandbox is
  `s3cab.sandbox`. What matters is anything that leads to its contents.

## Isolation

*Reviewer's suggestion.* Deleting files can't reach process memory, so wall the session off
instead:

- **Run `claude` as a dedicated non-admin user**, created in the job (the runner's `sudo` can
  create it), whose home holds only the sandbox, with an allowlist of environment variables
  (`env -i …`). Unverified: creating a user on a hosted macOS runner (`sysadminctl -addUser`),
  and whether the runner's home is readable by another user.
- **Narrow the clean room's keys** with `configure-aws-credentials`' `inline-session-policy`:
  the role's one bucket, read-only for a restore run. That bounds what the OIDC role and a
  leaked key reach.
- **Make the credentials last the run.** `configure-aws-credentials` defaults to a 1-hour
  session (12 hours at most) and exports no expiry, so `cleanroom.mjs` writes no deadline into
  `ENVIRONMENT.md`, and a session that hits the 403 debugs its signing. Set
  `role-duration-seconds`, raise the `s3cab-ci` role's `MaxSessionDuration`, and get the
  deadline into `ENVIRONMENT.md`.
- **Time out the session step** (`timeout-minutes`, at most 360) early enough that the check
  and keep steps still run, whatever the session step's outcome.
- **Decide what the artifact may carry.** On a public repo anyone signed in to GitHub can
  download it, for 90 days by default. It holds whatever the session wrote, keys copied into its
  own scripts included. The transcript lives in `~/.claude/projects`, outside the clean room, so
  it is lost with the runner unless uploaded too, and it holds the API key if the session ever
  ran `env`.

## Before it can run

- CI-owned clean-room buckets, `test-s3cab-ci-cleanroom-restore` and `-backup` (ADR-0096's
  naming), created by an admin with the 365-day lifecycle. The CI policy's `test-s3cab-ci-*`
  wildcard already covers them; the platform repo's Terraform needs the buckets and the role's
  longer session. The restore bucket is also the one every home run reads
  ([cleanroom-seeding.md](cleanroom-seeding.md)), so home identities get read-only access to it.
- An `ANTHROPIC_API_KEY` secret; spend capped by `--max-budget-usd` as now.
- A concurrency group on the backup bucket, since backup runs take turns emptying it. Restore runs
  only read, so they can run side by side. A group keeps one pending run by default and cancels
  it when another arrives; `queue: max` keeps up to 100.
- The trust policy lets any event running on `main` assume the role (push, schedule,
  `workflow_dispatch`), so a dispatch from a branch, to try a harness change, is refused. A job
  that declares `environment:` is refused too, because its OIDC `sub` names the environment.

## Left to the implementing session

Making a CI run and a local run work the same way — the buckets, credentials and paths each
uses — is refined when this is built, not here.

*Reviewer's additions:*

- **The restore check.** The harness fixes the restorer's command line
  (`s3cab-restore <bucket> <set> <dir> [<snapshot>]`), so the checker can choose the output
  directory, but nothing says how the session's program is built and started.
- **The two-phase restore** (the harness's) is not in the steps above. Phase 1 has to run while
  `reference/` is somewhere the session's user can't read, or the references are built from a
  second checkout between the phases. Both phases fit inside the 6 hours, with the checks after,
  and the harvested program is phase 2's.
- **boto3 on macOS:** Homebrew's Python refuses a plain `pip install` (PEP 668), so the backup
  room needs a venv or a flag.
- **The image is not a stock Mac:** it ships full Xcode and Homebrew with many packages, so
  "comes as standard" and "nothing from Homebrew" can't be observed as they can on a new Mac.
- **Unverified:** `--permission-mode auto` under API-key billing in `-p` mode; on a Windows run,
  `fsutil file setCaseSensitiveInfo` on the runner's `D:\` volume.

## Checked

- **Runner minutes:** standard GitHub-hosted runners are free and unlimited on public
  repositories, and `macos-latest`, `macos-14`, `macos-15` and `macos-26` (3-core M1) are
  standard. The Free plan runs at most 5 macOS jobs at once.
- **Windows symlinks:** runners are administrators with UAC disabled, so processes run elevated
  and can create symlinks (an inference from the docs, not a run). Unlike a run at home, a CI
  Windows run is elevated.
