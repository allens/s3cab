# Retention policy

Epic: automated retention over the manual `forget`/`cleanup` pair — keep-last *N*, plus daily /
weekly / monthly tiers.

This is the **one open piece of the backup plan**. The other four slices of
[docs/design/backup.md](../docs/design/backup.md) are built, and their settled sub-decisions are
of record in [ADR-0033](../docs/adr/0033-bucket-onboarding-security-model.md) /
[0044](../docs/adr/0044-upload-unified-command-surface.md) /
[0045](../docs/adr/0045-change-detection-local-baseline-list-fallback.md) /
[0027](../docs/adr/0027-compare-local-only-adoption-syncs-manifests.md) /
[0053](../docs/adr/0053-reattach-command.md).

**Deliberately deferred until real usage shows the shapes.** The primitives exist —
[ADR-0063](../docs/adr/0063-forget-snapshots-delete-paths.md) splits snapshot-forgetting from
path-deletion, and [ADR-0064](../docs/adr/0064-path-scoped-delete-deletion-record.md) gives the
deletion record — so a policy layer is composition over `forget`, not new engine work. What's
missing is evidence about which retention shapes people actually want, and picking a flag surface
before that is the speculative structure CLAUDE.md's over-engineering rule forbids.

Open questions when it is picked up:

- **Where the policy lives** — per-set config under `~/.s3cab/sets/<set>/`, or flags on each run?
  Per-set config is the obvious guess, but it adds a config surface that has to be explained.
- **Whether it runs automatically** after `backup`, or only on an explicit `s3cab forget --policy`
  invocation. Automatic pruning of backups is a destructive default; the command-shape decision
  wants the [`cli-design`](../.claude/skills/cli-design/) skill and probably an ADR.
- **Interaction with the deletion record** — a policy run could produce many records at once, which
  feeds the unbounded-growth item in [performance.md](performance.md).
