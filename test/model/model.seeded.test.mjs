import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { mkdtempDisposable } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import { zstdCompressSync, zstdDecompressSync } from "node:zlib";
import { DAY_MS } from "./harness/clock.mjs";
import { FakeS3, parseUri } from "./harness/fake-s3.mjs";
import { runSequence } from "./harness/runner.mjs";
import { generateSequence } from "./harness/sequence.mjs";
import { shrink } from "./harness/shrink.mjs";

/** @import { TestContext } from "node:test" */
/** @import { Step } from "./harness/sequence.mjs" */
/** @import { RunResult } from "./harness/runner.mjs" */

// The brief's proof obligation: a test harness is itself untested code, so
// seed deliberate bugs and confirm the harness (a) catches each one and
// (b) shrinks the repro to something a human can read. Each test installs one
// bug as a *prototype-level* patch on the fake — runSequence builds a fresh
// instance per run, so instance patching can't reach it — finds a failing
// sequence, shrinks it, asserts the shrunk repro is short and still fails the
// same way, then removes the bug and asserts the very same sequence passes,
// pinning the failure on the seeded bug rather than on harness flakiness.
//
// Two translation notes against the brief's bug list:
// - "an off-by-one in the hash comparison" is seeded as an off-by-one in the
//   content address the store files bytes under — the comparison's input. The
//   comparison itself (storedHashes' set membership) lives above the mocked
//   seam, and the false-"present" direction of a comparison bug needs two real
//   SHA-256 values one apart, which never occurs; shifting the stored key is
//   the same defect made observable.
// - "a cleanup that ignores one snapshot" is seeded in the LIST the sweep
//   marks from: the first manifest of every snapshots/ listing is invisible,
//   so cleanup treats that snapshot's objects as unreferenced orphans.
//
// Saboteur design rule: every seeded bug is *state-free* — keyed on the key or
// bytes it sees, never on call counts — so any shrunk subsequence reproduces
// it identically, which is the property delta-debugging leans on.

/** @typedef {{ steps: Step[], result: RunResult, shrunk: Step[], final: RunResult }} Caught */

/**
 * A fresh-root sequence runner over one disposable directory.
 * @param {string} rootPath
 * @returns {(steps: Step[]) => Promise<RunResult>}
 */
const makeRunFresh = (rootPath) => {
  let n = 0;
  return async (steps) => {
    const dir = join(rootPath, `run${n++}`);
    mkdirSync(dir, { recursive: true });
    try {
      return await runSequence(steps, dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
};

/**
 * Shrink a failing sequence and re-run the survivor.
 * @param {(steps: Step[]) => Promise<RunResult>} runFresh
 * @param {Step[]} steps
 * @param {RunResult} result
 * @returns {Promise<Caught>}
 */
async function shrinkAndRerun(runFresh, steps, result) {
  const shrunk = await shrink(steps, async (candidate) => {
    const rerun = await runFresh(candidate);
    return !rerun.ok;
  });
  const final = await runFresh(shrunk);
  return { steps, result, shrunk, final };
}

/**
 * Scan generated seeds for a sequence the seeded bug makes fail — the harness
 * operating exactly as it does in the sequences tier, no steering.
 * @param {(steps: Step[]) => Promise<RunResult>} runFresh
 * @param {number} maxSeed
 * @returns {Promise<Caught | null>}
 */
async function catchAndShrink(runFresh, maxSeed) {
  for (let seed = 1; seed <= maxSeed; seed++) {
    const steps = generateSequence(seed);
    const result = await runFresh(steps);
    if (!result.ok) {
      return shrinkAndRerun(runFresh, steps, result);
    }
  }
  return null;
}

/**
 * The shared judgement: caught, right violation class, shrunk short, still
 * failing the same way — and passing again once the bug is removed.
 * @param {TestContext} t
 * @param {(steps: Step[]) => Promise<RunResult>} runFresh
 * @param {Caught | null} caught
 * @param {RegExp} expect - The violation class the seeded bug must produce
 * @param {() => void} unpatch
 * @param {number} maxShrunk - Human-readability budget for the shrunk repro
 */
async function assertCaughtAndShrunk(
  t,
  runFresh,
  caught,
  expect,
  unpatch,
  maxShrunk,
) {
  assert.ok(caught, "the harness never tripped over the seeded bug");
  const { steps, result, shrunk, final } = caught;
  assert.match(result.violations.join("\n"), expect);
  assert.equal(final.ok, false, "the shrunk sequence no longer fails");
  assert.match(final.violations.join("\n"), expect);
  assert.ok(
    shrunk.length < steps.length,
    `shrinking removed nothing (${steps.length} steps in and out)`,
  );
  assert.ok(
    shrunk.length <= maxShrunk,
    `shrunk repro still has ${shrunk.length} steps (budget ${maxShrunk}):\n` +
      JSON.stringify(shrunk, null, 2),
  );
  t.diagnostic(
    `shrunk ${steps.length} → ${shrunk.length} steps: ` +
      shrunk.map((step) => step.kind).join(", "),
  );
  // Control: the same sequence with the bug removed must pass, or the failure
  // was the harness's own.
  unpatch();
  const control = await runFresh(shrunk);
  assert.equal(
    control.ok,
    true,
    `control run still fails without the seeded bug: ${control.violations.join("; ")}`,
  );
}

describe("seeded-bug proof (the harness catches, then shrinks)", () => {
  it(
    "catches a skipped upload (PUT claims success, stores nothing)",
    { timeout: 300_000 },
    async (t) => {
      await using root = await mkdtempDisposable(join("test", ".tmp"));
      const runFresh = makeRunFresh(root.path);
      const original = FakeS3.prototype.putFile;
      const unpatch = () => {
        FakeS3.prototype.putFile = original;
      };
      // The seeded bug: object PUTs whose hash starts 0–7 report success
      // without storing anything — the manifest then references thin air.
      FakeS3.prototype.putFile =
        /**
         * @this {FakeS3}
         * @param {string} path
         * @param {string} uri
         * @param {Parameters<FakeS3["putFile"]>[2]} [options]
         */
        async function (path, uri, options) {
          if (/\/objects\/[0-7]/.test(uri)) {
            return true;
          }
          return original.call(this, path, uri, options);
        };
      try {
        const caught = await catchAndShrink(runFresh, 8);
        await assertCaughtAndShrunk(
          t,
          runFresh,
          caught,
          /dangling reference|restore of .+ (threw|reported failure)/,
          unpatch,
          6,
        );
      } finally {
        unpatch();
      }
    },
  );

  it(
    "catches an off-by-one in the content address (bytes filed one hash over)",
    { timeout: 300_000 },
    async (t) => {
      await using root = await mkdtempDisposable(join("test", ".tmp"));
      const runFresh = makeRunFresh(root.path);
      const original = FakeS3.prototype.putFile;
      const unpatch = () => {
        FakeS3.prototype.putFile = original;
      };
      // The seeded bug: every object lands under a key whose last hex digit is
      // one too high, so no stored object's bytes hash to its name.
      FakeS3.prototype.putFile =
        /**
         * @this {FakeS3}
         * @param {string} path
         * @param {string} uri
         * @param {Parameters<FakeS3["putFile"]>[2]} [options]
         */
        async function (path, uri, options) {
          if (/\/objects\/[0-9a-f]{64}$/.test(uri)) {
            const last = (parseInt(uri.slice(-1), 16) + 1) % 16;
            uri = uri.slice(0, -1) + last.toString(16);
          }
          return original.call(this, path, uri, options);
        };
      try {
        const caught = await catchAndShrink(runFresh, 8);
        await assertCaughtAndShrunk(
          t,
          runFresh,
          caught,
          /content-address violation|dangling reference/,
          unpatch,
          6,
        );
      } finally {
        unpatch();
      }
    },
  );

  it(
    "catches a cleanup that ignores one snapshot's references",
    { timeout: 300_000 },
    async (t) => {
      await using root = await mkdtempDisposable(join("test", ".tmp"));
      const runFresh = makeRunFresh(root.path);
      const original = FakeS3.prototype.listObjects;
      const unpatch = () => {
        FakeS3.prototype.listObjects = original;
      };
      // The seeded bug: the first manifest of every whole-store `snapshots/`
      // listing is invisible, so the sweep's mark phase never sees that
      // snapshot and reaps its (aged) objects as orphans. Keyed to the bare
      // prefix — the union scan cleanup (and verify) mark from
      // (lib/remote.mjs) — so restore's set-scoped `snapshots/<set>/`
      // listings stay honest and the damage lands as cleanup's bad sweep,
      // as the brief's bug would. (verify shares the blinded scan, but with
      // the store healthy pre-cleanup both verdicts are clean either way.)
      FakeS3.prototype.listObjects =
        /**
         * @this {FakeS3}
         * @param {string} uri
         */
        async function* (uri) {
          let hidden = parseUri(uri).key !== "snapshots/";
          for await (const object of original.call(this, uri)) {
            if (!hidden && object.Key?.endsWith(".tsv.zst")) {
              hidden = true;
              continue;
            }
            yield object;
          }
        };
      // Handcrafted rather than seed-scanned: the bug only fires once a
      // snapshot's objects age past the 7-day grace window *and* a cleanup
      // follows, a conjunction rare enough under the generator's step mix that
      // scanning for it would blow the per-commit budget. The noise steps are
      // there for the shrinker to remove.
      const steps = /** @type {Step[]} */ ([
        { kind: "create-set", machine: 0, set: "col", seedFiles: [3, 5] },
        { kind: "verify" },
        { kind: "backup", machine: 0, set: "col" },
        { kind: "mutate", set: "col", file: "f2.txt", content: 6 },
        { kind: "restore", machine: 0, set: "col", index: 0 },
        { kind: "advance", ms: 8 * DAY_MS },
        { kind: "snapshot", machine: 0, set: "col" },
        { kind: "verify" },
        { kind: "cleanup" },
        { kind: "restore", machine: 0, set: "col", index: 0 },
      ]);
      try {
        const result = await runFresh(steps);
        assert.equal(result.ok, false, "the seeded cleanup bug went uncaught");
        const caught = await shrinkAndRerun(runFresh, steps, result);
        await assertCaughtAndShrunk(
          t,
          runFresh,
          caught,
          /dangling reference/,
          unpatch,
          5,
        );
      } finally {
        unpatch();
      }
    },
  );

  it(
    "catches a path normalisation error (manifest paths case-folded)",
    { timeout: 300_000 },
    async (t) => {
      await using root = await mkdtempDisposable(join("test", ".tmp"));
      const runFresh = makeRunFresh(root.path);
      const original = FakeS3.prototype.putFile;
      const unpatch = () => {
        FakeS3.prototype.putFile = original;
      };
      /**
       * Uppercase the first letter of a manifest row's basename — what a
       * broken case-normaliser in the manifest writer would do.
       * @param {string} line
       */
      const mangleRow = (line) => {
        if (line === "" || line.trimStart().startsWith("#")) {
          return line;
        }
        const fields = line.split("\t");
        if (fields.length < 4) {
          return line;
        }
        const path = fields.slice(3).join("\t");
        const cut = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1;
        const mangled =
          path.slice(0, cut) +
          path.charAt(cut).toUpperCase() +
          path.slice(cut + 1);
        return [...fields.slice(0, 3), mangled].join("\t");
      };
      FakeS3.prototype.putFile =
        /**
         * @this {FakeS3}
         * @param {string} path
         * @param {string} uri
         * @param {Parameters<FakeS3["putFile"]>[2]} [options]
         */
        async function (path, uri, options) {
          const stored = await original.call(this, path, uri, options);
          const { bucket, key } = parseUri(uri);
          if (stored && /^snapshots\/.+\.tsv\.zst$/.test(key)) {
            const bytes = /** @type {Buffer} */ (
              await this.getBytes(bucket, key)
            );
            const text = zstdDecompressSync(bytes).toString("utf8");
            const mangled = text.split("\n").map(mangleRow).join("\n");
            await this.putBytes(
              bucket,
              key,
              zstdCompressSync(Buffer.from(mangled)),
            );
          }
          return stored;
        };
      try {
        const caught = await catchAndShrink(runFresh, 8);
        await assertCaughtAndShrunk(
          t,
          runFresh,
          caught,
          / is missing | invented /,
          unpatch,
          6,
        );
      } finally {
        unpatch();
      }
    },
  );
});
