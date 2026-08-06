# Dependency updates via Dependabot, not Renovate

**Status:** accepted

Dependency updates use **Dependabot**: native to GitHub, zero extra accounts/config. Renovate
would be over-engineering for this dependency surface ([0005](0005-builtins-over-dependencies.md),
[0006](0006-minimal-code.md)).

## Details

- **Weekly, grouped on purpose**: the `@aws-sdk/*` packages version in lockstep and publish
  near-daily, so ungrouped PRs would flood the queue. `@smithy/*` is grouped **with** them — same
  release train, and the direct `@smithy/*` deps share the transitive `@smithy/core` pin the SDK
  packages carry. Left ungrouped it produced three PRs all rewriting the same lockfile block, so
  merging any one made the rest conflict; `main` requires branches be up to date, so each merge
  also forced a rebase and a full 3-OS CI re-run on every PR still open.
- The **security** half (CVE-driven alerts/PRs) is enabled in repo *settings* — UI-only, can't
  live in the YAML.
- **Auto-merge is deliberately off — every dependency PR is read by a person.** It was built and
  then removed the same day, so this is a decision rather than an omission, and the reasoning
  lives here because a deleted workflow file records nothing.

  The case for it was reducing the merge treadmill. But the treadmill was never the real cost —
  *conflicts* were, and grouping fixed those. What auto-merge actually removes is the only pair
  of eyes on a lockfile diff, where a new transitive dependency, a package rename or a licence
  change would otherwise be noticed.

  It also mattered more than it first appeared. `release.yml` builds with `npm ci`, so the SEA
  binary and the portable bundle **freeze the lockfile at tag time, permanently** — for those two
  channels a merged Dependabot PR *is* the shipped supply chain. Only the npm tarball floats
  (carets, no published lockfile), and only its users self-heal.

  If auto-merge is ever reconsidered, note what made it defensible at all:
  [fresh-deps.yml](../../.github/workflows/fresh-deps.yml) tests a newer-or-equal SDK against a
  real bucket weekly. Without that canary a green `ci gate` is a weak signal for an SDK bump —
  the unit tier mocks the `s3.mjs` seam and `s3 integration` is skipped on Dependabot PRs.

- **Security advisories reach `main`, never a tag.** Dependabot alerts scan the default branch's
  lockfile only, so a CVE affecting a version still frozen inside a *released* binary raises
  nothing once `main` has moved past it. When an advisory fires, check the last release tag's
  lockfile too — see [docs/releasing.md](../releasing.md). The
  `npm audit` gate in `release.yml` covers the other direction: it stops a *new* release shipping
  a known high-severity advisory.
