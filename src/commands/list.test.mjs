import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtempDisposable } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { writeSet } from "../lib/sets.mjs";
import { list } from "./list.mjs";
import { useTempHome } from "../../test/helpers/temp-home.mjs";

// Tests for the list command (docs/specs/backup.md, ADR-0036). All offline: the
// local-snapshot paths (every set compactly, a named set in detail, --latest)
// need no network. The --remote path lists S3 and is covered by the gated suites
// that exercise the cloud round-trip. The set store keeps no module state, so
// each test points S3CAB_HOME at a temp dir.

const mkTmpDir = async () => mkdtempDisposable(join("test", ".tmp"));

/** @type {NodeJS.ProcessEnv} */
let savedEnv;
beforeEach(() => {
  savedEnv = { ...process.env };
});
afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in savedEnv)) delete process.env[key];
  }
  Object.assign(process.env, savedEnv);
});

/**
 * Create a set on disk with the given snapshot names — drops empty `.tsv.zst`
 * files into the set's snapshot dir, which is all `list` reads to name them.
 * @param {string} name
 * @param {string[]} dirs
 * @param {string} bucket
 * @param {string[]} snapshots - snapshot names, e.g. `2026-06-12T0915`
 */
function seedSet(name, dirs, bucket, snapshots) {
  const set = writeSet(name, { dirs, bucket });
  mkdirSync(set.snapshotsDir, { recursive: true });
  for (const snap of snapshots) {
    writeFileSync(join(set.snapshotsDir, `${snap}.tsv.zst`), "");
  }
}

/**
 * Capture stdout + console.warn for one test (t.mock auto-restores).
 * @param {import("node:test").TestContext} t
 */
function capture(t) {
  /** @type {string[]} */
  const out = [];
  /** @type {string[]} */
  const warn = [];
  t.mock.method(process.stdout, "write", (/** @type {unknown} */ chunk) => {
    out.push(String(chunk));
    return true;
  });
  t.mock.method(console, "warn", (/** @type {unknown[]} */ ...args) => {
    warn.push(args.join(" "));
  });
  return { out: () => out.join(""), warn: () => warn.join("\n") };
}

describe("list", () => {
  it("warns (on stderr) when there are no sets yet, leaving stdout empty", async (t) => {
    await using dir = await mkTmpDir();
    useTempHome(dir.path);
    const io = capture(t);

    const result = await list();

    assert.equal(result, undefined);
    assert.equal(io.out(), "");
    assert.match(
      io.warn(),
      /No backup sets yet[\s\S]*s3cab setup <set> <directory>\.\.\. --bucket <bucket>/,
    );
  });

  it("lists every set compactly (name + snapshot times), newest first", async (t) => {
    await using dir = await mkTmpDir();
    useTempHome(dir.path);
    seedSet("photos", ["/data/photos"], "my-bucket", [
      "2026-06-11T0915",
      "2026-06-12T0915",
    ]);
    seedSet("docs", ["/data/docs"], "my-bucket", ["2026-05-12T0946"]);
    const io = capture(t);

    await list();
    const out = io.out();

    // Compact form: a `name:` heading then indented times — no bucket/folders.
    assert.match(out, /docs:\n {2}2026-05-12T0946/);
    assert.match(
      out,
      /photos:\n {2}2026-06-12T0915\n {2}2026-06-11T0915/, // newest first
    );
    assert.doesNotMatch(out, /s3:\/\//); // the compact form omits the bucket
    assert.doesNotMatch(out, /\/data\/photos/); // …and the folders
  });

  it("shows '(none yet)' for a set with no snapshots", async (t) => {
    await using dir = await mkTmpDir();
    useTempHome(dir.path);
    seedSet("empty", ["/data/empty"], "my-bucket", []);
    const io = capture(t);

    await list();

    assert.match(io.out(), /empty:\n {2}\(none yet\)/);
  });

  it("with --latest shows only each set's most recent snapshot", async (t) => {
    await using dir = await mkTmpDir();
    useTempHome(dir.path);
    seedSet("photos", ["/data/photos"], "my-bucket", [
      "2026-06-11T0915",
      "2026-06-12T0915",
    ]);
    const io = capture(t);

    await list(undefined, { latest: true });
    const out = io.out();

    assert.match(out, /photos:\n {2}2026-06-12T0915/);
    assert.doesNotMatch(out, /2026-06-11T0915/); // the older one is dropped
  });

  it("a named set shows its full config (target, directories, exclude file) above its snapshots", async (t) => {
    await using dir = await mkTmpDir();
    useTempHome(dir.path);
    seedSet("docs", ["/data/docs"], "my-bucket", ["2026-05-12T0946"]);
    seedSet("photos", ["/data/photos"], "other-bucket", ["2026-06-12T0915"]);
    const io = capture(t);

    await list("docs");
    const out = io.out();

    // Labeled detail view: name, bucket, dirs (with the dirs.txt path), the
    // exclude file path, then the snapshot. The config paths let a terminal open
    // the files; assert each is the named set's absolute path.
    assert.match(out, /name: docs/);
    assert.match(out, /bucket: my-bucket/);
    assert.match(out, /dirs \(.*docs.dirs\.txt\):\n {2}\/data\/docs/);
    assert.match(out, /exclude file: .*docs.exclude\.txt/);
    assert.match(out, /snapshots:\n {2}2026-05-12T0946/);
    // Only the named set — the other set is absent.
    assert.doesNotMatch(out, /photos|other-bucket/);
  });

  it("rejects an unknown named set", async () => {
    await using dir = await mkTmpDir();
    useTempHome(dir.path);
    seedSet("photos", ["/data/photos"], "my-bucket", []);

    await assert.rejects(() => list("nope"), /Unknown backup set: nope/);
  });
});
