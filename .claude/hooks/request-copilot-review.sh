#!/usr/bin/env bash
# Request a Copilot review on the PR for the current branch.
#
# Fired automatically by the PostToolUse hook on `gh pr create` (.claude/settings.json),
# so requesting a Copilot review is part of the single "commit, create pr" step
# rather than a manual follow-up (CLAUDE.md convention #15). Safe to run by hand
# too: `bash .claude/hooks/request-copilot-review.sh`.
#
# Best-effort by design: if there is no PR for the current branch, or Copilot
# review is not enabled on the repo, it prints a note and exits 0 — it must
# never fail the PR flow it rides on.
#
# The reviewer is the Copilot bot, requested via the GraphQL `requestReviews`
# mutation with `botIds` (the REST path silently no-ops — see CLAUDE.md #15).
set -uo pipefail

# The Copilot reviewer's GraphQL node id. Re-fetch if it ever changes:
#   gh api user/175728472 --jq .node_id
COPILOT_BOT_ID="BOT_kgDOCnlnWA"

pr_id="$(gh pr view --json id -q .id 2>/dev/null)"
if [ -z "$pr_id" ]; then
  echo "request-copilot-review: no PR for the current branch — nothing to do." >&2
  exit 0
fi

if gh api graphql \
  -f query='mutation($pr:ID!,$ids:[ID!]!){ requestReviews(input:{pullRequestId:$pr,botIds:$ids,union:true}){ pullRequest{ reviewRequests(first:10){ nodes{ requestedReviewer{ __typename ... on Bot{ login } } } } } } }' \
  -f pr="$pr_id" \
  -f ids="$COPILOT_BOT_ID" >/dev/null 2>&1
then
  echo "request-copilot-review: requested Copilot review on this PR." >&2
else
  echo "request-copilot-review: could not request Copilot review (is it enabled on this repo?) — skipping." >&2
fi
exit 0
