import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
/** @import { SpawnSyncReturns } from "node:child_process" */

/**
 * Runs the audit on a sandbox whose one transcript holds `uses`, each answered by
 * `results[id]`, and hands `check` its output and the `audit.json` it wrote.
 * @param {(temp: string) => { id: string, name: string, input: object }[]} uses
 * @param {Record<string, string>} results
 * @param {(audit: SpawnSyncReturns<string>, evidence: any, root: string, temp: string) => void} check
 */
function audited(uses, results, check) {
  const base = realpathSync.native(mkdtempSync(join(tmpdir(), "s3cab-audit-")));
  try {
    const temp = join(base, "tmp");
    const config = join(base, "config");
    const root = join(base, "sandbox");
    const cleanroom = join(root, "cleanroom");
    mkdirSync(temp);
    mkdirSync(join(base, "home"));
    mkdirSync(cleanroom, { recursive: true });
    writeFileSync(join(cleanroom, "CLAUDE.md"), "brief");
    const folder = join(
      config,
      "projects",
      cleanroom.replace(/[^A-Za-z0-9]/g, "-").toLowerCase(),
    );
    mkdirSync(folder, { recursive: true });
    const records = [
      {
        type: "assistant",
        cwd: cleanroom,
        message: {
          id: "m",
          model: "m",
          content: uses(temp).map((use) => ({ type: "tool_use", ...use })),
        },
      },
      {
        type: "user",
        message: {
          content: Object.entries(results).map(([id, text]) => ({
            type: "tool_result",
            tool_use_id: id,
            content: [{ type: "text", text }],
          })),
        },
      },
    ];
    writeFileSync(
      join(folder, "s.jsonl"),
      records.map((record) => `${JSON.stringify(record)}\n`).join(""),
    );
    const audit = spawnSync(
      process.execPath,
      [join(import.meta.dirname, "audit-transcript.mjs"), root],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          HOME: join(base, "home"),
          TMPDIR: temp,
          CLAUDE_CONFIG_DIR: config,
        },
      },
    );
    const evidence = JSON.parse(
      readFileSync(join(cleanroom, "audit.json"), "utf8"),
    );
    check(audit, evidence, root, temp);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

test(
  "off Windows, the session's whole claude-<uid> temp folder is its own",
  { skip: process.getuid === undefined },
  () => {
    /** @param {string} temp */
    const own = (temp) => join(temp, `claude-${process.getuid?.()}`, "lat");
    /** @param {string} temp */
    const elsewhere = (temp) => join(temp, "elsewhere", "x");
    audited(
      (temp) => [
        { id: "own", name: "Read", input: { file_path: join(own(temp), "x") } },
        {
          id: "own-bash",
          name: "Bash",
          input: { command: `ls ${join(own(temp), "outside")}` },
        },
        {
          id: "elsewhere",
          name: "Read",
          input: { file_path: elsewhere(temp) },
        },
      ],
      { elsewhere: "what the file held" },
      (audit, evidence, root, temp) => {
        const path = elsewhere(temp);
        assert.equal(audit.status, 0, audit.stderr);
        assert.match(
          audit.stdout,
          /^1 move\(s\) for judge-audit\.mjs to read/m,
        );
        assert.ok(audit.stdout.includes(`\n  ${path} | Read`), audit.stdout);
        assert.equal(evidence.root, root);
        assert.deepEqual(evidence.moves, [
          {
            matched: path,
            tool: "Read",
            input: JSON.stringify({ file_path: path }),
            result: "what the file held",
          },
        ]);
      },
    );
  },
);

test(
  "a long command keeps its end, where what it printed comes from",
  { skip: process.getuid === undefined },
  () => {
    const notes = "x".repeat(5000);
    audited(
      (temp) => [
        {
          id: "long",
          name: "Bash",
          input: {
            command: `cat >> ${join(temp, "elsewhere", "notes")} <<'EOF'\n${notes}\nEOF\ntail exits.txt`,
          },
        },
      ],
      { long: "exit=0" },
      (audit, evidence) => {
        assert.equal(audit.status, 0, audit.stderr);
        const input = evidence.moves[0]?.input ?? "";
        assert.ok(input.length < notes.length, `${input.length} characters`);
        assert.match(input, /^\{"command":"cat >> /);
        assert.match(input, /\\nEOF\\ntail exits\.txt"\}$/);
      },
    );
  },
);
