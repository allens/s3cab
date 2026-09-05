// The `s3.mjs` seam as a stencil, for the co-located unit tests that reach it
// through `mock.module` (ADR-0019 designates s3.mjs as the fake point; ADR-0049
// keeps those tests beside their module). Not a store: it holds no state and
// models no bucket. Its job is to spell the seam's surface once, so a test
// declares only the methods it actually models.
//
// Deliberately *not* the model tier's fake. test/model/harness/fake-s3.mjs is a
// real in-memory backend with a keyspace, a virtual clock, fault injection and a
// declared capability set (test/model/CAPABILITIES.md); this is a per-test
// object literal with defaults. The tiers differ on purpose and neither should
// grow into the other.
//
// **The defaults are asymmetric, and that is the point.** CAPABILITIES.md's
// prime rule for fakes — *declare only what you truly model; an optimistic fake
// that claims what it fakes poorly is how a suite passes against broken code* —
// cuts differently on the two sides of the seam:
//
//   - **Reads default to an empty store.** Nothing is listed, no text or size
//     comes back, and a GET stream throws `NoSuchKey`. That is not a claim, it
//     is a coherent state, and every part of it is falsifiable: a test that
//     expected content gets none and fails. (It is also load-bearing for
//     `backup`: with every remote snapshot absent, ADR-0084's baseline-identity
//     probe trusts no baseline and the pass LISTs the store.)
//   - **Writes default to a throw.** There is no truthful zero state for a PUT
//     or a DELETE, and a silent `putFile: async () => true` is the one default
//     that can make broken production code pass — ADR-0083 put the
//     streamed-digest guard *inside* `putFile`. A test that needs a write to
//     succeed says so at its own site.
//
// A method a test never calls needs no mention either way: the default keeps
// the module linking, and never runs.

/**
 * The seam's surface: exactly the `s3.mjs` exports production code imports,
 * derived from the real module so a default whose signature drifts from
 * production's fails `npm run typecheck` instead of at runtime in whichever
 * test happens to call it. `test/s3-seam.test.mjs` keeps the name list honest.
 * @typedef {Pick<
 *   typeof import("../../src/lib/s3.mjs"),
 *   | "bucketPolicy"
 *   | "deleteObject"
 *   | "getStream"
 *   | "getText"
 *   | "isObjectNotFound"
 *   | "listObjects"
 *   | "objectSize"
 *   | "putFile"
 *   | "putText"
 * >} S3Seam
 */

/**
 * A method the seam does not model. An internal invariant, not user-facing
 * text, so it is terse and factual (ADR-0030's out-of-scope half) and a plain
 * `Error` — nothing catches it by type.
 * @param {string} method
 * @returns {() => never}
 */
const notModelled = (method) => () => {
  throw new Error(`s3Seam: ${method} is not modelled by this test`);
};

/**
 * The SDK's absent-object error, spelled as `isObjectNotFound` recognizes it —
 * so the empty store's `getStream` and the default predicate below agree.
 * Mirrors fake-s3.mjs's `noSuchKey`.
 * @param {string} uri
 */
const noSuchKey = (uri) =>
  Object.assign(new Error(`The specified key does not exist: ${uri}`), {
    name: "NoSuchKey",
  });

/**
 * A fake of the `s3.mjs` seam for `mock.module`, defaulting to an empty store
 * on the read side and a throw on the write side (see the header).
 *
 * ```js
 * mock.module("../lib/s3.mjs", {
 *   exports: s3Seam({ putFile: async (path, uri) => (putUris.push(uri), true) }),
 * });
 * ```
 * @param {Partial<S3Seam>} [overrides] - What this test models, by method.
 * @returns {S3Seam}
 */
export function s3Seam(overrides = {}) {
  return {
    // An empty store: nothing stored, nothing to read.
    listObjects: async function* () {},
    getText: async () => undefined,
    objectSize: async () => undefined,
    getStream: async (/** @type {string} */ uri) => {
      throw noSuchKey(uri);
    },
    // The real predicate, spelled once. Name-based like s3.mjs's (unit-tested
    // in src/lib/s3.test.mjs), so absence round-trips through the same check
    // production uses — including the `getStream` default above.
    isObjectNotFound: (/** @type {unknown} */ error) =>
      Error.isError(error) &&
      (error.name === "NoSuchKey" || error.name === "NotFound"),
    // Writes, and the one pure export: unmodelled until a test says otherwise.
    putFile: notModelled("putFile"),
    putText: notModelled("putText"),
    deleteObject: notModelled("deleteObject"),
    bucketPolicy: notModelled("bucketPolicy"),
    ...overrides,
  };
}
