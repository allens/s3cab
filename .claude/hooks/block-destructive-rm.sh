#!/usr/bin/env bash
# Prompt on destructive `rm` — any rm carrying a recursive (-r/-R/--recursive) or
# force (-f/--force) flag, in any flag ordering or bundling, anywhere in a
# compound command. Plain non-recursive `rm <file>` still runs.
#
# Updated 2026-08-15. This used to return "deny", and existed because a bare
# `Bash` allow auto-approved everything not explicitly denied. That allow is gone
# and auto mode is the permission model now, so the classifier reads every rm.
# What the classifier does not offer is determinism, and what the static deny
# `Bash(rm -rf *)` could not do is parse — a prefix match misses `rm -r`,
# `rm -fr`, `rm -f`, `rm --recursive`, and every compound form. So this hook
# remains the deterministic detector and now returns "ask": a checkpoint that can
# be cleared, not a wall. `Bash(rm -rf *)` was removed from settings.json in the
# same change — it was a strict subset of what this parses, and being a deny it
# resolved first, which made this hook's verdict unreachable for the one command
# shape people actually type.
#
# Fired by the PreToolUse hook on every Bash call in .claude/settings.json (no
# "if" scope) because the dangerous rm is usually mid-compound, e.g.
# `cd build && rm -rf .` or `ls | xargs rm -rf` — a prefix-only gate would miss
# those. Detection is in node so flag bundling/ordering and shell separators are
# parsed, not pattern-guessed.
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
          permissionDecision: "ask",
          permissionDecisionReason:
            "Recursive or forced rm. This always prompts, whatever the permission mode. It is detected by parsing the command, so it catches -r / -fr / -f / --recursive in any ordering and anywhere in a compound (`cd build && rm -rf .`, `ls | xargs rm -rf`) — which the classifier judges but no static rule can match. Check the path is the one you meant, then approve.",
        },
      }),
    );
  }
});
'
exit 0
