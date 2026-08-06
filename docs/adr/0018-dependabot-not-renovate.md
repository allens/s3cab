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
- **Auto-merge is on for npm updates**, via
  [.github/workflows/dependabot-auto-merge.yml](../../.github/workflows/dependabot-auto-merge.yml)
  — not for GitHub Actions updates, whose risk is supply chain rather than correctness. It is
  safe only because [fresh-deps.yml](../../.github/workflows/fresh-deps.yml) tests a
  newer-or-equal SDK against a real bucket every week; both workflows carry the full reasoning
  in their headers, which is where it belongs. **Don't enable auto-merge if that canary is ever
  removed.**
