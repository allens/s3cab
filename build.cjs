#!/usr/bin/env node

// Bundle the ESM source into a single ESM file for SEA packaging.
// esbuild is used ONLY to bundle (resolve + inline imports) — not to
// transpile, down-level, or minify. No `target`/`minify` is set, so the
// output JS is the same syntax that runs from source today.
//
// The `#!/usr/bin/env node` shebang is NOT injected here: it lives in the
// entry source (src/cli.mjs, so the file also works as an npm `bin`), and
// esbuild preserves an entry point's shebang into the bundle. Adding a banner
// too would duplicate it (a second `#!` line is a syntax error).
require("esbuild")
  .build({
    logLevel: "info",
    entryPoints: ["src/cli.mjs"],
    bundle: true,
    outfile: "dist/s3cab.js",
    platform: "node",
    format: "esm",
    external: ["aws-crt"],
  })
  .catch(() => process.exit(1));
