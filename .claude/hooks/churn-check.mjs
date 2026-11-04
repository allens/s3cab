// Stop hook: block a reply that weighs an option by the size of its diff — CLAUDE.md
// working convention 3, "the diff that gets there is free". Checks every assistant
// text block since the last human prompt; quoted and code text is skipped.
import { readFileSync } from "node:fs";

const input = JSON.parse(readFileSync(0, "utf8"));
// Already blocked once this turn: let it stop rather than loop.
if (input.stop_hook_active) {
  process.exit(0);
}

const entries = readFileSync(input.transcript_path, "utf8")
  .split("\n")
  .filter(Boolean)
  .map((line) => JSON.parse(line));

const texts = [];
for (const { type, message } of entries) {
  const content = message?.content;
  if (type === "user") {
    // A tool result is a user entry too; only a human prompt starts a new turn.
    const isPrompt =
      typeof content === "string" || content?.some((c) => c.type === "text");
    if (isPrompt) {
      texts.length = 0;
    }
  } else if (type === "assistant" && Array.isArray(content)) {
    for (const c of content) {
      if (c.type === "text") {
        texts.push(c.text);
      }
    }
  }
}

const found = texts
  .join("\n")
  .replace(/```[\s\S]*?```|`[^`\n]*`|"[^"\n]*"|“[^”\n]*”/g, "")
  .match(
    /\b(smallest|smaller|bigger|larger|minimal) (change|diff|footprint)\b|\bfewer lines\b|\bdiff size\b|\b(less|more|least|test|code) churn\b/gi,
  );

if (found) {
  const list = [...new Set(found.map((f) => f.toLowerCase()))].join(", ");
  console.log(
    JSON.stringify({
      decision: "block",
      reason: `Your reply says ${list}. Diff size is never a reason to pick an option (CLAUDE.md working convention 3): judge each by the code it leaves behind, and repeat the point without it. If the phrase isn't weighing an option, say so in one line.`,
    }),
  );
}
