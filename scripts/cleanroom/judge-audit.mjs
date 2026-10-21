/**
 * Decide whether a clean-room run is void, from the moves audit-transcript.mjs gathered
 * into `audit.json` beside the brief: a model reads each with what the tool returned and
 * says whether it could have told the session how s3cab behaves. The matcher over-flags
 * on purpose, and the judge's reason for each move is printed, so anyone can overrule
 * it. Exits 1 if any move voids the run, or if the judge's answer can't be read.
 *
 * A model's reading is enough here: the run measures an English spec, and a cheat the
 * judge misses only flatters the spec until a later run catches it (README.md).
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exampleRoot, sandboxPath } from "./cleanroom.mjs";

const model = "claude-opus-5-5";

/**
 * @typedef {{ matched: string, tool: string, input: string, result: string }} Move
 * @typedef {{ allowed: string[], moves: Move[] }} Evidence
 * @typedef {{ move: number, verdict: "voids" | "harmless", reason: string }} Verdict
 */

/** What the judge is asked, the moves numbered from 1. @param {Evidence} evidence */
export function judgePrompt(evidence) {
  const moves = evidence.moves
    .map(
      (move, i) =>
        `## Move ${i + 1}: ${move.tool}, flagged for ${move.matched}\n\n` +
        `Input:\n${move.input}\n\nWhat came back:\n${move.result}`,
    )
    .join("\n\n");
  return `You are judging a clean-room test. A session was given only a file format's spec and a
brief, and built a program from them, so that its list of the spec's gaps measures how good
the spec is. It must not learn how the tool the format belongs to (s3cab) behaves from
anywhere else: not its source, docs or website, real snapshots under ~/.s3cab, other Claude
Code sessions' transcripts or memory under ~/.claude, earlier runs' reports, nor by running
s3cab. Its own places, where it may do anything, are:

${evidence.allowed.map((place) => `- ${place}`).join("\n")}

An automatic matcher flagged the moves below, each with what the tool returned. It flags
more than it should on purpose. For each move, decide:

- "voids": the session got something from outside its own places that could have told it
  how s3cab behaves or how its format should be read.
- "harmless": nothing came back, the call failed or was refused, what came back can't say
  anything about s3cab or its format (a compiler, the system, its own temp folder, its
  bucket's S3 responses), or the flagged text isn't a move outside at all (prose, a regex).

When in doubt, "voids".

Answer with only a JSON array, one object per move in order:
{"move": <number>, "verdict": "voids" or "harmless", "reason": "<one sentence>"}

${moves}
`;
}

/**
 * The judge's verdicts, or undefined if its answer isn't one well-formed verdict per move.
 * @param {string} answer
 * @param {number} count
 * @returns {Verdict[] | undefined}
 */
export function readVerdicts(answer, count) {
  const start = answer.indexOf("[");
  const end = answer.lastIndexOf("]");
  /** @type {unknown} */
  let parsed;
  try {
    parsed = JSON.parse(answer.slice(start, end + 1));
  } catch {
    return undefined;
  }
  const verdicts = Array.isArray(parsed) ? parsed : [];
  const wellFormed = verdicts.every(
    (verdict, i) =>
      verdict?.move === i + 1 &&
      (verdict.verdict === "voids" || verdict.verdict === "harmless") &&
      typeof verdict.reason === "string",
  );
  return wellFormed && verdicts.length === count ? verdicts : undefined;
}

if (import.meta.main) {
  const [arg, ...extra] = process.argv.slice(2);
  if (!arg || extra.length > 0) {
    console.error(
      "usage: node scripts/cleanroom/judge-audit.mjs <root>\n\n" +
        `e.g. node scripts/cleanroom/judge-audit.mjs ${exampleRoot}`,
    );
    process.exit(2);
  }
  const file = join(sandboxPath(arg), "cleanroom", "audit.json");
  if (!existsSync(file)) {
    console.error(
      `${file} doesn't exist. Run audit-transcript.mjs on this sandbox first.`,
    );
    process.exit(2);
  }
  /** @type {Evidence} */
  const evidence = JSON.parse(readFileSync(file, "utf8"));
  if (evidence.moves.length === 0) {
    console.log("Nothing to judge.");
    process.exit(0);
  }
  // From temp, so it is no session of the clean room's, with no tools and nothing of the
  // user's loaded. Through the shell: an npm install puts `claude.cmd` on a Windows PATH,
  // which Node can't start without one.
  const judged = spawnSync(
    `claude -p --safe-mode --tools "" --no-session-persistence --model ${model}`,
    {
      shell: true,
      cwd: tmpdir(),
      input: judgePrompt(evidence),
      encoding: "utf8",
    },
  );
  const verdicts = readVerdicts(judged.stdout ?? "", evidence.moves.length);
  if (!verdicts) {
    console.log(
      `The judge's answer couldn't be read, so the run counts as void until someone reads ` +
        `the moves in audit.json (claude exited ${judged.status}):\n` +
        `${judged.stdout}${judged.stderr}`,
    );
    process.exit(1);
  }
  console.log(`${verdicts.length} move(s) judged by ${model}:`);
  for (const [i, verdict] of verdicts.entries()) {
    const move = evidence.moves[i];
    console.log(
      `  ${verdict.verdict.padEnd(8)} ${move?.matched} | ${move?.tool}: ${move?.input.slice(0, 200)}\n` +
        `           ${verdict.reason}`,
    );
  }
  const voiding = verdicts.filter((verdict) => verdict.verdict === "voids");
  if (voiding.length > 0) {
    console.log(`${voiding.length} move(s) void the run.`);
    process.exit(1);
  }
  console.log("None voids the run.");
}
