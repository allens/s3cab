import assert from "node:assert";
import { createHash } from "node:crypto";

// Reference spike (kept, not shipped — scripts/ convention in CLAUDE.md).
//
// Design question: can snapshot *generation* (phase 2: stat + hash) and *upload*
// (phase 3: PUT each object) be fused into one streaming pass, so a file's bytes
// are uploaded within milliseconds of being hashed rather than minutes later?
// The gap between those two moments is the entire cause of the "file changed
// since it was snapshotted" hard-fail (autosave of an open Word doc mid-backup —
// see proposals/fused-snapshot-upload.md and the drift guard in src/lib/upload.mjs).
//
// Finding: yes, and cleanly. The fused upload is a single pass-through transform
// inserted into the pipeline writeSnapshot *already* runs today
// (src/lib/snapshot-file.mjs): `files -> propsRows(getProps) -> stringifySnapshot
// -> writeStream` simply becomes `... -> propsRows -> uploadObjects(store) ->
// stringifySnapshot -> writeStream`. The producer (hashing) and the sink (TSV)
// are unchanged and shared; `backup` inserts the stage, `snapshot` omits it.
//
// This file models that with a fake in-memory store and fake files so it runs
// with plain `node scripts/fused-snapshot-upload-spike.mjs` — no S3, no bucket,
// no Temporal. It mirrors the real row shape (`[path, Props]`) and composes the
// same async-generator stages; production wires them with stream/promises
// `pipeline` exactly as writeSnapshot does. Cross-object upload concurrency is a
// deliberate non-goal (the SDK's multipart Upload already parallelizes big files;
// small-file latency is the only gap, addable at the one `uploadObjects` seam
// later) — so uploads here are a plain sequential `await`, zero look-ahead.

/** @typedef {{ hash: string, size: number, mtime: string }} Props */
/** @typedef {[string, Props]} Row */
/**
 * @typedef {Object} Store
 * @property {(hash: string) => boolean} has - Is this content already stored?
 * @property {(hash: string, path: string) => Promise<void>} put - Store it.
 * @property {string[]} puts - What actually got uploaded (for the report).
 */

// A fake filesystem: two of these files hold identical content, so the run
// demonstrates content-addressed dedup (one PUT for both paths).
const fakeFs = new Map([
  ["/photos/a.jpg", "AAAA"],
  ["/photos/copy-of-a.jpg", "AAAA"], // same bytes as a.jpg -> same hash
  ["/docs/report.txt", "BBBB"],
  ["/docs/notes.txt", "CCCC"],
]);

/**
 * Stand-in for lib/file-props.mjs `fileProps`: one stat + (conditional) hash.
 * Here it just hashes the fake content; the real one reuses a previous
 * snapshot's hash when size+mtime are unchanged.
 * @param {string} path
 * @returns {Props}
 */
function fakeProps(path) {
  const content = fakeFs.get(path) ?? "";
  return {
    hash: createHash("sha256").update(content).digest("hex"),
    size: Buffer.byteLength(content),
    mtime: "2026-07-28T09:00:00.000Z",
  };
}

/**
 * The producer (phase 2): paths -> hashed rows. Stands in for
 * `propsRows(getProps)` over the walk in src/lib/snapshot-file.mjs.
 * @param {Iterable<string>} files
 * @param {(path: string) => Props} getProps
 * @returns {AsyncGenerator<Row>}
 */
async function* generateEntries(files, getProps) {
  for (const path of files) {
    yield [path, getProps(path)];
  }
}

/**
 * The fused upload stage (phase 3), the whole point of the spike: a pass-through
 * transform that PUTs each object right after it was hashed, then yields the row
 * on to the TSV sink unchanged. `seen` dedups within the run (first path wins,
 * one PUT per hash — planUpload's rule); `store.has` skips content already in the
 * bucket. Drop this stage and you have a plain offline snapshot.
 * @param {Store} store
 * @returns {(rows: AsyncIterable<Row>) => AsyncGenerator<Row>}
 */
function uploadObjects(store) {
  return async function* (rows) {
    /** @type {Set<string>} */
    const seen = new Set();
    for await (const [path, props] of rows) {
      if (!store.has(props.hash) && !seen.has(props.hash)) {
        await store.put(props.hash, path); // window between hash and PUT ~= 0
        seen.add(props.hash);
      }
      yield [path, props];
    }
  };
}

/**
 * The sink: rows -> TSV lines. Stands in for `stringifySnapshot` in
 * src/lib/snapshot-file.mjs, which already consumes exactly this row shape.
 * @param {AsyncIterable<Row>} rows
 * @returns {AsyncGenerator<string>}
 */
async function* stringify(rows) {
  for await (const [path, { hash, size, mtime }] of rows) {
    yield `${hash.slice(0, 8)}\t${size}\t${mtime}\t${path}`;
  }
}

/**
 * The coordinator. `snapshot` drives producer -> sink; `backup` inserts the
 * upload stage between them. One producer, one sink, shared by both — the only
 * difference is whether `store` is present.
 * @param {Iterable<string>} files
 * @param {(path: string) => Props} getProps
 * @param {Store} [store] - Present for `backup`, absent for a plain `snapshot`
 * @returns {Promise<string[]>} The snapshot TSV lines
 */
async function drive(files, getProps, store) {
  const source = generateEntries(files, getProps);
  const rows = store ? uploadObjects(store)(source) : source;
  /** @type {string[]} */
  const lines = [];
  for await (const line of stringify(rows)) {
    lines.push(line);
  }
  // Objects-first/snapshot-last: only *after* this loop drains (every object
  // PUT) does the coordinator upload the snapshot manifest itself. In the spike
  // that final PUT is elided; the ordering is what matters.
  return lines;
}

/**
 * A fake bucket that records what it stored, for the report.
 * @returns {Store}
 */
function reportStore() {
  /** @type {Set<string>} */
  const stored = new Set();
  /** @type {string[]} */
  const puts = [];
  return {
    has: (hash) => stored.has(hash),
    put: async (hash, path) => {
      stored.add(hash);
      puts.push(`${hash.slice(0, 8)}  ${path}`);
    },
    puts,
  };
}

async function main() {
  const files = [...fakeFs.keys()];

  // `snapshot`: producer -> sink, no cloud touched.
  const snapshotLines = await drive(files, fakeProps);

  // `backup`: producer -> uploadObjects -> sink, same producer and sink.
  const store = reportStore();
  const backupLines = await drive(files, fakeProps, store);

  console.log("snapshot TSV (offline):");
  console.log(snapshotLines.map((l) => "  " + l).join("\n"));

  console.log("\nbackup uploaded these objects, inline during generation:");
  console.log(store.puts.map((p) => "  " + p).join("\n"));

  // The two files with identical bytes uploaded once (4 files, 3 distinct hashes).
  assert.equal(store.puts.length, 3, "expected one PUT per distinct hash");
  // The manifest is byte-identical whether or not we uploaded — fusing changes
  // *when* objects ship, never *what* the snapshot records.
  assert.deepEqual(
    snapshotLines,
    backupLines,
    "backup manifest must equal the offline snapshot manifest",
  );

  console.log(
    "\nOK: 4 files -> 3 PUTs (dedup); manifest identical in both modes.",
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
