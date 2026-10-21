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

test(
  "off Windows, the session's whole claude-<uid> temp folder is its own",
  { skip: process.getuid === undefined },
  () => {
    const base = realpathSync.native(
      mkdtempSync(join(tmpdir(), "s3cab-audit-")),
    );
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
      const own = join(temp, `claude-${process.getuid?.()}`, "lat");
      const elsewhere = join(temp, "elsewhere", "x");
      const uses = [
        { id: "own", name: "Read", input: { file_path: join(own, "x") } },
        {
          id: "own-bash",
          name: "Bash",
          input: { command: `ls ${join(own, "outside")}` },
        },
        { id: "elsewhere", name: "Read", input: { file_path: elsewhere } },
      ];
      const records = [
        {
          type: "assistant",
          cwd: cleanroom,
          message: {
            id: "m",
            model: "m",
            content: uses.map((use) => ({ type: "tool_use", ...use })),
          },
        },
        {
          type: "user",
          message: {
            content: [
              {
                type: "tool_result",
                tool_use_id: "elsewhere",
                content: [{ type: "text", text: "what the file held" }],
              },
            ],
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
      assert.equal(audit.status, 0, audit.stderr);
      assert.match(audit.stdout, /^1 move\(s\) for judge-audit\.mjs to read/m);
      assert.ok(audit.stdout.includes(`\n  ${elsewhere} | Read`), audit.stdout);
      const evidence = JSON.parse(
        readFileSync(join(cleanroom, "audit.json"), "utf8"),
      );
      assert.equal(evidence.root, root);
      assert.deepEqual(evidence.moves, [
        {
          matched: elsewhere,
          tool: "Read",
          input: JSON.stringify({ file_path: elsewhere }),
          result: "what the file held",
        },
      ]);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  },
);
