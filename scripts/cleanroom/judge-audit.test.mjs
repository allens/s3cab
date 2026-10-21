import assert from "node:assert/strict";
import { test } from "node:test";
import { judgePrompt, readVerdicts } from "./judge-audit.mjs";

const verdicts = [
  { move: 1, verdict: "harmless", reason: "its own temp folder" },
  { move: 2, verdict: "voids", reason: "read a real snapshot" },
];

test("the verdicts are read from an answer with text around them", () => {
  const answer = `Here they are:\n\`\`\`json\n${JSON.stringify(verdicts)}\n\`\`\`\n`;
  assert.deepEqual(readVerdicts(answer, 2), verdicts);
});

test("an answer that isn't one verdict per move, in order, isn't read", () => {
  for (const answer of [
    "",
    "I can't judge these.",
    "[not json]",
    JSON.stringify(verdicts.slice(0, 1)),
    JSON.stringify([verdicts[1], verdicts[0]]),
    JSON.stringify([verdicts[0], { ...verdicts[1], verdict: "unsure" }]),
    JSON.stringify([verdicts[0], { move: 2, verdict: "voids" }]),
  ]) {
    assert.equal(readVerdicts(answer, 2), undefined, answer);
  }
});

test("the prompt carries each move with what came back", () => {
  const prompt = judgePrompt({
    allowed: ["/srv/s3cab.sandbox/cleanroom"],
    moves: [
      {
        matched: "/home/runner/.s3cab",
        tool: "Bash",
        input: '{"command":"ls ~/.s3cab"}',
        result: "sets",
      },
    ],
  });
  assert.ok(prompt.includes("- /srv/s3cab.sandbox/cleanroom"), prompt);
  assert.ok(
    prompt.includes(
      '## Move 1: Bash, flagged for /home/runner/.s3cab\n\nInput:\n{"command":"ls ~/.s3cab"}\n\nWhat came back:\nsets',
    ),
    prompt,
  );
});
