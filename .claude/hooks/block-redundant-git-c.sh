#!/usr/bin/env bash
# Block `git -C <path>` when <path> is the already-checked-out repo (cwd or its
# toplevel). That form bypasses path-free allow/deny permission rules and forces
# new literal one-off allow entries every time (CLAUDE.md's worktree convention: "Run
# bare commands — don't prepend cd ... git -C <the-cwd-path> is the same trap").
#
# Fired by the PreToolUse hook on every Bash call in .claude/settings.json (no
# "if" scope) because the redundant usage is often embedded mid-command, e.g.
# `echo "..." && git -C d:/src/s3cab status` — a prefix-only "if" gate on
# `Bash(git -C *)` would miss those, which is most of the real occurrences.
set -uo pipefail

input=$(cat)
cmd=$(printf '%s' "$input" | node -e '
let s = "";
process.stdin.on("data", c => s += c);
process.stdin.on("end", () => {
  try { process.stdout.write(JSON.parse(s).tool_input?.command ?? ""); }
  catch { process.stdout.write(""); }
});
')

# Find every `git -C <path>` occurrence anywhere in the command (not just a
# leading one) — most real occurrences are mid-compound (after `cd`/`echo`/`&&`).
paths=$(printf '%s' "$cmd" | grep -oE 'git[[:space:]]+-C[[:space:]]+("[^"]+"|[^[:space:]]+)' \
  | sed -E 's/^git[[:space:]]+-C[[:space:]]+//; s/^"//; s/"$//')

[ -z "$paths" ] && exit 0

norm() {
  printf '%s' "$1" | tr 'A-Z' 'a-z' | tr '\\' '/' | sed -e 's#/$##'
}

target_root=$(git rev-parse --show-toplevel 2>/dev/null)
ncwd=$(norm "$PWD")
nroot=$(norm "$target_root")

while IFS= read -r path; do
  [ -z "$path" ] && continue
  np=$(norm "$path")
  if [ "$np" = "$ncwd" ] || { [ -n "$nroot" ] && [ "$np" = "$nroot" ]; }; then
    cat <<EOF
{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"git -C on the already-checked-out repo is redundant and bypasses path-free allow/deny rules (CLAUDE.md's worktree convention). Re-run as bare 'git ...' instead — cwd is already this repo."}}
EOF
    exit 0
  fi
done <<< "$paths"

exit 0
