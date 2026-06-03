#!/usr/bin/env node

require("esbuild")
  .build({
    logLevel: "info",
    entryPoints: ["src/cli.mjs"],
    bundle: true,
    outfile: "bin/s3cab.cjs",
    platform: "node",
    target: "es2020",
    banner: {
      js: "#!/usr/bin/env node",
    },
    external: ["aws-crt"],
  })
  .catch(() => process.exit(1));
