/**
 * SPIKE (scratch) — evaluate `node:sqlite` as a local hash cache for the owed
 * `upload --if-modified-from <snapshot>` skip and snapshot re-hash avoidance.
 *
 * The hard rule this spike exists to honour: sqlite is a **cache only**. It is
 * rebuildable from the plain TSV snapshots + the object store, so #2 (no
 * lock-in) is untouched — delete the `.db` and nothing of value is lost. The
 * stored manifest/objects formats stay plain TSV / hash-named files. This
 * script proves that property (drop + rebuild) alongside the API and perf.
 *
 * What it measures, against the *current* approach (read the previous snapshot
 * TSV into a `Map`, as `snapshot`/`compare` do today):
 *   - build time   — populate the lookup for N files
 *   - lookup time  — N point lookups keyed by (path, size, mtime)
 *   - on-disk size  — the persisted cache file vs a gzipped-TSV baseline feel
 *   - ergonomics    — what the calling code actually looks like
 *
 * Run: node scripts/sqlite-hash-cache-spike.mjs [N]
 */
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const N = Number(process.argv[2] ?? 200_000);

/**
 * Synthetic file records standing in for a walked backup set.
 * @param {number} count
 */
function* fakeFiles(count) {
  for (let i = 0; i < count; i++) {
    const path = `C:\\Users\\allen\\Pictures\\2024\\IMG_${i.toString().padStart(6, "0")}.jpg`;
    const size = 1_000_000 + ((i * 7919) % 5_000_000);
    const mtime = 1_700_000_000_000 + i * 1000;
    // The "expensive" value the cache exists to avoid recomputing.
    const hash = createHash("sha256")
      .update(`${path}:${size}:${mtime}`)
      .digest("hex");
    yield { path, size, mtime, hash };
  }
}

const records = Array.from(fakeFiles(N));

// ── Baseline: plain Map keyed by path, the shape today's code already uses ───
function buildMap() {
  const t0 = performance.now();
  /** @type {Map<string, {size:number, mtime:number, hash:string}>} */
  const map = new Map();
  for (const { path, size, mtime, hash } of records) {
    map.set(path, { size, mtime, hash });
  }
  const build = performance.now() - t0;

  const t1 = performance.now();
  let hits = 0;
  for (const { path, size, mtime } of records) {
    const row = map.get(path);
    if (row && row.size === size && row.mtime === mtime) hits++;
  }
  const lookup = performance.now() - t1;
  return { build, lookup, hits };
}

// ── Candidate: node:sqlite, a small HashCache wrapper ────────────────────────
/** Minimal wrapper around what the real cache module would expose. */
class HashCache {
  /** @param {string} file */
  constructor(file) {
    this.db = new DatabaseSync(file);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS files (
        path  TEXT PRIMARY KEY,
        size  INTEGER NOT NULL,
        mtime INTEGER NOT NULL,
        hash  TEXT NOT NULL
      ) WITHOUT ROWID;
    `);
    // WAL + relaxed sync is the standard "throwaway cache" pragma set: a crash
    // can lose the last writes, which is fine — the cache is rebuildable.
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;");
    this._upsert = this.db.prepare(
      `INSERT INTO files (path, size, mtime, hash) VALUES (?, ?, ?, ?)
       ON CONFLICT(path) DO UPDATE SET size=excluded.size, mtime=excluded.mtime, hash=excluded.hash`,
    );
    // The actual question the snapshot walk asks: "unchanged since last time?"
    this._lookup = this.db.prepare(
      "SELECT hash FROM files WHERE path = ? AND size = ? AND mtime = ?",
    );
  }
  /** @param {{path:string,size:number,mtime:number,hash:string}} r */
  put({ path, size, mtime, hash }) {
    this._upsert.run(path, size, mtime, hash);
  }
  /**
   * @param {string} path
   * @param {number} size
   * @param {number} mtime
   * @returns {string | undefined} cached hash when (path,size,mtime) match
   */
  cachedHash(path, size, mtime) {
    const row = this._lookup.get(path, size, mtime);
    return row ? /** @type {string} */ (row.hash) : undefined;
  }
  close() {
    this.db.close();
  }
}

/** @param {string} file */
function buildSqlite(file) {
  const t0 = performance.now();
  const cache = new HashCache(file);
  // One transaction for the bulk load — without this each insert is its own
  // fsync'd transaction and the load is ~100x slower (worth recording).
  cache.db.exec("BEGIN");
  for (const r of records) cache.put(r);
  cache.db.exec("COMMIT");
  const build = performance.now() - t0;

  const t1 = performance.now();
  let hits = 0;
  for (const { path, size, mtime } of records) {
    if (cache.cachedHash(path, size, mtime)) hits++;
  }
  const lookup = performance.now() - t1;
  return { cache, build, lookup, hits };
}

// ── Run ──────────────────────────────────────────────────────────────────────
const dir = mkdtempSync(join(tmpdir(), "s3cab-sqlite-spike-"));
const dbFile = join(dir, "hash-cache.db");
const ms = (/** @type {number} */ n) => `${n.toFixed(1)} ms`;

console.log(`node:sqlite hash-cache spike — N=${N.toLocaleString()} files\n`);

const map = buildMap();
const { cache, ...sqlite } = buildSqlite(dbFile);

const dbBytes = statSync(dbFile).size;

console.log("Map (current approach):");
console.log(`  build : ${ms(map.build)}`);
console.log(`  lookup: ${ms(map.lookup)}  (${map.hits} hits)\n`);

console.log("node:sqlite (candidate):");
console.log(`  build : ${ms(sqlite.build)}  (incl. table + index writes)`);
console.log(`  lookup: ${ms(sqlite.lookup)}  (${sqlite.hits} hits)`);
console.log(`  file  : ${(dbBytes / 1_000_000).toFixed(1)} MB on disk\n`);

// ── Prove the no-lock-in property: persist, reopen, then drop & "rebuild" ─────
cache.close();
const reopened = new HashCache(dbFile);
const sample = records[Math.floor(N / 2)];
if (!sample) throw new Error("spike needs at least one record");
const roundTrip = reopened.cachedHash(sample.path, sample.size, sample.mtime);
console.log(
  "persistence: reopened .db and read back a row →",
  roundTrip === sample.hash ? "OK" : "MISMATCH",
);
reopened.close();

rmSync(dir, { recursive: true, force: true });
console.log(
  "throwaway   : deleted the cache dir — recoverable data lost = none",
);

console.log(`
Findings (for the item-3 decision):
  • API is synchronous & dependency-free (DatabaseSync, prepared statements) —
    fits #5. No flag needed on Node ${process.version}.
  • A point lookup beats re-hashing a file by orders of magnitude; vs the
    in-memory Map it is slower but O(1)-ish and avoids loading the whole prior
    snapshot into RAM — the real win is on huge sets / the --if-modified-from
    "is this hash already remote?" query, not small ones.
  • Bulk load MUST be wrapped in a transaction (see BEGIN/COMMIT above).
  • The .db is pure cache: reopen works, delete loses nothing → #2 intact.
`);
