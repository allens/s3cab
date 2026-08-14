import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { RealS3 } from "../model/harness/real-inspector.mjs";
import { checkStore } from "../model/harness/invariants.mjs";
import { RepoModel, captureTree } from "../model/harness/model.mjs";

// The crash/concurrency tier's orchestration: spawn the real CLI as child
// processes (separate `S3CAB_HOME` per simulated machine) against the real
// sole-owner crash bucket, with the killswitch preload (killswitch.mjs)
// injecting hard kills and deterministic holds at S3-request boundaries.
//
// Everything asserted about the bucket goes through the out-of-band inspector
// (harness/real-inspector.mjs) and the model's independent parser — never
// through src/lib/s3.mjs, which is part of what is under test.

const CRASH_BUCKET = process.env.S3CAB_CRASH_BUCKET;

if (!CRASH_BUCKET) {
  throw new Error(
    "No crash bucket configured. The crash/concurrency tier needs a real,\n" +
      "sole-owner S3 bucket (docs/integration-testing.md naming convention):\n\n" +
      "    export S3CAB_CRASH_BUCKET=test-s3cab-<you>-crash\n\n" +
      "  Working in a worktree? `.env.test` is gitignored and stays in the\n" +
      "  main checkout. Copy it across:\n" +
      "    cp ../../../.env.test .env.test\n",
  );
}
if (
  !CRASH_BUCKET.startsWith("test-s3cab-") ||
  !CRASH_BUCKET.endsWith("-crash")
) {
  // wipe() deletes every version of every object — the name convention is the
  // safety boundary that keeps that away from real backups and from the
  // shared integration bucket.
  throw new Error(
    `Refusing crash bucket '${CRASH_BUCKET}': the name must match ` +
      "test-s3cab-<owner>-crash. Crash tests wipe the whole bucket between cases.",
  );
}

/** The gated bucket — guaranteed set (the check above throws otherwise). */
export const bucket = CRASH_BUCKET;

export const inspector = new RealS3();

/**
 * Reset the bucket to empty: every version, delete marker, and in-progress
 * multipart upload (killed backups strand those, and a leftover would skew
 * the next case's stranded-upload observation).
 */
export async function wipeBucket() {
  await inspector.wipe(bucket);
  const stranded = await inspector.listMultipartUploads(bucket);
  for (const { key, uploadId } of stranded) {
    await inspector.abortMultipartUpload(bucket, key, uploadId);
  }
}

const CLI = "src/s3cab.mjs";
const KILLSWITCH = pathToFileURL(resolve("test/crash/killswitch.mjs")).href;

// Distinct fixed-offset zones, ordered so each successive backup's *local*
// wall clock moves forward (Etc/GMT+12 is UTC−12; Etc/GMT-14 is UTC+14).
// Snapshot names are minute-precision local time, so giving each backup in a
// test its own zone yields distinct names without waiting out real minutes —
// and rotating forward keeps the clock-went-backwards warning quiet.
const ZONES = Array.from({ length: 27 }, (_, i) =>
  i < 12 ? `Etc/GMT+${12 - i}` : `Etc/GMT-${i - 12}`,
);
let zoneCursor = 0;
/** The next forward-moving zone for a backup/snapshot child. */
export function nextZone() {
  const zone = ZONES[zoneCursor % ZONES.length];
  zoneCursor++;
  return /** @type {string} */ (zone);
}

/**
 * @typedef {Object} ChildOptions
 * @property {string} home - The child's S3CAB_HOME (its simulated machine)
 * @property {string} [tz] - TZ for the child (snapshot names are local time)
 * @property {string} [kill] - S3CAB_XKILL spec ("<n>:<METHOD>:<pathRegex>")
 * @property {string} [hold] - S3CAB_XHOLD spec
 * @property {string} [holdGate] - File whose appearance releases the hold
 * @property {string} [holdReached] - File the child writes when the hold starts
 * @property {string} [graceMs] - S3CAB_XGRACE_MS (labeled time compression)
 * @property {string} [log] - S3CAB_XLOG trace file
 * @property {string} [tag] - Trace tag
 * @property {string} [input] - stdin text (for prompt-driven commands)
 */

/**
 * @param {ChildOptions} options
 * @returns {NodeJS.ProcessEnv}
 */
function childEnv(options) {
  /** @type {NodeJS.ProcessEnv} */
  const env = {
    ...process.env,
    // Ambient instrumentation vars must never leak in from the developer's
    // shell — a stray S3CAB_XKILL would sabotage every child. Cleared first,
    // then re-set only from the explicit options below.
    S3CAB_XKILL: undefined,
    S3CAB_XHOLD: undefined,
    S3CAB_XHOLD_GATE: undefined,
    S3CAB_XHOLD_REACHED: undefined,
    S3CAB_XGRACE_MS: undefined,
    S3CAB_XLOG: undefined,
    S3CAB_XTAG: undefined,
    S3CAB_HOME: options.home,
    ...(options.tz ? { TZ: options.tz } : {}),
    ...(options.kill ? { S3CAB_XKILL: options.kill } : {}),
    ...(options.hold ? { S3CAB_XHOLD: options.hold } : {}),
    ...(options.holdGate ? { S3CAB_XHOLD_GATE: options.holdGate } : {}),
    ...(options.holdReached
      ? { S3CAB_XHOLD_REACHED: options.holdReached }
      : {}),
    ...(options.graceMs ? { S3CAB_XGRACE_MS: options.graceMs } : {}),
    ...(options.log ? { S3CAB_XLOG: options.log } : {}),
    ...(options.tag ? { S3CAB_XTAG: options.tag } : {}),
  };
  return env;
}

/**
 * Run the s3cab CLI to completion in a child process.
 * @param {string[]} args
 * @param {ChildOptions} options
 */
export function s3cab(args, options) {
  return spawnSync(process.execPath, ["--import", KILLSWITCH, CLI, ...args], {
    encoding: "utf8",
    env: childEnv(options),
    input: options.input,
    timeout: 180_000,
  });
}

/**
 * Spawn the s3cab CLI detached from this turn — for holds and true
 * concurrency. Resolves with the child's outcome when it exits.
 * @param {string[]} args
 * @param {ChildOptions} options
 * @returns {{ done: Promise<{ status: number | null, signal: string | null,
 *   stdout: string, stderr: string }>, pid: number | undefined }}
 */
export function s3cabAsync(args, options) {
  const child = spawn(
    process.execPath,
    ["--import", KILLSWITCH, CLI, ...args],
    { env: childEnv(options), stdio: ["ignore", "pipe", "pipe"] },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const done = new Promise((resolvePromise) => {
    child.on("close", (status, signal) => {
      resolvePromise({ status, signal, stdout, stderr });
    });
  });
  return { done, pid: child.pid };
}

/**
 * Wait for a file to appear (a hold's "reached" marker).
 * @param {string} path
 * @param {number} [timeoutMs]
 */
export async function waitForFile(path, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path)) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${path}`);
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** Release a hold by creating its gate file. @param {string} gate */
export function release(gate) {
  writeFileSync(gate, "go\n");
}

/**
 * Seed a set directly on disk under an `S3CAB_HOME` (the e2e pattern): the
 * set store is just files, and going through online `setup` in every scenario
 * would add a claim round-trip the scenario isn't about.
 * @param {string} home - The child's S3CAB_HOME
 * @param {string} name - The set name
 * @param {string[]} dirs - Member directories (made absolute)
 */
export function seedSet(home, name, dirs) {
  const setDir = join(home, "sets", name);
  mkdirSync(setDir, { recursive: true });
  writeFileSync(
    join(setDir, "dirs.txt"),
    dirs.map((dir) => resolve(dir)).join("\n") + "\n",
  );
  writeFileSync(join(setDir, "env"), `S3CAB_BUCKET=${bucket}\n`);
}

/**
 * Write a file tree. Values are file contents; a number means "that many
 * pseudo-random bytes" (for multipart-sized files).
 * @param {string} root
 * @param {Record<string, string | number>} files
 */
export function makeTree(root, files) {
  for (const [rel, content] of Object.entries(files)) {
    const path = join(root, rel);
    mkdirSync(join(path, ".."), { recursive: true });
    if (typeof content === "number") {
      // Deterministic-enough filler; incompressible so sizes stay honest.
      // Whole words only — a size that isn't a multiple of 4 keeps its last
      // 1–3 bytes zero rather than overrunning the buffer.
      const bytes = Buffer.alloc(content);
      for (let i = 0; i + 4 <= content; i += 4) {
        bytes.writeUInt32LE(((i * 2654435761) ^ 0x9e3779b9) >>> 0, i);
      }
      writeFileSync(path, bytes);
    } else {
      writeFileSync(path, content);
    }
  }
}

/**
 * The store-shape invariants over the real bucket, via the independent
 * inspector + parser. Empty array = healthy.
 */
export async function bucketViolations() {
  const model = new RepoModel(bucket, inspector);
  return checkStore(model);
}

/**
 * Restore a set (latest snapshot) into a fresh output dir on a fresh
 * "recovery machine" home, and compare byte-for-byte against an expected
 * tree captured with `captureTree`.
 * @param {object} args
 * @param {string} args.set
 * @param {string} args.scratch - Parent dir for the recovery home + output
 * @param {Map<string, Buffer>} args.expected - captureTree of the source dirs
 * @param {string[]} args.dirs - The set's member dirs (seeded into the home)
 * @returns {{ violations: string[], result: ReturnType<typeof s3cab> }}
 */
export function restoreAndCompare({ set, scratch, expected, dirs }) {
  const home = join(
    scratch,
    `restore-home-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  const output = join(
    scratch,
    `restore-out-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  mkdirSync(home, { recursive: true });
  mkdirSync(output, { recursive: true });
  seedSet(home, set, dirs);
  const result = s3cab(["restore", "--set", set, "--output", output], { home });
  /** @type {string[]} */
  const violations = [];
  if (result.status !== 0) {
    violations.push(
      `restore of '${set}' exited ${result.status}: ${result.stderr}`,
    );
    return { violations, result };
  }
  const actualDirs = [];
  for (const dir of dirs) {
    actualDirs.push(join(output, basenameOf(dir)));
  }
  const actual = captureTree(actualDirs);
  for (const [file, bytes] of expected) {
    const got = actual.get(file);
    if (got === undefined) {
      violations.push(`restore of '${set}' is missing ${file}`);
    } else if (!got.equals(bytes)) {
      violations.push(
        `restore of '${set}' corrupted ${file} (${got.length} bytes, expected ${bytes.length})`,
      );
    }
  }
  for (const file of actual.keys()) {
    if (!expected.has(file)) {
      violations.push(`restore of '${set}' invented ${file}`);
    }
  }
  return { violations, result };
}

/** @param {string} path */
const basenameOf = (path) => resolve(path).split(/[\\/]/).at(-1) ?? path;
