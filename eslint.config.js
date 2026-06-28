import js from "@eslint/js";
import eslintConfigPrettier from "eslint-config-prettier/flat";
import { defineConfig } from "eslint/config";
import globals from "globals";

// Enforces ADR-0023 / the one-export-per-command coding convention: a
// `src/commands/` file exports exactly one symbol, its command function. An
// extra export is a `lib/` primitive that hasn't moved yet — see CLAUDE.md.
/** @type {import("eslint").Rule.RuleModule} */
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
    /** @type {import("eslint").Rule.Node | null} */
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

export default defineConfig([
  // Not linted: generated build artifacts (esbuild bundle, coverage, dist) and
  // nested Claude Code worktrees (.claude/worktrees/ — see CLAUDE.md's worktree convention).
  { ignores: ["build/", "coverage/", "dist/", ".claude/worktrees/"] },
  {
    files: ["**/*.{js,mjs,cjs}"],
    plugins: { js },
    extends: ["js/recommended"],
    languageOptions: {
      globals: { ...globals.node, Temporal: "readonly" },
    },
  },
  {
    files: ["src/commands/*.mjs"],
    ignores: ["src/commands/*.test.mjs"],
    plugins: {
      local: { rules: { "one-export-per-command": oneExportPerCommand } },
    },
    rules: { "local/one-export-per-command": "error" },
  },
  eslintConfigPrettier,
]);
