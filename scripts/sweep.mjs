/**
 * Stage-1 queries for the `/over-engineering` sweep
 * ([.claude/skills/over-engineering/](../.claude/skills/over-engineering/)).
 *
 * These produce **candidates, not verdicts** — a single-caller module can be
 * deliberate placement, and a dead export can be a genuine seam. Nothing here is
 * reportable until stage 2 has read the hit in context.
 *
 * Usage:
 *   node scripts/sweep.mjs size      # code vs comment lines, so you know what you are reading
 *   node scripts/sweep.mjs fan-in    # production importers per module, ascending
 *   node scripts/sweep.mjs exports   # exports with no production consumer, with sort keys
 *
 * Lived in the skill as inline `node -e` one-liners until they were extracted here:
 * embedding JS in a shell string inside Markdown cost a regex-escaping trap
 * (`"\\b"` does not survive into `new RegExp`) and made every edit a hand-edit of
 * minified code. As files they are linted, formatted and type-checked like the rest
 * of `scripts/`. The counting semantics are unchanged — see the skill for how to
 * read each table.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";

/** @import { Dirent } from "node:fs" */

/**
 * Every `.mjs` file under `dir`, recursively. Missing directories yield nothing, so
 * a caller may name one that does not exist in every checkout.
 *
 * @param {string} dir - Directory to walk
 * @param {boolean} [includeTests] - Include `*.test.mjs` (default: exclude)
 * @returns {string[]} Normalized file paths
 */
function walk(dir, includeTests = false) {
  /** @type {string[]} */
  const found = [];
  /** @type {Dirent[]} */
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...walk(path, includeTests));
    } else if (entry.name.endsWith(".mjs")) {
      if (includeTests || !entry.name.endsWith(".test.mjs")) {
        found.push(path);
      }
    }
  }
  return found;
}

/** Split a source file into code and comment line counts (blank lines count as neither).
 *
 * @param {string} source - File contents
 * @returns {{ code: number, comment: number }}
 */
function countLines(source) {
  let code = 0;
  let comment = 0;
  let inBlock = false;
  for (const line of source.split(/\r?\n/)) {
    const text = line.trim();
    if (inBlock) {
      comment++;
      if (text.includes("*/")) {
        inBlock = false;
      }
    } else if (text === "") {
      // blank
    } else if (text.startsWith("/*")) {
      comment++;
      if (!text.includes("*/")) {
        inBlock = true;
      }
    } else if (text.startsWith("//")) {
      comment++;
    } else {
      code++;
    }
  }
  return { code, comment };
}

/** Size the pass: the 15 largest production modules by code lines, plus the total. */
function size() {
  const rows = walk("src").map((file) => ({
    file,
    ...countLines(readFileSync(file, "utf8")),
  }));
  rows.sort((a, b) => b.code - a.code);
  for (const { file, code, comment } of rows.slice(0, 15)) {
    console.log(
      file.padEnd(34),
      String(code).padStart(4),
      String(comment).padStart(4),
    );
  }
  const total = rows.reduce(
    (acc, r) => ({ code: acc.code + r.code, comment: acc.comment + r.comment }),
    { code: 0, comment: 0 },
  );
  console.log("TOTAL code", total.code, "comment", total.comment);
}

/**
 * Production fan-in, ascending. High fan-in is evidence a module is *earned*; the
 * interesting end is the tail. Importers are counted from `src/` **and `scripts/`**,
 * so a module existing only for a dev utility shows its real caller rather than
 * reading as an orphan. Ignore `commands/*.mjs` sitting at 1 — the registry imports
 * each exactly once, which is structural, not signal.
 */
function fanIn() {
  const modules = walk("src");
  /** @type {Map<string, Set<string>>} */
  const importers = new Map();
  for (const file of [...modules, ...walk("scripts")]) {
    const source = readFileSync(file, "utf8");
    const pattern =
      /(?:^|\n)\s*(?:import[\s\S]*?from|export[\s\S]*?from)\s*["'](\.[^"']+)["']/g;
    for (const [, specifier] of source.matchAll(pattern)) {
      if (!specifier) {
        continue;
      }
      const target = normalize(join(dirname(file), specifier));
      if (!importers.has(target)) {
        importers.set(target, new Set());
      }
      importers.get(target)?.add(file);
    }
  }
  modules
    .map((file) => ({ file, count: importers.get(file)?.size ?? 0 }))
    .sort((a, b) => a.count - b.count)
    .forEach(({ file, count }) => console.log(String(count).padStart(3), file));
}

/** Every name a module exports, whether by declaration or by an `export { … }` list.
 *
 * @param {string} source - File contents
 * @returns {Set<string>}
 */
function exportedNames(source) {
  /** @type {Set<string>} */
  const names = new Set();
  const declared =
    /^export\s+(?:async\s+)?(?:function|const|class|let)\s+([A-Za-z0-9_$]+)/gm;
  for (const [, name] of source.matchAll(declared)) {
    if (name) {
      names.add(name);
    }
  }
  for (const [, list] of source.matchAll(/^export\s*\{([^}]+)\}/gm)) {
    if (!list) {
      continue;
    }
    for (const part of list.split(",")) {
      const name = part
        .trim()
        .split(/\s+as\s+/)
        .pop()
        ?.trim();
      if (name) {
        names.add(name);
      }
    }
  }
  return names;
}

/**
 * Exports with zero production consumers, with the three numbers that sort them.
 * All three are **token mentions, not resolved references** — treat as triage.
 * `scripts:>0` means the export is earned, not surplus.
 */
function exports() {
  const all = [
    ...walk("src", true),
    ...walk("test", true),
    ...walk("scripts", true),
  ];
  const production = new Set(
    all.filter((f) => f.startsWith("src") && !f.endsWith(".test.mjs")),
  );
  const scripts = new Set(all.filter((f) => f.startsWith("scripts")));
  /** @type {Map<string, string[]>} */
  const tokens = new Map(
    all.map((f) => [f, readFileSync(f, "utf8").match(/[A-Za-z0-9_$]+/g) ?? []]),
  );
  /** @type {Map<string, Set<string>>} */
  const mentions = new Map(all.map((f) => [f, new Set(tokens.get(f) ?? [])]));

  for (const file of production) {
    for (const name of exportedNames(readFileSync(file, "utf8"))) {
      const usedInProduction = [...production].some(
        (other) => other !== file && mentions.get(other)?.has(name),
      );
      if (usedInProduction) {
        continue;
      }
      const inTests = all.filter(
        (f) =>
          !production.has(f) && !scripts.has(f) && mentions.get(f)?.has(name),
      ).length;
      const inScripts = all.filter(
        (f) => scripts.has(f) && mentions.get(f)?.has(name),
      ).length;
      const self =
        (tokens.get(file) ?? []).filter((t) => t === name).length - 1;
      console.log(
        file.padEnd(30),
        "->",
        name.padEnd(22),
        `self:${self}`.padEnd(8),
        `tests:${inTests}`.padEnd(9),
        `scripts:${inScripts}`,
      );
    }
  }
}

const modes = { size, "fan-in": fanIn, exports };
const mode = process.argv[2];
const run = Object.hasOwn(modes, mode ?? "")
  ? modes[/** @type {keyof typeof modes} */ (mode)]
  : undefined;
if (!run) {
  console.error(
    `Usage: node scripts/sweep.mjs <${Object.keys(modes).join("|")}>`,
  );
  process.exit(2);
}
run();
