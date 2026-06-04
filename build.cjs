#!/usr/bin/env node

// Bundle the ESM source into a single ESM file for SEA packaging.
// esbuild is used ONLY to bundle (resolve + inline imports) — not to
// transpile, down-level, or minify. No `target`/`minify` is set, so the
// output JS is the same syntax that runs from source today.
require("esbuild")
  .build({
    logLevel: "info",
    entryPoints: ["src/cli.mjs"],
    bundle: true,
    outfile: "dist/s3cab.js",
    platform: "node",
    format: "esm",
    banner: {
      js: "#!/usr/bin/env node",
    },
    external: ["aws-crt"],
  })
  .catch(() => process.exit(1));
