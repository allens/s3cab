/**
 * Stage-1 queries for the `/over-engineering` sweep — the executable half of the
 * skill in [SKILL.md](./SKILL.md), which sits beside this file.
 *
 * These produce **candidates, not verdicts** — a single-caller module can be
 * deliberate placement, and a dead export can be a genuine seam. Nothing here is
 * reportable until stage 2 has read the hit in context.
 *
 * Usage:
 *   node .claude/skills/over-engineering/sweep.mjs size      # code vs comment lines, so you know what you are reading
 *   node .claude/skills/over-engineering/sweep.mjs fan-in    # production importers per module, ascending
 *   node .claude/skills/over-engineering/sweep.mjs exports   # exports with no production consumer, with sort keys
 *   node .claude/skills/over-engineering/sweep.mjs docs      # names in the live docs that the code no longer defines
 *
 * Lived inside SKILL.md as inline `node -e` one-liners until they were extracted:
 * embedding JS in a shell string inside Markdown cost a regex-escaping trap
 * (`"\\b"` does not survive into `new RegExp`) and made every edit a hand-edit of
 * minified code. As a real file it is linted, formatted and type-checked.
 *
 * It sits **in the skill's own folder**, not in `scripts/`, because a vendored
 * skill should be self-contained — the Agent Skills layout is `SKILL.md` plus its
 * supporting files, and nothing outside the sweep runs this. `scripts/` remains
 * what CLAUDE.md says it is: standalone dev utilities, run by hand, that answer to
 * no skill.
 *
 * That placement costs one line of config to keep honest. `tsc`'s default
 * traversal skips dot-directories, so `jsconfig.json` names the `.claude/skills`
 * tree in its `include` — without that this file would still be linted and
 * formatted but silently **not** type-checked, losing a third of what extracting
 * it bought. (Spelling the glob out here would end this comment early: it contains
 * the `*` and `/` pair that closes a block comment.)
 *
 * The counting semantics are unchanged — see the skill for how to read each table.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, normalize, sep } from "node:path";

/** @import { Dirent } from "node:fs" */

/**
 * A directory's entries, name-sorted. `readdirSync` order is filesystem-dependent,
 * which would make every mode's output differ between machines — `exports` and
 * `fan-in` iterate in walk order, and `docs` lists the files each name appears in.
 * Sorting once here makes all of them reproducible and diff-friendly.
 * @param {string} dir
 * @returns {Dirent[]}
 */
function sortedEntries(dir) {
  return readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  );
}

/**
 * Every `.mjs` file under `dir`, recursively. A *missing* directory yields nothing,
 * so a caller may name one that does not exist in every checkout — but any other
 * read failure (permissions, too many open files) propagates. A sweep that silently
 * skipped an unreadable directory would under-report, and stage 1's whole job is to
 * be exhaustive.
 *
 * @param {string} dir - Directory to walk
 * @param {boolean} [includeTests] - Include `*.test.mjs` (default: exclude)
 * @returns {string[]} Normalized file paths
 */
function walk(dir, includeTests = false) {
  /** @type {string[]} */
  const found = [];
  if (!existsSync(dir)) {
    return found;
  }
  for (const entry of sortedEntries(dir)) {
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

/**
 * Every Markdown file that makes a **live** claim about how the code behaves.
 *
 * `docs/adr/` is deliberately absent, and that is the whole design of this mode: an
 * ADR body records what was decided *then*, so a name it mentions going stale is
 * correct history, not a defect — rewriting one to match today's code destroys the
 * record that stops a reversed decision being re-proposed
 * ([docs/adr/README.md](../docs/adr/README.md)). `proposals/` is out for the same
 * reason: it is provisional by definition.
 */
const LIVE_DOCS = [
  "docs/design",
  "guide",
  "README.md",
  "CONTEXT.md",
  "docs/integration-testing.md",
  "docs/releasing.md",
];

/**
 * Backticked identifiers and `.mjs` paths in the live docs that name nothing in
 * `src/`, `scripts/`, `test/` or `package.json`.
 *
 * The failure mode this catches is **renames**: prose stays true while the symbol it
 * names quietly moves, and nothing notices because neither `tsc` nor eslint reads a
 * Markdown file. Every defect the 2026-08 doc sweep found was that shape, as was the
 * `loadEnv` trail a review caught in #263.
 *
 * Candidates, not verdicts — same rule as every other mode. Expect false positives
 * from names this repo doesn't define: AWS APIs, CI secrets, shell tools, and things
 * a doc mentions precisely to say it **rejected** them (`S3CAB_ENDPOINT`, `--grace`).
 * Read each hit in context; a mention already marked rejected or historical is
 * correct as written.
 */
function docs() {
  // `.claude/skills` is in the corpus because it now holds code — this file. A
  // doc naming something only a skill's script defines should read as defined,
  // not as rot, for the same reason `jsconfig.json` had to name that tree.
  const code = [
    ...walk("src", true),
    ...walk("scripts", true),
    ...walk("test", true),
    ...walk(".claude/skills", true),
  ];
  const defined = new Set(
    (
      code.map((f) => readFileSync(f, "utf8")).join("\n") +
      readFileSync("package.json", "utf8")
    ).match(/[A-Za-z0-9_$]+/g) ?? [],
  );
  const paths = new Set(code.map((f) => f.split(sep).join("/")));

  /** @type {Map<string, Set<string>>} */
  const hits = new Map();
  const record = (/** @type {string} */ k, /** @type {string} */ doc) => {
    if (!hits.has(k)) {
      hits.set(k, new Set());
    }
    hits.get(k)?.add(doc);
  };

  const markdown = LIVE_DOCS.flatMap((entry) =>
    entry.endsWith(".md")
      ? existsSync(entry)
        ? [entry]
        : []
      : walkMarkdown(entry),
  );

  for (const doc of markdown) {
    const shown = doc.split(sep).join("/");
    for (const [, raw] of readFileSync(doc, "utf8").matchAll(/`([^`\n]+)`/g)) {
      const text = raw?.trim();
      if (!text) {
        continue;
      }
      // A bare identifier, or `ident()` — the shapes that name code. Short names
      // are skipped: they collide with ordinary prose more often than they help.
      const identifier = /^([A-Za-z_$][A-Za-z0-9_$]*)(\(\))?$/.exec(text);
      if (
        identifier?.[1] &&
        identifier[1].length > 3 &&
        !defined.has(identifier[1])
      ) {
        record(identifier[1], shown);
      }
      if (text.endsWith(".mjs")) {
        const wanted = text.replace(/^\.\//, "");
        // Iterate the Set directly and stop at the first match — `[...paths]`
        // rebuilt an array on every hit, and `.some()` over it dropped the
        // short-circuit's value by paying for the copy first.
        let known = paths.has(wanted);
        if (!known) {
          for (const file of paths) {
            if (file.endsWith("/" + wanted)) {
              known = true;
              break;
            }
          }
        }
        if (!known) {
          record(text, shown);
        }
      }
    }
  }

  // Sort by key explicitly. A bare `.sort()` on `[key, Set]` pairs stringifies
  // each to `"name,[object Set]"` — it happens to order by name because the
  // suffix is constant, which is accident rather than intent.
  const sorted = [...hits].sort(([a], [b]) => a.localeCompare(b));
  for (const [name, where] of sorted) {
    console.log(name.padEnd(32), [...where].sort().join(", "));
  }
  console.log(`\n${hits.size} candidates across ${markdown.length} live docs`);
}

/**
 * Every `.md` file under `dir`, recursively — the Markdown twin of {@link walk}.
 * Entries are sorted by name, so a sweep's output is the same on every machine
 * and two runs diff cleanly; `readdirSync` order is filesystem-dependent.
 * @param {string} dir
 * @returns {string[]}
 */
function walkMarkdown(dir) {
  /** @type {string[]} */
  const found = [];
  if (!existsSync(dir)) {
    return found;
  }
  for (const entry of sortedEntries(dir)) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...walkMarkdown(full));
    } else if (entry.name.endsWith(".md")) {
      found.push(normalize(full));
    }
  }
  return found;
}

const modes = { size, "fan-in": fanIn, exports, docs };
const mode = process.argv[2];
const run = Object.hasOwn(modes, mode ?? "")
  ? modes[/** @type {keyof typeof modes} */ (mode)]
  : undefined;
if (!run) {
  console.error(
    `Usage: node .claude/skills/over-engineering/sweep.mjs <${Object.keys(modes).join("|")}>`,
  );
  process.exit(2);
}
run();
