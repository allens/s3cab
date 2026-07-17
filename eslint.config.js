import js from "@eslint/js";
import eslintConfigPrettier from "eslint-config-prettier/flat";
import { defineConfig } from "eslint/config";
import globals from "globals";

/** @import { Rule } from "eslint" */

// Enforces ADR-0023 / the one-export-per-command coding convention: a
// `src/commands/` file exports exactly one symbol, its command function. An
// extra export is a `lib/` primitive that hasn't moved yet — see CLAUDE.md.
/** @type {Rule.RuleModule} */
const oneExportPerCommand = {
  meta: {
    type: "problem",
    docs: {
      description:
        "a src/commands file exports exactly one symbol (its command function)",
    },
    schema: [],
    messages: {
      tooMany:
        "A command module must export exactly one symbol (its command function); found {{count}}. An extra export belongs in lib/ (ADR-0023).",
      none: "A command module must export exactly one symbol (its command function); found none.",
    },
  },
  create(context) {
    let count = 0;
    /** @type {Rule.Node | null} */
    let lastNode = null;
    const add = (/** @type {number} */ n, /** @type {any} */ node) => {
      count += n;
      lastNode = node;
    };
    return {
      ExportNamedDeclaration(node) {
        // `export function/const/class …` declares names; `export { a, b }`
        // lists specifiers. Count the exported bindings either way.
        if (node.declaration) {
          const decl = node.declaration;
          const n =
            decl.type === "VariableDeclaration" ? decl.declarations.length : 1;
          add(n, node);
        } else {
          add(node.specifiers.length, node);
        }
      },
      ExportDefaultDeclaration(node) {
        add(1, node);
      },
      ExportAllDeclaration(node) {
        add(1, node);
      },
      "Program:exit"(program) {
        if (count !== 1) {
          context.report({
            node: lastNode ?? program,
            messageId: count === 0 ? "none" : "tooMany",
            data: { count: String(count) },
          });
        }
      },
    };
  },
};

// Enforces the JSDoc @import coding convention (CLAUDE.md): an imported type is
// declared once with a `/** @import { T } from "mod" */` tag and referenced bare
// — never written inline in an annotation. Only block comments are scanned, so a
// dynamic `await import()` (which lives in code, never a comment) is untouched;
// the required member access after the call is what marks the type-position use,
// and a preceding `typeof` is exempt because that form references a value's type,
// which an @import tag cannot express.
/** @type {Rule.RuleModule} */
const noInlineImportType = {
  meta: {
    type: "suggestion",
    docs: {
      description:
        "imported types use a JSDoc @import tag, not an inline import() in the annotation",
    },
    schema: [],
    messages: {
      inline:
        'Declare {{name}} with a top-of-file `@import { {{name}} } from "{{mod}}"` tag and reference it bare, not inline (CLAUDE.md coding conventions).',
    },
  },
  create(context) {
    const { sourceCode } = context;
    const re = /(typeof\s+)?import\(\s*["']([^"']+)["']\s*\)\.(\w+)/g;
    return {
      "Program:exit"() {
        for (const comment of sourceCode.getAllComments()) {
          if (comment.type !== "Block" || !comment.range) {
            continue;
          }
          re.lastIndex = 0;
          let m;
          while ((m = re.exec(comment.value)) !== null) {
            if (m[1]) {
              continue; // `typeof import(...)` references a value's type — allowed
            }
            // comment.value omits the opening `/*`, so offset by 2 into the source.
            const base = comment.range[0] + 2 + m.index;
            context.report({
              loc: {
                start: sourceCode.getLocFromIndex(base),
                end: sourceCode.getLocFromIndex(base + m[0].length),
              },
              messageId: "inline",
              data: { name: m[3], mod: m[2] },
            });
          }
        }
      },
    };
  },
};

// The repo's local rules, in one plugin so any config block below can enable
// whichever it needs.
const local = {
  rules: {
    "one-export-per-command": oneExportPerCommand,
    "no-inline-import-type": noInlineImportType,
  },
};

export default defineConfig([
  // Not linted: generated build artifacts (esbuild bundle, coverage, dist) and
  // nested Claude Code worktrees (.claude/worktrees/ — see CLAUDE.md's worktree convention).
  { ignores: ["build/", "coverage/", "dist/", ".claude/worktrees/"] },
  {
    files: ["**/*.{js,mjs,cjs}"],
    plugins: { js, local },
    extends: ["js/recommended"],
    languageOptions: {
      globals: { ...globals.node, Temporal: "readonly" },
    },
    // Tree-wide: every imported type travels by an @import tag, never inline.
    rules: { "local/no-inline-import-type": "error" },
  },
  {
    files: ["src/commands/*.mjs"],
    ignores: ["src/commands/*.test.mjs"],
    plugins: { local },
    rules: { "local/one-export-per-command": "error" },
  },
  eslintConfigPrettier,
  // House rule: every control block is braced — no braceless `if`/`else` (or
  // `for`/`while`), even single-line. `curly` enforces it (auto-fixable) and
  // doesn't conflict with Prettier — Prettier only formats braces, it never
  // adds or removes them. Placed *after* eslint-config-prettier, which disables
  // `curly` by default; in flat config the later block wins, so this re-asserts it.
  { rules: { curly: ["error", "all"] } },
]);
