import js from "@eslint/js";
import eslintConfigPrettier from "eslint-config-prettier/flat";
import { defineConfig } from "eslint/config";
import globals from "globals";

export default defineConfig([
  // Generated build artifacts — not linted (esbuild bundle, coverage, etc.).
  { ignores: ["bin/", "build/", "coverage/", "dist/"] },
  {
    files: ["**/*.{js,mjs,cjs}"],
    plugins: { js },
    extends: ["js/recommended"],
    languageOptions: {
      globals: { ...globals.node, Temporal: "readonly" },
    },
  },
  eslintConfigPrettier,
]);
