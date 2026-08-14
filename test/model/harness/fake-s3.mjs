import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Readable } from "node:stream";
import { ContentMismatchError } from "../../../src/lib/error.mjs";
import { clockHolder } from "./clock.mjs";

/** @import { _Object } from "@aws-sdk/client-s3" */
/** @import { VirtualClock } from "./clock.mjs" */

// The Tier 1 in-memory storage backend, faking the s3.mjs seam (the seam
// ADR-0019 designates for deterministic error injection). It models only the
// operations s3cab actually performs — conditional PUT, GET, HEAD, LIST,
// DELETE over one flat keyspace — not S3 at large, and it declares only the
// capabilities it truly models (see `capabilities`): no versioning, no delete
// markers, no multipart mechanics, no lifecycle, no LIST pagination. Tests
// needing those declare the capability and skip here (they run against real
// AWS in Tier 2) — an optimistic fake that claims what it fakes poorly is how
// a suite passes against broken code.
//
// Time: objects are stamped with the *virtual* clock at PUT, and LIST reports
// LastModified as `real now − virtual age`, so cleanup's real-clock grace
// window measures exactly the virtual age the sequence arranged — no Date.now
// mocking anywhere.

/**
 * What the fake truthfully models. The full vocabulary, and which backend
 * claims what, lives in test/model/CAPABILITIES.md.
 * @type {ReadonlySet<string>}
 */
export const FAKE_CAPABILITIES = new Set([
  "conditional-put",
  "list-last-modified",
  "strong-consistency",
  "virtual-clock",
  "fault-injection",
  "inspection",
]);

/**
 * A fault decision for one storage operation, made by a fault plan (see
 * faults.mjs) or forced by a targeted test:
 * - `"fail-before"` — the request never reached storage (thrown, no effect);
 * - `"fail-after"`  — the request applied but its response was lost (effect,
 *    then thrown) — the retry/duplicate-delivery shape;
 * - `"duplicate"`   — the request was delivered twice (effect applied twice,
 *    first result returned);
 * - `"truncate"`    — a GET body cut short part-way (reads only).
 * @typedef {"fail-before" | "fail-after" | "duplicate" | "truncate"} Fault
 */

/**
 * A pluggable per-operation fault source. `plan` is consulted once per storage
 * operation; return `undefined` for no fault.
 * @typedef {{ plan: (op: string, uri: string) => Fault | undefined }} FaultSource
 */

/** @typedef {{ bytes: Buffer, virtualMs: number }} StoredObject */

/** A transport-shaped error (errno matched by s3.mjs's isNetworkError). */
const networkError = () =>
  Object.assign(new Error("socket hang up (injected)"), {
    code: "ECONNRESET",
  });

/** @param {string} key */
const noSuchKey = (key) =>
  Object.assign(new Error(`The specified key does not exist: ${key}`), {
    name: "NoSuchKey",
  });

/** @param {string} key */
const notFound = (key) =>
  Object.assign(new Error(`Not Found: ${key}`), { name: "NotFound" });

/**
 * Parse `s3://bucket/key` — the same split s3.mjs performs on its way through.
 * @param {string} uri
 * @returns {{ bucket: string, key: string }}
 */
export function parseUri(uri) {
  const url = new URL(uri);
  if (url.protocol !== "s3:") {
    throw new Error(`Expected an s3:// URI (got ${url.protocol}//)`);
  }
  return { bucket: url.hostname, key: url.pathname.slice(1) };
}

/**
 * The in-memory store plus the seam functions bound over it. One instance per
 * sequence; `backendHolder.current` routes the mocked s3.mjs here.
 */
export class FakeS3 {
  /** @param {VirtualClock} [clock] - Defaults to the shared holder's clock */
  constructor(clock) {
    /** @type {Map<string, Map<string, StoredObject>>} bucket → key → object */
    this.buckets = new Map();
    this.clock = clock;
    /** @type {FaultSource | null} */
    this.faults = null;
    /**
     * Targeted-test hook: runs after a `putFile` is asked for but *before* the
     * fake reads the file's bytes — the "file mutated during its transfer"
     * window, the one putFile's streamed-digest check closes (the C1 fix).
     * Return value ignored.
     * @type {((path: string, uri: string) => Promise<void> | void) | null}
     */
    this.onPutFileRead = null;
    /** @type {{ op: string, uri: string }[]} every storage op, in order */
    this.log = [];
  }

  /** @returns {number} the sequence's virtual now (ms) */
  #now() {
    return (this.clock ?? clockHolder.current).now();
  }

  /**
   * @param {string} bucket
   * @returns {Map<string, StoredObject>}
   */
  #bucket(bucket) {
    let map = this.buckets.get(bucket);
    if (!map) {
      map = new Map();
      this.buckets.set(bucket, map);
    }
    return map;
  }

  /**
   * Run one storage operation through the fault plan.
   * @template T
   * @param {string} op
   * @param {string} uri
   * @param {() => T} effect - Applies the operation (synchronously) and
   *   returns its result; re-invoked for a duplicated delivery.
   * @returns {T}
   */
  #apply(op, uri, effect) {
    this.log.push({ op, uri });
    const fault = this.faults?.plan(op, uri);
    if (fault === "fail-before") {
      throw networkError();
    }
    const result = effect();
    if (fault === "duplicate") {
      try {
        effect();
      } catch {
        // The duplicate delivery's own failure (e.g. a conditional PUT now
        // refusing) is invisible to the caller, exactly as a network dupe is.
      }
    }
    if (fault === "fail-after") {
      throw networkError();
    }
    return result;
  }

  // ── The s3.mjs seam surface ─────────────────────────────────────────────

  /**
   * @param {string} uri - `s3://bucket/prefix`
   * @returns {AsyncGenerator<_Object>}
   */
  async *listObjects(uri) {
    const { bucket, key: prefix } = parseUri(uri);
    const realNow = Date.now();
    const virtualNow = this.#now();
    const entries = this.#apply("LIST", uri, () =>
      [...this.#bucket(bucket)]
        .filter(([key]) => key.startsWith(prefix))
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    );
    for (const [key, { bytes, virtualMs }] of entries) {
      yield {
        Key: key,
        Size: bytes.length,
        // Virtual age translated onto the real clock, so real-clock consumers
        // (cleanup's grace window) measure exactly the virtual age.
        LastModified: new Date(realNow - (virtualNow - virtualMs)),
      };
    }
  }

  /**
   * @param {string} uri
   * @returns {Promise<Readable>}
   */
  async getStream(uri) {
    const { bucket, key } = parseUri(uri);
    return this.#apply("GET", uri, () => {
      const object = this.#bucket(bucket).get(key);
      if (!object) {
        throw noSuchKey(key);
      }
      const fault = this.faults?.plan("GET-BODY", uri);
      const bytes =
        fault === "truncate" && object.bytes.length > 0
          ? object.bytes.subarray(
              0,
              Math.max(0, Math.floor(object.bytes.length / 2)),
            )
          : object.bytes;
      return Readable.from([Buffer.from(bytes)]);
    });
  }

  /**
   * @param {string} path - Local file whose bytes to store
   * @param {string} uri
   * @param {{ noClobber?: boolean, sha256?: string, onProgress?: (transfer: {
   *   path: string, loaded: number, total: number }) => void }} [options]
   * @returns {Promise<boolean>} true if stored, false if noClobber found it present
   */
  async putFile(path, uri, { noClobber, sha256, onProgress } = {}) {
    // The C1 window: the real putFile re-reads the file from disk for the
    // transfer itself, after the drift guard has already passed. Reading the
    // bytes here — after this hook — models that faithfully.
    await this.onPutFileRead?.(path, uri);
    const bytes = await readFile(path);
    onProgress?.({ path, loaded: bytes.length, total: bytes.length });
    const { bucket, key } = parseUri(uri);
    const wrote = await this.#apply("PUT", uri, () => {
      const map = this.#bucket(bucket);
      if (noClobber && map.has(key)) {
        return false;
      }
      map.set(key, { bytes, virtualMs: this.#now() });
      return true;
    });
    // The real putFile's streamed-digest check, same ordering: verified only
    // once the transfer *succeeded* (a fault from #apply throws first, a
    // noClobber miss returns false untouched), and the mis-stored object is
    // removed before the throw. Removal is direct rather than via
    // `this.deleteObject` so a fault plan can't strand the corrupt object —
    // that double-fault path (real code wraps it in a plain Error) is not
    // modelled here. Nor is the forced (`noClobber` false) mismatch, which the
    // real putFile leaves in place and reports as a plain Error: `uploadObjects`
    // never forces, so no model run can reach it.
    if (wrote && sha256) {
      const got = createHash("sha256").update(bytes).digest("hex");
      if (got !== sha256) {
        this.#bucket(bucket).delete(key);
        throw new ContentMismatchError(
          `Content changed during upload: ${path} streamed as ${got}, ` +
            `not the recorded ${sha256}; the mis-stored object was removed`,
        );
      }
    }
    return wrote;
  }

  /**
   * @param {string} uri
   * @param {string} content
   * @param {{ noClobber?: boolean }} [options]
   * @returns {Promise<boolean>}
   */
  async putText(uri, content, { noClobber = false } = {}) {
    const { bucket, key } = parseUri(uri);
    return this.#apply("PUT", uri, () => {
      const map = this.#bucket(bucket);
      if (noClobber && map.has(key)) {
        return false;
      }
      map.set(key, {
        bytes: Buffer.from(content, "utf8"),
        virtualMs: this.#now(),
      });
      return true;
    });
  }

  /**
   * @param {string} uri
   * @returns {Promise<string | undefined>}
   */
  async getText(uri) {
    const { bucket, key } = parseUri(uri);
    return this.#apply("GET", uri, () => {
      const object = this.#bucket(bucket).get(key);
      return object ? object.bytes.toString("utf8") : undefined;
    });
  }

  /**
   * @param {string} uri
   * @returns {Promise<boolean>}
   */
  async objectExists(uri) {
    const { bucket, key } = parseUri(uri);
    return this.#apply("HEAD", uri, () => {
      if (!this.#bucket(bucket).has(key)) {
        // Thrown and mapped, as the real HEAD path does — so a fault plan can
        // distinguish the miss from a transport failure if it ever needs to.
        try {
          throw notFound(key);
        } catch {
          return false;
        }
      }
      return true;
    });
  }

  /**
   * @param {string} uri
   * @returns {Promise<void>}
   */
  async deleteObject(uri) {
    const { bucket, key } = parseUri(uri);
    this.#apply("DELETE", uri, () => {
      // Unversioned hard delete, idempotent — the fake deliberately does not
      // model delete markers (no "versioning" capability).
      this.#bucket(bucket).delete(key);
    });
  }

  // ── The harness's inspection interface (shared with the real backend) ───

  /** Capability declarations — see CAPABILITIES.md. */
  get capabilities() {
    return FAKE_CAPABILITIES;
  }

  /**
   * Every key in a bucket (no pagination — the fake holds it all).
   * `virtualMs` (when it was PUT, virtual clock) is a fake-only extra the
   * cleanup-effectiveness oracle uses; the real backend's inspector omits it.
   * @param {string} bucket
   * @returns {Promise<{ key: string, size: number, virtualMs?: number }[]>} sorted by key
   */
  async listAll(bucket) {
    return [...this.#bucket(bucket)]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, { bytes, virtualMs }]) => ({
        key,
        size: bytes.length,
        virtualMs,
      }));
  }

  /**
   * @param {string} bucket
   * @param {string} key
   * @returns {Promise<Buffer | undefined>}
   */
  async getBytes(bucket, key) {
    const object = this.#bucket(bucket).get(key);
    return object ? Buffer.from(object.bytes) : undefined;
  }

  /**
   * Test-side seeding/corruption — writes around the seam, no faults applied.
   * @param {string} bucket
   * @param {string} key
   * @param {Buffer | string} bytes
   * @returns {Promise<void>}
   */
  async putBytes(bucket, key, bytes) {
    this.#bucket(bucket).set(key, {
      bytes: Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes, "utf8"),
      virtualMs: this.#now(),
    });
  }

  /**
   * @param {string} bucket
   * @param {string} key
   * @returns {Promise<void>}
   */
  async deleteKey(bucket, key) {
    this.#bucket(bucket).delete(key);
  }

  /**
   * Backdate one stored object's virtual upload time (e.g. to push a seeded
   * orphan past cleanup's grace window without advancing the whole clock).
   * @param {string} bucket
   * @param {string} key
   * @param {number} virtualMs
   */
  backdate(bucket, key, virtualMs) {
    const object = this.#bucket(bucket).get(key);
    if (object) {
      object.virtualMs = virtualMs;
    }
  }
}

/**
 * The mutable holder seam.mjs's s3.mjs mock reads through — one fresh FakeS3
 * per sequence, no re-mocking.
 * @type {{ current: FakeS3 }}
 */
export const backendHolder = { current: new FakeS3() };
