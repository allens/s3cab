import { mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { captureTree, sha256 } from "./model.mjs";

/** @import { RepoModel, TrackedSnapshot, Tree } from "./model.mjs" */

// The invariant checks the runner applies after every operation — the brief's
// list, as executable assertions over the *observed* backend plus the model's
// captured trees. Backend- and tier-agnostic: everything arrives as data or as
// an injected function (the restore command comes from the caller, so Tier 1
// passes the seam-mocked one and Tier 2 the real one).
//
// Violation messages are the suite's failure output, so each names the
// invariant it breaks and the concrete evidence — they must read well after
// shrinking.

/**
 * The complete legal keyspace (guide/format.md's repository layout). Anything
 * else in the bucket is a violation — s3cab wrote where it mustn't.
 */
const LEGAL_KEY = new RegExp(
  "^(objects/[0-9a-f]{64}" +
    "|snapshots/[^/]+/[^/]+\\.tsv\\.zst" +
    "|sets/[^/]+/(info|dirs\\.txt|exclude\\.txt)" +
    "|objects\\.deleted-[1-9][0-9]*\\.tsv)$",
);

/**
 * The store-shape invariants, checked from the backend listing alone:
 *
 * 1. every key is one the format spec allows;
 * 2. every stored object's bytes hash to its name (content-address integrity —
 *    also what makes "identical content stored exactly once" hold: same bytes
 *    cannot live under two different correct names);
 * 3. no manifest references an object that is neither stored nor explained by
 *    a deletion record (the objects-first/snapshot-last commitment);
 * 4. a manifest's own header agrees with the key it is stored under.
 *
 * @param {RepoModel} model
 * @returns {Promise<string[]>} violations (empty = healthy)
 */
export async function checkStore(model) {
  /** @type {string[]} */
  const violations = [];

  const all = await model.backend.listAll(model.bucket);
  for (const { key } of all) {
    if (!LEGAL_KEY.test(key)) {
      violations.push(`illegal key in bucket: ${key}`);
    }
  }

  for (const { key } of all) {
    if (key.startsWith("objects/")) {
      const bytes = await model.backend.getBytes(model.bucket, key);
      const hash = key.slice("objects/".length);
      if (bytes === undefined) {
        violations.push(`object listed but unreadable: ${key}`);
      } else if (sha256(bytes) !== hash) {
        violations.push(
          `content-address violation: ${key} holds bytes hashing to ${sha256(bytes)}`,
        );
      }
    }
  }

  const stored = await model.storedObjects();
  const deleted = await model.deletedHashes();
  for (const manifest of await model.parsedManifests()) {
    for (const error of manifest.parseErrors) {
      violations.push(`unparseable manifest ${manifest.key}: ${error}`);
    }
    if (
      manifest.headerSet !== undefined &&
      manifest.headerSet !== manifest.set
    ) {
      violations.push(
        `manifest under snapshots/${manifest.set}/ claims set '${manifest.headerSet}' in its header`,
      );
    }
    if (
      manifest.headerName !== undefined &&
      manifest.headerName !== manifest.name
    ) {
      violations.push(
        `manifest ${manifest.set}/${manifest.name} claims name '${manifest.headerName}' in its header`,
      );
    }
    for (const { hash, path } of manifest.rows) {
      if (!stored.has(hash) && !deleted.has(hash)) {
        violations.push(
          `dangling reference: ${manifest.set}/${manifest.name} references ${hash} (${path}) which is not stored`,
        );
      }
    }
  }

  return violations;
}

/**
 * The restore invariant: every snapshot the model saw get published restores
 * byte-identically to the tree captured when it was adopted.
 *
 * @param {RepoModel} model
 * @param {(tracked: TrackedSnapshot, output: string) => Promise<void>} restoreSnapshot -
 *   Runs the restore command for one snapshot into `output` and throws (or
 *   records) its own failures; Tier 1 passes a seam-backed closure.
 * @param {string} scratchRoot - A disposable directory for restore outputs
 * @returns {Promise<string[]>} violations
 */
export async function checkRestores(model, restoreSnapshot, scratchRoot) {
  /** @type {string[]} */
  const violations = [];
  let n = 0;
  for (const tracked of model.snapshots.values()) {
    if (!tracked.tree) {
      continue; // adopted without a capture — nothing to compare against
    }
    const output = join(
      scratchRoot,
      `restore-${n++}-${tracked.set}-${tracked.name}`,
    );
    mkdirSync(output, { recursive: true });
    const savedExitCode = process.exitCode;
    process.exitCode = 0;
    try {
      await restoreSnapshot(tracked, output);
      if (process.exitCode !== 0) {
        violations.push(
          `restore of ${tracked.set}/${tracked.name} reported failure (exit ${process.exitCode})`,
        );
        continue;
      }
    } catch (error) {
      violations.push(
        `restore of ${tracked.set}/${tracked.name} threw: ${String(error)}`,
      );
      continue;
    } finally {
      process.exitCode = savedExitCode;
    }
    violations.push(...compareTrees(tracked, output));
  }
  return violations;
}

/**
 * Byte-compare a restore output against a tracked snapshot's captured tree.
 * @param {TrackedSnapshot} tracked
 * @param {string} output - The directory the restore wrote into
 * @returns {string[]} violations
 */
export function compareTrees(tracked, output) {
  /** @type {string[]} */
  const violations = [];
  const expected = /** @type {Tree} */ (tracked.tree);
  const restoredDirs = readdirSync(output, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(output, entry.name));
  const actual = captureTree(restoredDirs);
  for (const [file, bytes] of expected) {
    const got = actual.get(file);
    if (got === undefined) {
      violations.push(
        `restore of ${tracked.set}/${tracked.name} is missing ${file}`,
      );
    } else if (!got.equals(bytes)) {
      violations.push(
        `restore of ${tracked.set}/${tracked.name} corrupted ${file}: ` +
          `${got.length} bytes hashing ${sha256(got)}, expected ${bytes.length} hashing ${sha256(bytes)}`,
      );
    }
  }
  for (const file of actual.keys()) {
    if (!expected.has(file)) {
      violations.push(
        `restore of ${tracked.set}/${tracked.name} invented ${file}`,
      );
    }
  }
  return violations;
}

/**
 * The in-flight dedup invariant, from one operation's op-log slice: an
 * unfaulted backup/upload never PUTs the same `objects/` key twice.
 * @param {{ op: string, uri: string }[]} logSlice - The backend ops one command issued
 * @returns {string[]} violations
 */
export function checkNoDuplicateObjectPuts(logSlice) {
  /** @type {string[]} */
  const violations = [];
  /** @type {Set<string>} */
  const put = new Set();
  for (const { op, uri } of logSlice) {
    if (op === "PUT" && uri.includes("/objects/")) {
      if (put.has(uri)) {
        violations.push(`object PUT twice in one operation: ${uri}`);
      }
      put.add(uri);
    }
  }
  return violations;
}

/**
 * The commit-point ordering invariant, from one backup/upload's op-log slice:
 * every `objects/` PUT precedes the manifest PUT.
 * @param {{ op: string, uri: string }[]} logSlice
 * @returns {string[]} violations
 */
export function checkObjectsBeforeManifest(logSlice) {
  /** @type {string[]} */
  const violations = [];
  let manifestUri;
  for (const { op, uri } of logSlice) {
    if (op !== "PUT") {
      continue;
    }
    if (uri.includes("/snapshots/")) {
      manifestUri = uri;
    } else if (uri.includes("/objects/") && manifestUri !== undefined) {
      violations.push(
        `object PUT after the manifest (${uri} after ${manifestUri})`,
      );
    }
  }
  return violations;
}
