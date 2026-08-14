import crypto from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { zstdDecompressSync } from "node:zlib";

/**
 * The slice of the inspection surface the model reads a bucket through —
 * satisfied by the Tier 1 fake and the Tier 2 real-S3 inspector alike (the
 * backend-as-parameter seam; see CAPABILITIES.md, "inspection").
 * @typedef {{
 *   listAll(bucket: string): Promise<{ key: string, size: number }[]>,
 *   getBytes(bucket: string, key: string): Promise<Buffer | undefined>,
 * }} InspectionBackend
 */

// The harness's model of expected repository state — the oracle the invariants
// compare against. Two deliberate stances:
//
// **Observe and constrain, don't predict.** Under fault injection the model
// cannot know whether a faulted PUT landed (a lost response looks identical to
// a lost request from above the seam), so it never predicts exact store
// contents. Instead it *reconciles* after every operation — adopting manifests
// that appeared, dropping ones that vanished — and the invariants are
// properties every legal repository state satisfies (guide/format.md's
// "objects first, snapshot last" and its consequences), not an exact-state
// diff. What the model does pin exactly: the byte content behind every
// manifest it saw get published, captured from disk at adoption time (sound
// because the runner only mutates trees *between* operations).
//
// **Parse the stored format independently.** References, sizes and deletion
// records are extracted by this file's own zstd + TSV parser, written from
// guide/format.md alone — not by the production snapshot reader, which is
// itself under test.

/** @typedef {Map<string, Buffer>} Tree - `<dirBasename>/<posix relpath>` → bytes */

/**
 * One manifest the model saw get published, with the tree it must restore to.
 * `tree` is null only for a manifest adopted without a capture opportunity
 * (never in generator runs; targeted tests may construct such states).
 * @typedef {{ set: string, name: string, key: string, tree: Tree | null }} TrackedSnapshot
 */

/** @typedef {{ hash: string, size: number, mtime: string, path: string }} ManifestRow */

/**
 * @typedef {{
 *   key: string,
 *   set: string,
 *   name: string,
 *   rows: ManifestRow[],
 *   headerSet: string | undefined,
 *   headerName: string | undefined,
 *   parseErrors: string[],
 * }} ParsedManifest
 */

export const sha256 = (/** @type {Buffer | string} */ content) =>
  crypto.hash("sha256", Buffer.from(content), "hex");

const MANIFEST_KEY = /^snapshots\/([^/]+)\/([^/]+)\.tsv\.zst$/;
const OBJECT_KEY = /^objects\/([0-9a-f]{64})$/;

/**
 * Read a directory tree the way the harness captures expected content:
 * regular files only, keyed `<dirBasename>/<posix relpath>` — the shape
 * `restore --output` recreates.
 * @param {string[]} dirs - The set's member directories (absolute)
 * @returns {Tree}
 */
export function captureTree(dirs) {
  /** @type {Tree} */
  const tree = new Map();
  for (const dir of dirs) {
    const base = basename(dir);
    /** @type {(rel: string) => void} */
    const walk = (rel) => {
      const abs = rel === "" ? dir : join(dir, rel);
      for (const entry of readdirSync(abs, { withFileTypes: true })) {
        const childRel = rel === "" ? entry.name : `${rel}/${entry.name}`;
        if (entry.isDirectory()) {
          walk(childRel);
        } else if (entry.isFile()) {
          tree.set(`${base}/${childRel}`, readFileSync(join(dir, childRel)));
        }
        // Symlinks/junctions etc. are not captured — the format spec stores
        // regular files only, so they are outside the restore contract.
      }
    };
    walk("");
  }
  return tree;
}

/**
 * The model's own manifest parser, from the format spec: four tab-separated
 * fields per row (`hash size mtime path`, leading fields space-padded — trim),
 * lines whose first field starts with `#` are metadata. Anything the spec
 * says can't happen lands in `parseErrors`.
 * @param {string} key - The manifest's bucket key (names its set + snapshot)
 * @param {Buffer} bytes - The stored `.tsv.zst` content
 * @returns {ParsedManifest}
 */
export function parseManifest(key, bytes) {
  const match = MANIFEST_KEY.exec(key);
  const set = match?.[1] ?? "?";
  const name = match?.[2] ?? "?";
  /** @type {ManifestRow[]} */
  const rows = [];
  /** @type {string[]} */
  const parseErrors = [];
  /** @type {string | undefined} */
  let headerSet;
  /** @type {string | undefined} */
  let headerName;
  /** @type {string} */
  let text;
  try {
    text = zstdDecompressSync(bytes).toString("utf8");
  } catch (error) {
    return {
      key,
      set,
      name,
      rows,
      headerSet,
      headerName,
      parseErrors: [`zstd decompression failed: ${String(error)}`],
    };
  }
  for (const line of text.split("\n")) {
    if (line === "") {
      continue; // the trailing newline's empty split
    }
    const fields = line.split("\t");
    const first = (fields[0] ?? "").trim();
    if (first.startsWith("#")) {
      if (first === "#SNAPSHOT") {
        headerSet = fields[1]?.trim();
        headerName = fields[3]?.trim().split(" ")[0];
      }
      continue;
    }
    if (fields.length < 4) {
      parseErrors.push(`row with ${fields.length} fields: ${line}`);
      continue;
    }
    const hash = first;
    const size = Number((fields[1] ?? "").trim());
    if (!/^[0-9a-f]{64}$/.test(hash) || !Number.isInteger(size)) {
      parseErrors.push(`malformed row: ${line}`);
      continue;
    }
    rows.push({
      hash,
      size,
      mtime: (fields[2] ?? "").trim(),
      path: fields.slice(3).join("\t"),
    });
  }
  return { key, set, name, rows, headerSet, headerName, parseErrors };
}

/**
 * Parse a deletion record (`deletions/<ts>.tsv`): skip `#` lines, first field
 * of a row is the deleted hash.
 * @param {Buffer} bytes
 * @returns {Set<string>}
 */
export function parseDeletionRecord(bytes) {
  /** @type {Set<string>} */
  const hashes = new Set();
  for (const line of bytes.toString("utf8").split("\n")) {
    if (line === "" || line.trimStart().startsWith("#")) {
      continue;
    }
    const hash = (line.split("\t")[0] ?? "").trim();
    if (hash !== "") {
      hashes.add(hash);
    }
  }
  return hashes;
}

/**
 * The model proper: which snapshots have been published (and what they must
 * restore to), reconciled against the observed bucket after every operation.
 */
export class RepoModel {
  /**
   * @param {string} bucket
   * @param {InspectionBackend} backend - Any backend implementing the inspection surface
   */
  constructor(bucket, backend) {
    this.bucket = bucket;
    this.backend = backend;
    /** @type {Map<string, TrackedSnapshot>} `${set}/${name}` → tracked */
    this.snapshots = new Map();
  }

  /**
   * The bucket's manifest keys, parsed out of a full listing.
   * @returns {Promise<{ set: string, name: string, key: string }[]>}
   */
  async listManifests() {
    const all = await this.backend.listAll(this.bucket);
    /** @type {{ set: string, name: string, key: string }[]} */
    const manifests = [];
    for (const { key } of all) {
      const match = MANIFEST_KEY.exec(key);
      if (match) {
        manifests.push({
          set: /** @type {string} */ (match[1]),
          name: /** @type {string} */ (match[2]),
          key,
        });
      }
    }
    return manifests;
  }

  /**
   * Reconcile the model with the observed bucket after one operation.
   *
   * - A manifest that vanished is dropped (forget/cleanup took it, or a
   *   faulted delete half-landed — either way it is no longer a restore
   *   obligation).
   * - A manifest that appeared is adopted. If the op was a backup/upload of
   *   that set, the set's directory trees are captured from disk as its
   *   expected content (sound: the runner mutates trees only between ops, so
   *   the tree now is the tree the walk saw). A manifest appearing under any
   *   other circumstance has no capture opportunity → tree `null`, and the
   *   caller decides whether that is itself a violation.
   *
   * @param {{ publishedSet?: string, dirs?: string[] }} [context] - When the
   *   op could legitimately publish (backup/upload): which set, and its dirs.
   * @returns {Promise<{ adopted: TrackedSnapshot[], dropped: TrackedSnapshot[],
   *   unexplained: { set: string, name: string, key: string }[] }>}
   */
  async reconcile({ publishedSet, dirs } = {}) {
    const seen = await this.listManifests();
    const seenKeys = new Set(seen.map(({ key }) => key));

    /** @type {TrackedSnapshot[]} */
    const dropped = [];
    for (const [id, tracked] of this.snapshots) {
      if (!seenKeys.has(tracked.key)) {
        dropped.push(tracked);
        this.snapshots.delete(id);
      }
    }

    /** @type {TrackedSnapshot[]} */
    const adopted = [];
    /** @type {{ set: string, name: string, key: string }[]} */
    const unexplained = [];
    for (const { set, name, key } of seen) {
      if (this.snapshots.has(`${set}/${name}`)) {
        continue;
      }
      if (set === publishedSet && dirs) {
        /** @type {TrackedSnapshot} */
        const tracked = { set, name, key, tree: captureTree(dirs) };
        this.snapshots.set(`${set}/${name}`, tracked);
        adopted.push(tracked);
      } else {
        unexplained.push({ set, name, key });
      }
    }
    return { adopted, dropped, unexplained };
  }

  /**
   * Every parsed manifest currently in the bucket (the model's own parser).
   * @returns {Promise<ParsedManifest[]>}
   */
  async parsedManifests() {
    /** @type {ParsedManifest[]} */
    const parsed = [];
    for (const { key } of await this.listManifests()) {
      const bytes = await this.backend.getBytes(this.bucket, key);
      if (bytes) {
        parsed.push(parseManifest(key, bytes));
      }
    }
    return parsed;
  }

  /**
   * Hashes named by the bucket's deletion records (deliberately removed —
   * their absence from `objects/` is expected, not damage).
   * @returns {Promise<Set<string>>}
   */
  async deletedHashes() {
    /** @type {Set<string>} */
    const deleted = new Set();
    for (const { key } of await this.backend.listAll(this.bucket)) {
      if (key.startsWith("deletions/")) {
        const bytes = await this.backend.getBytes(this.bucket, key);
        if (bytes) {
          for (const hash of parseDeletionRecord(bytes)) {
            deleted.add(hash);
          }
        }
      }
    }
    return deleted;
  }

  /**
   * The stored object hashes and their sizes, from the listing.
   * @returns {Promise<Map<string, number>>} hash → stored size
   */
  async storedObjects() {
    /** @type {Map<string, number>} */
    const stored = new Map();
    for (const { key, size } of await this.backend.listAll(this.bucket)) {
      const match = OBJECT_KEY.exec(key);
      if (match) {
        stored.set(/** @type {string} */ (match[1]), size);
      }
    }
    return stored;
  }

  /**
   * Whether `verify` should find problems, computed the way verify defines
   * them (ADR-0042/ADR-0064): a referenced hash that is neither stored nor
   * explained by a deletion record, a stored size ≠ a recorded size, or a
   * manifest the parser can't read.
   * @returns {Promise<{ findings: string[], expectExit1: boolean }>}
   */
  async expectedVerifyFindings() {
    const manifests = await this.parsedManifests();
    const stored = await this.storedObjects();
    const deleted = await this.deletedHashes();
    /** @type {string[]} */
    const findings = [];
    for (const manifest of manifests) {
      for (const error of manifest.parseErrors) {
        findings.push(
          `${manifest.set}/${manifest.name}: unreadable (${error})`,
        );
      }
      for (const { hash, size, path } of manifest.rows) {
        const storedSize = stored.get(hash);
        if (storedSize === undefined) {
          if (!deleted.has(hash)) {
            findings.push(
              `${manifest.set}/${manifest.name}: missing ${hash} (${path})`,
            );
          }
        } else if (storedSize !== size) {
          findings.push(
            `${manifest.set}/${manifest.name}: wrong-size ${hash} (${storedSize} ≠ ${size})`,
          );
        }
      }
    }
    return { findings, expectExit1: findings.length > 0 };
  }
}
