import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it, mock } from "node:test";

// The multipart tuning ADR-0060 settled — partSize 16 MiB, queueSize 32 — is a
// *performance* decision, and throughput is the one thing a unit test cannot
// observe. `queueSize` especially is invisible on the wire below 32 parts: to
// watch 32 concurrent UploadParts you would need a ≥512 MiB body, and
// lib-storage would buffer partSize × queueSize = 512 MiB to serve it. A
// half-gigabyte unit test buys nothing, so this pins the decision where it is
// free — the arguments `putFile` hands the uploader.
//
// A deliberate guard, not coverage theatre: drop `queueSize` from putFile and
// every upload silently falls back to lib-storage's default of 4, roughly
// halving throughput on every link measured, with nothing else in the suite
// failing. `partSize` is *additionally* pinned behaviourally by the loopback
// suite in s3.test.mjs, whose fixtures are cut from the same constant.
//
// Ordering rule (as in objects.test.mjs): a static import would bind the real
// lib-storage before the mock is registered, so s3.mjs is imported dynamically
// below and there is deliberately no static import of it.

/** @type {any} The arguments the last constructed Upload received. */
let uploadArgs;

mock.module("@aws-sdk/lib-storage", {
  exports: {
    Upload: class {
      /** @param {any} args */
      constructor(args) {
        uploadArgs = args;
        // The real Upload consumes the body; nothing here does. A ReadStream
        // opens lazily, so without this it opens *after* teardown removed the
        // file and the ENOENT surfaces as an uncaught exception. Handle the
        // error before destroying — destroy alone does not cancel the open.
        args.params?.Body?.on?.("error", () => {});
        args.params?.Body?.destroy?.();
      }
      on() {}
      async done() {}
    },
  },
});

const { putFile } = await import("./s3.mjs");

const MiB = 1024 * 1024;

describe("putFile multipart tuning (ADR-0060)", () => {
  /** @type {string} */
  let dir;
  /** @type {string} */
  let file;

  before(() => {
    dir = mkdtempSync(join(tmpdir(), "s3cab-tuning-"));
    file = join(dir, "x.bin");
    writeFileSync(file, "content");
    // client() refuses to build before env is loaded (ADR-0022); this suite
    // never reaches the network — the uploader is mocked — so the breadcrumb is
    // all it needs.
    process.env.__S3CAB_ENV_LOADED = "1";
    // client() announces the identity once and putFile logs a summary line when
    // stderr is not a TTY; neither is under test here.
    mock.method(console, "warn", () => {});
  });

  after(() => {
    rmSync(dir, { recursive: true, force: true });
    delete process.env.__S3CAB_ENV_LOADED;
    // The global `mock` (unlike a test's `t.mock`) is never auto-restored, so
    // the console.warn stub would outlive this suite and silently swallow
    // warnings from anything added to this file later.
    mock.restoreAll();
  });

  it("drives the uploader with 16 MiB parts, 32 concurrent — 512 MiB in flight", async () => {
    await putFile(file, "s3://bucket/key");

    // The two measured values. Their product is what actually matters: the bytes
    // in flight, which must cover the link's bandwidth-delay product before the
    // pipe fills (ADR-0060). Asserted separately so a failure names which half
    // moved, and jointly so the 512 MiB ceiling — the point past which measured
    // throughput got *worse*, not just memory-hungrier — is pinned too.
    assert.equal(uploadArgs.partSize, 16 * MiB);
    assert.equal(uploadArgs.queueSize, 32);
    assert.equal(uploadArgs.partSize * uploadArgs.queueSize, 512 * MiB);
  });
});
