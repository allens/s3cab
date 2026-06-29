#!/usr/bin/env bash
# Block destructive `rm` — any rm carrying a recursive (-r/-R/--recursive) or
# force (-f/--force) flag, in any flag ordering or bundling, anywhere in a
# compound command. Closes the gap the static deny rule `Bash(rm -rf *)` leaves
# open now that a bare `Bash` allow auto-approves everything not denied (CLAUDE.md's
# permission-prompt convention): a fixed `-rf` prefix misses `rm -r`, `rm -fr`, `rm -f`,
# `rm --recursive`, `rm -r -f`, etc. Plain non-recursive `rm <file>` still runs.
#
# Fired by the PreToolUse hook on every Bash call in .claude/settings.json (no
# "if" scope) because the dangerous rm is usually mid-compound, e.g.
# `cd build && rm -rf .` or `ls | xargs rm -rf` — a prefix-only gate would miss
# those. Detection is in node (already used by the sibling git -C hook) so flag
# bundling/ordering and shell separators are parsed, not pattern-guessed.
set -uo pipefail

cat | node -e '
let s = "";
process.stdin.on("data", (c) => (s += c));
process.stdin.on("end", () => {
  let cmd = "";
  try { cmd = JSON.parse(s).tool_input?.command ?? ""; } catch { cmd = ""; }
  // Inspect each segment of a compound command independently.
  const segments = cmd.split(/&&|\|\||;|\||\n/);
  const dangerous = segments.some((seg) => {
    let toks = seg.trim().split(/\s+/).filter(Boolean);
    // Strip leading env assignments (FOO=bar) and bare command wrappers so
    // `FOO=bar sudo rm -rf x` and `xargs rm -rf` are still seen as rm.
    while (
      toks.length &&
      (/^[A-Za-z_][A-Za-z0-9_]*=/.test(toks[0]) ||
        toks[0] === "sudo" ||
        toks[0] === "xargs")
    )
      toks.shift();
    if (!toks.length) return false;
    if (toks[0].split("/").pop() !== "rm") return false; // rm, /bin/rm, …
    return toks.slice(1).some((t) => {
      if (t === "--") return false; // end-of-options; stop treating as flags
      if (t === "--recursive" || t === "--force") return true;
      return /^-[A-Za-z]+$/.test(t) && /[rRf]/.test(t); // bundled short flags
    });
  });
  if (dangerous) {
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason:
            "Destructive rm (recursive/force) is blocked under the bare-Bash allow (the permission-prompt convention in CLAUDE.md). The static `rm -rf *` deny misses the -r / -fr / -f / --recursive orderings; this hook closes them. If a deliberate, scoped delete is genuinely needed, ask the user to run it (or confirm) rather than widening the rule.",
        },
      }),
    );
  }
});
'
exit 0
