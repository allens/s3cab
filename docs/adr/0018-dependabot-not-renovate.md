# Dependency updates via Dependabot, not Renovate

**Status:** accepted

Dependency updates use **Dependabot**: native to GitHub, zero extra accounts/config. Renovate
would be over-engineering for this dependency surface ([0005](0005-builtins-over-dependencies.md),
[0006](0006-minimal-code.md)).

## Details

- **Weekly, grouped on purpose**: the `@aws-sdk/*` packages version in lockstep and publish
  near-daily, so ungrouped PRs would flood the queue.
- The **security** half (CVE-driven alerts/PRs) is enabled in repo *settings* — UI-only, can't
  live in the YAML.
- Auto-merge of green patch/minor PRs is deliberately **not** enabled yet — a trust call to
  revisit.
