#!/usr/bin/env bash
# Request a Copilot review on the PR for the current branch.
#
# Fired automatically by the PostToolUse hook on `gh pr create` (.claude/settings.json),
# so requesting a Copilot review is part of the single "commit, create pr" step
# rather than a manual follow-up. CLAUDE.md convention #15 carries the *rule* (when
# and why this fires); this header is the source of truth for the *mechanics*. Safe
# to run by hand too: `bash .claude/hooks/request-copilot-review.sh`.
#
# Best-effort by design: if there is no PR for the current branch, or Copilot
# review is not enabled on the repo, it prints a note and exits 0 — it must
# never fail the PR flow it rides on.
#
# ── How the request actually works (hard-won; the obvious paths silently fail) ──
# The requestable reviewer is the bot `Copilot` (REST login `Copilot`, app
# `copilot-pull-request-reviewer[bot]`, db id 175728472, node `BOT_kgDOCnlnWA`; in a
# GraphQL `reviewRequests` it surfaces as Bot login `copilot-pull-request-reviewer`).
#
# The ONLY working programmatic path is the GraphQL `requestReviews` mutation with
# `botIds` (below). On success it echoes `copilot-pull-request-reviewer` in its
# `reviewRequests` — that echo is the confirmation. The dead ends, all of which look
# like success while attaching nobody:
#   * `botIds`, NOT `userIds` — Copilot is a `Bot` node (`BOT_` prefix), so `userIds`
#     rejects it ("Could not resolve to User node…"). That dead end made GraphQL look
#     impossible at first.
#   * The REST endpoint silently no-ops — `gh api repos/.../pulls/<n>/requested_reviewers
#     -f "reviewers[]=Copilot"` can return 200/201 and add nothing (it sends the literal
#     key `reviewers[]`; even a proper body, and a bogus reviewer name, "succeeded").
#   * `gh pr edit --add-reviewer` also silently no-ops, and the bot isn't in `suggestedActors`.
#   * `gh pr view --json reviewRequests` does not surface this bot — it can print `[]`
#     even when the request landed. Trust the mutation's echo, never the HTTP status.
#   * Web-UI fallback (Reviewers → Copilot) always works while Copilot review is enabled —
#     for when you're driving by hand.
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
