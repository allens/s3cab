// The examples in the user docs are what s3cab really accepts and prints.
//
// A doc example is a promise twice over: the command line has to run, and the
// output under it has to be what the reader will see. Neither is checked by
// anything else — a renamed flag leaves every guide that spells the old one
// quietly wrong, and a renderer change leaves every transcript stale.
// (proposals/docs-site.md, "Examples that can't drift".)
//
// Two checks, by what each can reach:
//
// - **Every command line**, in README.md, guide/ and the registry's own
//   `examples`, goes through the dispatcher's own `parseArgs` call: the command
//   exists, every flag exists and has its value, and the positionals fit. Not
//   whether a *required* positional is present — the registry can't say
//   "required unless --save" (`aws`), and a prose mention like `s3cab forget`
//   names a command rather than running it.
// - **Exact output** for the transcripts that are local and deterministic: the
//   real CLI, run against snapshots built to the page's own scenario. The cloud
//   transcripts (restore, verify, forget, …) need a bucket and wait for the
//   nightly job the proposal describes.
//
// Cross-cutting, with no module to sit beside, so it lives in test/ (ADR-0049).

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { mkdtempDisposable } from "node:fs/promises";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";
import { parseArgs } from "node:util";
import { commands } from "../src/commands.mjs";
import { writeSnapshot } from "./helpers/write-snapshot.mjs";

const PAGES = [
  "README.md",
  ...readdirSync("guide")
    .filter((file) => file.endsWith(".md"))
    .map((file) => join("guide", file)),
];

const FENCE = /^ *```([^\n]*)\n([\s\S]*?)^ *```/gm;
// A fence that holds commands: a `console` transcript (commands follow its
// `> ` prompt, everything else is output), or an untagged or shell block of
// bare commands. `text`, `json`, … hold output and data, never commands.
const SHELL = new Set(["", "sh", "bash", "powershell"]);

/**
 * Every `s3cab …` command line the docs show, with where it came from. Inline
 * code is marked: there a trailing flag can be a mention of the flag rather
 * than half an invocation (`s3cab upload --dir`).
 * @returns {{ where: string, line: string, inline: boolean }[]}
 */
function documentedCommands() {
  const found = [];
  for (const page of PAGES) {
    const text = readFileSync(page, "utf8");
    for (const [, lang = "", body = ""] of text.matchAll(FENCE)) {
      for (const raw of body.split("\n")) {
        const line = raw.trim();
        const command =
          lang.trim() === "console"
            ? /^> (s3cab\s.*)/.exec(line)?.[1]
            : SHELL.has(lang.trim()) && /^s3cab\s/.test(line)
              ? line
              : undefined;
        if (command) {
          found.push({ where: page, line: command, inline: false });
        }
      }
    }
    const prose = text.replace(FENCE, "");
    for (const [, , span = ""] of prose.matchAll(/(`+)(s3cab\s[\s\S]*?)\1/g)) {
      found.push({
        where: page,
        line: span.replace(/\s+/g, " "),
        inline: true,
      });
    }
  }
  for (const [name, { examples = [] }] of Object.entries(commands)) {
    for (const line of examples) {
      found.push({
        where: `the '${name}' --help examples`,
        line,
        inline: false,
      });
    }
  }
  return found;
}

/**
 * The words s3cab would receive: quotes honoured, and the shell's own syntax
 * dropped — a `#` comment, anything after a pipe or `||`/`&&`/`;`, and each
 * redirect with its target. A backslash is literal, since most of these lines
 * are Windows paths.
 * @param {string} line
 */
function argv(line) {
  const words = [...line.matchAll(/'([^']*)'|"([^"]*)"|(\S+)/g)].map(
    ([, single, double, bare]) => single ?? double ?? bare ?? "",
  );
  const end = words.findIndex(
    (word) => word.startsWith("#") || ["|", "||", "&&", ";"].includes(word),
  );
  const kept = end < 0 ? words : words.slice(0, end);
  return kept.filter(
    (word, i) =>
      !/^\d?>>?$|^<$/.test(word) && !/^\d?>>?$|^<$/.test(kept[i - 1] ?? ""),
  );
}

/**
 * Why a documented command line wouldn't run, or `undefined` if it would.
 * @param {string} line
 * @param {boolean} inline
 */
function problemWith(line, inline) {
  const [, name = "", ...args] = argv(line);
  // `s3cab <command> --help`, `s3cab --version`, `s3cab help exclude`: not a
  // command's invocation.
  if (!name || /^[<[-]/.test(name) || name === "help") {
    return undefined;
  }
  const command = commands[name];
  if (!command) {
    return `there is no '${name}' command`;
  }
  try {
    const { positionals } = parseArgs({
      args,
      options: { ...command.options, json: { type: "boolean" } },
      allowPositionals: true,
      allowNegative: true,
    });
    const declared = Object.values(command.args ?? {});
    const elided = args.some((arg) => arg === "…" || arg === "...");
    if (
      !elided &&
      !declared.some((arg) => arg.variadic) &&
      positionals.length > declared.length
    ) {
      return `'${name}' takes ${declared.length} argument(s), not ${positionals.length}`;
    }
  } catch (error) {
    const named =
      /** @type {{ code?: string }} */ (error).code ===
      "ERR_PARSE_ARGS_INVALID_OPTION_VALUE";
    if (!(inline && named)) {
      return /** @type {Error} */ (error).message.split("\n")[0];
    }
  }
  return undefined;
}

describe("documented command lines", () => {
  it("every one is a command s3cab accepts", () => {
    const broken = documentedCommands().flatMap(({ where, line, inline }) => {
      const problem = problemWith(line, inline);
      return problem ? [`${where}: ${line}\n      ${problem}`] : [];
    });

    assert.deepEqual(
      broken,
      [],
      `documented commands s3cab would reject:\n  ${broken.join("\n  ")}`,
    );
  });

  it("finds the command lines it is meant to be checking", () => {
    // Without this the check above passes just as well on an empty list.
    const lines = documentedCommands().map(({ line }) => line);
    assert.ok(lines.length > 150, `only ${lines.length} found`);
    assert.ok(lines.includes("s3cab compare photos --since 20251111T0830"));
    assert.ok(
      lines.some((line) => line.startsWith("s3cab restore --set photos")),
    );
  });

  it("catches a flag that doesn't exist, and nothing in a prose mention", () => {
    assert.match(
      problemWith("s3cab restore --set photos --overwite", false) ?? "",
      /--overwite/,
    );
    assert.match(problemWith("s3cab nonesuch", false) ?? "", /no 'nonesuch'/);
    assert.match(problemWith("s3cab prop a b", false) ?? "", /1 argument/);
    assert.equal(problemWith("s3cab upload --dir", true), undefined);
    assert.equal(
      problemWith("s3cab verify my-backups || alert", false),
      undefined,
    );
    assert.equal(
      problemWith("s3cab find secretsdir/ > hashes.txt", false),
      undefined,
    );
  });
});

/**
 * The output a page shows under `> command` in a `console` block: the lines up
 * to the next prompt or the end of the block.
 * @param {string} page
 * @param {string} command
 */
function transcript(page, command) {
  for (const [, lang, body = ""] of readFileSync(page, "utf8").matchAll(
    FENCE,
  )) {
    const lines = body.trimEnd().split("\n");
    const at = lines.indexOf(`> ${command}`);
    if (lang?.trim() === "console" && at >= 0) {
      const rest = lines.slice(at + 1);
      const next = rest.findIndex((line) => line.startsWith("> "));
      return (next < 0 ? rest : rest.slice(0, next)).join("\n");
    }
  }
  assert.fail(`${page} no longer shows '> ${command}'`);
}

/**
 * A `photos` set over `~/Pictures` in a temp home, with a snapshot per entry of
 * `snapshots` (name → files, paths relative to the set's directory), and a way
 * to run the CLI there. Paths are written as the snapshot would hold them, so
 * the report shortens them against the home exactly as on a real machine.
 * @param {string} root
 * @param {Record<string, File[]>} snapshots
 */
async function photosSet(root, snapshots) {
  // Absolute, as `setup` writes it: the snapshot rows are absolute paths.
  const home = resolve(root, "home");
  const pictures = join(home, "Pictures");
  const set = join(home, ".s3cab", "sets", "photos");
  mkdirSync(join(set, "snapshots"), { recursive: true });
  writeFileSync(join(set, "dirs.txt"), `${pictures}\n`);
  writeFileSync(join(set, "env"), "S3CAB_BUCKET=my-backups\n");
  for (const [name, files] of Object.entries(snapshots)) {
    await writeSnapshot(join(set, "snapshots"), name, files, pictures);
  }
  return {
    home,
    /** @param {...string} args */
    run: (...args) =>
      spawnSync(process.execPath, ["src/s3cab.mjs", ...args], {
        encoding: "utf8",
        env: { ...process.env, HOME: home, USERPROFILE: home },
      }),
  };
}

/**
 * A file of `size` bytes, its content fixed by `fill` — the same `fill` and
 * size is the same content, which is what makes a move or a duplicate.
 * @param {string} name
 * @param {string} fill
 * @param {number} size
 */
const file = (name, fill, size) =>
  new File([new Uint8Array(size).fill(fill.charCodeAt(0))], name, {
    lastModified: Date.UTC(2025, 9, 1),
  });

// The transcripts are POSIX ones (`~/Pictures`, `/home/me/…`); a Windows run
// would print the same report with `\`.
const posixOnly = {
  skip: process.platform === "win32" && "the page shows a POSIX transcript",
};

describe("documented output", () => {
  it("guide/compare.md shows what compare prints", posixOnly, async () => {
    await using dir = await mkdtempDisposable(join("test", ".tmp"));
    const command = "s3cab compare photos --since 20251111T0830";
    // The page's scenario: a photo filed into a subfolder, a note renamed, a
    // logo copied, a report edited, one new photo and one old note gone.
    const { run } = await photosSet(dir.path, {
      "20251111T0830": [
        file("2024/IMG_001.jpg", "i", 3_400_000),
        file("logo.png", "l", 41_000),
        file("notes.txt", "n", 2_100),
        file("old notes.txt", "o", 900),
        file("report.pdf", "r", 1_200_000),
      ],
      "20251112T0915": [
        file("2024/sorted/IMG_001.jpg", "i", 3_400_000),
        file("2025/new.jpg", "j", 4_000_000),
        file("brand-logo.png", "l", 41_000),
        file("diary.txt", "n", 2_100),
        file("logo.png", "l", 41_000),
        file("report.pdf", "R", 1_250_000),
      ],
    });

    const { status, stdout, stderr } = run(...argv(command).slice(1));

    assert.equal(status, 0, stderr);
    assert.equal(stdout.trimEnd(), transcript("guide/compare.md", command));
  });

  it(
    "guide/output.md's --json example is what compare --json prints",
    posixOnly,
    async () => {
      await using dir = await mkdtempDisposable(join("test", ".tmp"));
      const command = "s3cab compare photos --json";
      const { home, run } = await photosSet(dir.path, {
        "20251111T0830": [file("diary.txt", "d", 180)],
        "20251112T0915": [
          file("2025/new.jpg", "j", 812_043),
          file("diary.txt", "D", 240),
        ],
      });

      const { status, stdout, stderr } = run(...argv(command).slice(1));

      // The page lays the JSON out by hand to keep it short, so the comparison is
      // of the data, with the temp home spelled as the page's `/home/me`.
      assert.equal(status, 0, stderr);
      assert.deepEqual(
        JSON.parse(stdout.replaceAll(home, "/home/me")),
        JSON.parse(transcript("guide/output.md", command)),
      );
    },
  );
});
