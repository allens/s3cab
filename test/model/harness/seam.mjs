import { mock } from "node:test";
import * as format from "../../../src/lib/format.mjs";

/** @import { FakeS3 } from "./fake-s3.mjs" */
import { clockHolder } from "./clock.mjs";
import { backendHolder } from "./fake-s3.mjs";

// The Tier 1 seam: mocks `s3.mjs` (ADR-0019's designated fake point) and
// `format.mjs` (to route the minute-precision snapshot clock to the virtual
// one), then imports the commands *through* those mocks and re-exports them.
// Everything the harness drives or inspects must come from here — a static
// import of a command anywhere else in the process binds the real modules
// first, and mock.module cannot rebind it.
//
// Both mocks read through mutable holders (`backendHolder`, `clockHolder`), so
// each sequence installs a fresh backend/clock without re-registering mocks
// (mock.module is once-per-process). Requires `--experimental-test-module-mocks`.

/**
 * Local copies of s3.mjs's two error matchers (same `name`-keyed semantics),
 * so the mock doesn't import the real module — which would load the AWS SDK
 * into every Tier 1 run for two one-liners.
 * @param {unknown} error
 * @returns {boolean}
 */
const isObjectNotFound = (error) =>
  Error.isError(error) &&
  (error.name === "NoSuchKey" || error.name === "NotFound");

/**
 * @param {unknown} error
 * @returns {boolean}
 */
const isPreconditionFailed = (error) =>
  Error.isError(error) && error.name === "PreconditionFailed";

mock.module("../../../src/lib/format.mjs", {
  exports: {
    ...format,
    /** @type {typeof format.localMoment} */
    localMoment: (smallestUnit) =>
      clockHolder.current.localMoment(smallestUnit),
  },
});

mock.module("../../../src/lib/s3.mjs", {
  exports: {
    listObjects: (/** @type {string} */ uri) =>
      backendHolder.current.listObjects(uri),
    getStream: (/** @type {string} */ uri) =>
      backendHolder.current.getStream(uri),
    putFile: (
      /** @type {string} */ path,
      /** @type {string} */ uri,
      /** @type {Parameters<FakeS3["putFile"]>[2]} */ options,
    ) => backendHolder.current.putFile(path, uri, options),
    putText: (
      /** @type {string} */ uri,
      /** @type {string} */ content,
      /** @type {{ noClobber?: boolean }} */ options,
    ) => backendHolder.current.putText(uri, content, options),
    getText: (/** @type {string} */ uri) => backendHolder.current.getText(uri),
    objectExists: (/** @type {string} */ uri) =>
      backendHolder.current.objectExists(uri),
    deleteObject: (/** @type {string} */ uri) =>
      backendHolder.current.deleteObject(uri),
    // Imported by objects.mjs (delete's preflight); the model doesn't drive
    // `delete`, so no sequence reaches it.
    objectSize: async () => undefined,
    isObjectNotFound,
    isPreconditionFailed,
  },
});

// Everything below is imported through the mocks — the ADR-0019 seam is now
// the fake, and every snapshot name below it is minted from the virtual clock.

export const { setup } = await import("../../../src/commands/setup.mjs");
export const { backup } = await import("../../../src/commands/backup.mjs");
export const { snapshot } = await import("../../../src/commands/snapshot.mjs");
export const { restore } = await import("../../../src/commands/restore.mjs");
export const { verify } = await import("../../../src/commands/verify.mjs");
export const { forget } = await import("../../../src/commands/forget.mjs");
export const { cleanup } = await import("../../../src/commands/cleanup.mjs");
export const { reattach } = await import("../../../src/commands/reattach.mjs");
export const { upload } = await import("../../../src/commands/upload.mjs");

export const { writeSet, readSet } = await import("../../../src/lib/sets.mjs");
export const {
  listSnapshotNames,
  readSnapshot,
  parseCompressedSnapshotStream,
} = await import("../../../src/lib/snapshot-file.mjs");
