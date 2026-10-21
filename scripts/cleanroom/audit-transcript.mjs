/**
 * Gather what a clean-room session did, from its own transcript: the tokens it spent, by
 * model, and every move that could have handed it s3cab knowledge from outside the
 * sandbox, with what the tool returned. Nothing walls a session in (README.md says why),
 * so this is how a run that read past the brief gets caught rather than read as a spec
 * with fewer ambiguities. It only gathers: the moves go to `audit.json` beside the brief,
 * and judge-audit.mjs decides whether any voids the run, so a move flagged here that
 * turns out harmless costs nothing.
 *
 * A move is flagged for any of:
 * - a tool that took a path in the home folder, temp, the repo or the sandbox root,
 *   outside the clean room (a backup's fixtures too) and the session's own scratchpad and
 *   tool output, or off Windows its whole `claude-<uid>` temp folder. The root holds
 *   s3cab's home and the restores' exits, which only the brief keeps a Windows session
 *   from. A path is checked as typed and as its real path, and one starting `\\` or
 *   holding `\??\` outside those places is a stray wherever it leads;
 * - a shell command naming the home folder, temp or the repo, or running s3cab itself.
 *   The command is read as text, so a path built while it runs (in a variable, from an
 *   encoded string) isn't caught;
 * - any web search or fetch: the brief forbids looking the tool up, and no role needs
 *   the web to do its work. From the shell that is a URL whose host isn't an S3
 *   endpoint, any mention of a host serving s3cab's source or docs, or `gh`. A curl to
 *   S3 is not: a restorer may test its requests against the bucket. Nor is the URL in
 *   the spec's `@S3CAB FORMAT` row, which every snapshot carries. Not caught: a host
 *   held in a variable, a scheme-less host not on the list, and a URL in a file the
 *   session wrote and then ran, which is what a restorer is.
 * Paths elsewhere (a toolchain under Program Files, /usr) aren't flagged.
 * Each is listed as what matched, then the tool and the start of its input; strays.mjs
 * does the matching.
 *
 * Claude Code keeps a session's transcripts under `projects/<cwd, every character but
 * a letter or digit turned to ->/` in its config directory, subagents' in a
 * `subagents/` folder below. The sandbox's path is the same every run, so the folder
 * also holds earlier runs': only files written since this sandbox's brief count.
 */
import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { exampleRoot, sandboxPath } from "./cleanroom.mjs";
import { strayFinders } from "./strays.mjs";

const [arg, ...extra] = process.argv.slice(2);
if (!arg || extra.length > 0) {
  console.error(
    "usage: node scripts/cleanroom/audit-transcript.mjs <root>\n\n" +
      `e.g. node scripts/cleanroom/audit-transcript.mjs ${exampleRoot}`,
  );
  process.exit(2);
}
const root = sandboxPath(arg);
const cleanroom = join(root, "cleanroom");
const brief = join(cleanroom, "CLAUDE.md");
if (!existsSync(brief)) {
  console.error(
    `${brief} doesn't exist, so ${root} isn't a sandbox. Pass the root a build\n` +
      "script built, not the cleanroom inside it.",
  );
  process.exit(2);
}
const built = statSync(brief).mtimeMs;

const projects = join(
  process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"),
  "projects",
);
const key = cleanroom.replace(/[^A-Za-z0-9]/g, "-").toLowerCase();
// Case-blind: the drive letter is spelled as whatever opened the session.
const folders = existsSync(projects)
  ? readdirSync(projects).filter((name) => name.toLowerCase() === key)
  : [];
const transcripts = folders
  .flatMap((folder) =>
    readdirSync(join(projects, folder), { recursive: true, encoding: "utf8" })
      .filter((name) => name.endsWith(".jsonl"))
      .map((name) => join(projects, folder, name)),
  )
  .filter((file) => statSync(file).mtimeMs >= built);
if (transcripts.length === 0) {
  console.error(
    `No transcript of a session opened in ${cleanroom} since it was built\n` +
      `(looked in ${projects}). Run the session first, opened in that folder.`,
  );
  process.exit(2);
}

// The session's own scratchpad and saved tool output, both named for its session id, are
// its to use. An earlier run's sit beside them under the same folder and are strays.
// Measured: the scratchpad on Windows (`%TEMP%\claude\<folder>\<id>\scratchpad`). On Linux
// the shell sandbox sets TMPDIR to `/tmp/claude-<uid>` itself, so that whole folder is the
// session's; on a runner nothing else is in it, and at home the audit stops seeing any
// other Claude Code session of the same user there. The one macOS run measured used
// `/private/tmp/claude-501`, which isn't watched either way.
const sessions = transcripts.map(
  (file) =>
    relative(projects, file)
      .split(/[\\/]/)[1]
      ?.replace(/\.jsonl$/, "") ?? "",
);
const uid = process.getuid?.();
const own = [
  ...folders.flatMap((folder) =>
    sessions.flatMap((id) => [
      join(projects, folder, id),
      join(tmpdir(), "claude", folder, id),
    ]),
  ),
  ...(uid === undefined ? [] : [join(tmpdir(), `claude-${uid}`)]),
];
const fixtures = join(root, "fixtures");
const allowed = [
  cleanroom,
  ...(existsSync(fixtures) ? [fixtures] : []),
  ...own,
];

const { strayPath, strayCommand } = strayFinders(allowed, root);

const fields = {
  input: "input_tokens",
  "cache write": "cache_creation_input_tokens",
  "cache read": "cache_read_input_tokens",
  output: "output_tokens",
};
/** @type {Map<string, number[]>} totals in the order of `fields` */
const tokens = new Map();
const counted = new Set();
/** @type {Set<string>} more than one means the effort changed mid-run */
const efforts = new Set();
/** @type {{ id: string, matched: string, tool: string, input: string }[]} */
const moves = [];
/** @type {Map<string, string>} what each tool call returned, by its id */
const results = new Map();
for (const file of transcripts) {
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) {
      continue;
    }
    const record = JSON.parse(line);
    if (record.effort) {
      efforts.add(record.effort);
    }
    if (record.type === "user" && Array.isArray(record.message?.content)) {
      for (const block of record.message.content) {
        if (block.type === "tool_result") {
          results.set(block.tool_use_id, resultText(block.content));
        }
      }
    }
    if (record.type !== "assistant") {
      continue;
    }
    const { id, model, usage, content } = record.message;
    // One reply is written as several records, each carrying the whole reply's usage.
    if (usage && !counted.has(id)) {
      counted.add(id);
      const sum = tokens.get(model) ?? [0, 0, 0, 0];
      tokens.set(
        model,
        Object.values(fields).map((field, i) => sum[i] + (usage[field] ?? 0)),
      );
    }
    for (const block of Array.isArray(content) ? content : []) {
      if (block.type !== "tool_use") {
        continue;
      }
      const input = block.input ?? {};
      const base = record.cwd ?? cleanroom;
      const paths = [input.file_path, input.notebook_path, input.path]
        .concat(block.name === "Glob" ? [input.pattern] : [])
        .filter((path) => typeof path === "string")
        .map((path) => resolve(base, path));
      // What matched, so the line says why: the path, the part of the command, or the
      // web tool's own target.
      const why =
        paths.find(strayPath) ??
        (typeof input.command === "string"
          ? strayCommand(input.command)
          : undefined) ??
        (block.name === "WebFetch" || block.name === "WebSearch"
          ? String(input.url ?? input.query ?? block.name)
          : undefined);
      if (why !== undefined) {
        moves.push({
          id: block.id,
          matched: why,
          tool: block.name,
          input: JSON.stringify(input),
        });
      }
    }
  }
}
// Enough of each to judge it by, not the whole of a long listing or file.
const evidence = {
  allowed,
  moves: moves.map(({ id, ...move }) => ({
    ...move,
    input: clip(move.input, 3000),
    result: clip(results.get(id) ?? "(no result recorded)", 3000),
  })),
};
writeFileSync(
  join(cleanroom, "audit.json"),
  `${JSON.stringify(evidence, null, 2)}\n`,
);

const number = new Intl.NumberFormat("en");
console.log(
  `${transcripts.length} transcript(s) since ${new Date(built).toISOString()}, ` +
    `effort ${[...efforts].join(", ") || "not recorded"}`,
);
for (const [model, sum] of tokens) {
  const totals = Object.keys(fields).map(
    (label, i) => `${label} ${number.format(sum[i] ?? 0)}`,
  );
  console.log(`  ${model}: ${totals.join(", ")}`);
}
if (moves.length === 0) {
  console.log("Nothing outside the sandbox.");
} else {
  console.log(
    `${moves.length} move(s) for judge-audit.mjs to read:\n` +
      moves
        .map(
          (move) =>
            `  ${move.matched} | ${move.tool}: ${move.input.slice(0, 300)}`,
        )
        .join("\n"),
  );
}

/** A tool result's text: a string, or the text blocks of a list. @param {unknown} content */
function resultText(content) {
  if (typeof content === "string") {
    return content;
  }
  return Array.isArray(content)
    ? content
        .map((block) =>
          block?.type === "text" ? block.text : `(${block?.type})`,
        )
        .join("\n")
    : "";
}

/** @param {string} text @param {number} length */
function clip(text, length) {
  return text.length > length
    ? `${text.slice(0, length)}… (${text.length - length} more characters)`
    : text;
}
