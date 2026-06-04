// Cross-build SEA executables for other platforms from this host.
//
// How it works: Node's `--build-sea` injects the SEA blob into the binary named
// by the config's `executable` field — and the injector understands ELF / Mach-O
// / PE, so a Windows (or any) host can write a Linux or macOS executable. The one
// hard rule is that the target node binary must be the EXACT same version as the
// node running `--build-sea`; we read that version from `process.version` and
// pull the matching build from nodejs.org/dist, so it always lines up. For
// cross-platform output, `useCodeCache`/`useSnapshot` must be false (they bake in
// platform-specific data) — they default false, and `mainFormat: "module"` forbids
// snapshots anyway, so we're naturally compliant.
//
// Usage:  node scripts/build-sea-cross.mjs [target ...]
//   targets default to DEFAULT_TARGETS below; pass names to override, e.g.
//   `node scripts/build-sea-cross.mjs linux-x64 darwin-arm64`.
// Requires `dist/s3cab.js` (run `npm run build` first; `npm run build:cross` chains it).

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const VERSION = process.version; // e.g. "v26.3.0" — host node; target binaries must match.
// Host platform as a target key (e.g. "linux-arm64"). Building this target uses the
// running node directly — no download, and the version always matches by construction.
// This is what lets CI run the same script natively on each platform's runner.
const HOST_TARGET = `${process.platform === "win32" ? "win" : process.platform}-${process.arch}`;
const DIST = "https://nodejs.org/dist";
const BUNDLE = "dist/s3cab.js";
const CACHE = "build/sea-node"; // downloaded + extracted node binaries (gitignored)

// All known targets. `bin` is node's path inside the extracted archive; `out` the
// final executable under dist/. `mac: true` marks targets that need codesigning.
const TARGETS = {
  "linux-x64": { archive: "tar.gz", bin: "bin/node", out: "s3cab-linux-x64" },
  "linux-arm64": { archive: "tar.gz", bin: "bin/node", out: "s3cab-linux-arm64" },
  "darwin-arm64": { archive: "tar.gz", bin: "bin/node", out: "s3cab-darwin-arm64", mac: true },
  "darwin-x64": { archive: "tar.gz", bin: "bin/node", out: "s3cab-darwin-x64", mac: true },
  "win-x64": { archive: "zip", bin: "node.exe", out: "s3cab-win-x64.exe" },
};

const DEFAULT_TARGETS = ["linux-x64", "linux-arm64", "darwin-arm64"];

/** Download `url` to `dest` with curl (resumes are not attempted; overwrites). */
function download(url, dest) {
  execFileSync("curl", ["-fSL", url, "-o", dest], { stdio: ["ignore", "ignore", "inherit"] });
}

/** SHA-256 of a file, lowercase hex. */
function sha256(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

/**
 * Ensure node `VERSION` for `target` is downloaded, checksum-verified, and extracted.
 * Returns the absolute-ish path to the target's node binary.
 */
function fetchNode(target) {
  if (target === HOST_TARGET) return process.execPath; // native build — use this node.

  const { archive, bin } = TARGETS[target];
  const base = `node-${VERSION}-${target}`;
  const file = `${base}.${archive}`;
  const archivePath = join(CACHE, file);
  const extractDir = join(CACHE, base);
  const nodeBin = join(extractDir, bin);

  if (existsSync(nodeBin)) return nodeBin; // already prepared

  if (!existsSync(archivePath)) {
    console.log(`  ↓ ${file}`);
    download(`${DIST}/${VERSION}/${file}`, archivePath);
  }

  // Verify against the official SHASUMS256.txt for this version.
  const sumsPath = join(CACHE, `SHASUMS256-${VERSION}.txt`);
  if (!existsSync(sumsPath)) download(`${DIST}/${VERSION}/SHASUMS256.txt`, sumsPath);
  const want = readFileSync(sumsPath, "utf8")
    .split("\n")
    .map((l) => l.trim().split(/\s+/)) // "<sha>  <filename>"
    .find(([, name]) => name === file)?.[0];
  if (!want) throw new Error(`${file} not listed in SHASUMS256.txt`);
  const got = sha256(archivePath);
  if (got !== want) throw new Error(`checksum mismatch for ${file}:\n  want ${want}\n  got  ${got}`);

  // bsdtar (Windows `tar.exe`) auto-detects gzip and zip.
  execFileSync("tar", ["-xf", archivePath, "-C", CACHE], { stdio: "inherit" });
  if (!existsSync(nodeBin)) throw new Error(`node binary not found after extract: ${nodeBin}`);
  return nodeBin;
}

/** Build one target: write a per-target SEA config and invoke `--build-sea`. */
function build(target) {
  const t = TARGETS[target];
  if (!t) throw new Error(`unknown target "${target}" (known: ${Object.keys(TARGETS).join(", ")})`);

  console.log(`\n▶ ${target}`);
  const executable = fetchNode(target);
  if (executable === process.execPath) console.log(`  • native build (host node ${VERSION})`);
  const output = join("dist", t.out);
  const configPath = join("build", `sea-${target}.json`);
  writeFileSync(
    configPath,
    JSON.stringify(
      {
        main: BUNDLE,
        mainFormat: "module",
        executable,
        output,
        // Required false for cross-platform: these embed host-specific data.
        useCodeCache: false,
        useSnapshot: false,
        disableExperimentalSEAWarning: true,
      },
      null,
      2,
    ),
  );

  // Inject using the HOST node (same version as `executable`).
  execFileSync(process.execPath, [`--build-sea=${configPath}`], { stdio: "inherit" });

  const mb = (statSync(output).size / 1e6).toFixed(0);
  console.log(`  ✓ ${output} (${mb} MB)`);
  if (t.mac) {
    console.log(
      `  ⚠ UNSIGNED macOS binary. macOS — especially Apple Silicon — will refuse to\n` +
        `    launch it until it is codesigned. Sign on a Mac ('codesign --sign - ${output}')\n` +
        `    or ad-hoc sign from here with rcodesign before distributing.`,
    );
  }
}

// ---- main ----
if (!existsSync(BUNDLE)) {
  console.error(`Missing ${BUNDLE}. Run \`npm run build\` first (or use \`npm run build:cross\`).`);
  process.exit(1);
}
mkdirSync(CACHE, { recursive: true });

const targets = process.argv.slice(2);
const selected = targets.length ? targets : DEFAULT_TARGETS;
console.log(`Cross-building s3cab ${VERSION} for: ${selected.join(", ")}`);
for (const target of selected) build(target);
