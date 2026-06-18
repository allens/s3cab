// Bundles the ESM source into a single file (dist/s3cab.js) for SEA packaging
// (see CLAUDE.md "Build → native executable"). esbuild has no config file by
// design, so its options live here in the JS API rather than as a long CLI flag
// string in package.json — chiefly so the load-bearing `banner` can be explained.
//
// Bundle-only: no --target/--minify, so the output is the same modern syntax the
// source runs as. The result feeds `node --build-sea=sea/<target>.json`.

import { build } from "esbuild";

await build({
  entryPoints: ["src/s3cab.mjs"],
  bundle: true,
  outdir: "dist",
  platform: "node",
  format: "esm",

  // The AWS SDK's optional native addon — keep it out; the JS fallback is used.
  external: ["aws-crt"],

  // In ESM output esbuild rewrites every require() into a shim that *throws*
  // unless a real `require` is in scope, and bundled CJS deps keep genuine
  // require() calls (the AWS SDK's @smithy/credential-provider-imds does
  // require("node:http") eagerly, via auth.mjs's import of credential-providers).
  // Without this the SEA binary crashed on every invocation, even --help, with
  // `Dynamic require of "node:http" is not supported`. The banner puts a real
  // `require` in scope so the shim delegates to it.
  //
  // Base is process.execPath, NOT the usual import.meta.url: inside the SEA
  // binary import.meta.url isn't a resolvable file URL, whereas execPath is
  // always a valid absolute path — and every dynamic-require target here is a
  // Node built-in, which resolves regardless of the base.
  banner: {
    js: `import { createRequire } from "node:module"; const require = createRequire(process.execPath);`,
  },
});
