import assert from "node:assert/strict";
import { hash } from "node:crypto";
import { utimes } from "node:fs/promises";
import { describe, it } from "node:test";
import { fileProps } from "./file-props.mjs";

/** @import { Props } from "./snapshot-file.mjs" */
/** @import { HashProgress, HashSource } from "./file-props.mjs" */

const FILE = "./test/fixtures/dir1/hello-world.txt";
const MTIME = new Date("2025-01-15T10:30:00.000Z");
const MTIME_ISO = "2025-01-15T10:30:00.000Z";
const HELLO_HASH =
  "c0535e4be2b79ffd93291305436bf889314e4a3faec05ecffcbb7df31ad9e51a";

/** A one-entry hash source, optionally carrying a change-time boundary. @returns {HashSource} */
const lookupOf = (
  /** @type {string} */ path,
  /** @type {Props} */ props,
  /** @type {number | undefined} */ baselineMs = undefined,
) => ({ entries: new Map([[path, props]]), baselineMs });

describe("fileProps", () => {
  it("hashes a file with no lookup", async () => {
    await utimes(FILE, MTIME, MTIME);

    const { hashDuration, ...props } = await fileProps(FILE);

    assert.deepEqual(props, { size: 12, mtime: MTIME_ISO, hash: HELLO_HASH });
    assert.ok(hashDuration !== undefined && hashDuration >= 0);
  });

  it("hashes a large file by streaming", async () => {
    const filePath = "./test/fixtures/dir1/10MB.txt";
    await utimes(filePath, MTIME, MTIME);

    const props = await fileProps(filePath);

    assert.equal(props.size, 10 * 1024 * 1024);
    assert.equal(
      props.hash,
      "eb6183addde05c2196ce25e6fa34a4baf20f9bf30d33892f452a9a1e88c9a472",
    );
  });

  it("reports onHashStart once, only on the streaming path", async () => {
    const filePath = "./test/fixtures/dir1/10MB.txt";
    await utimes(filePath, MTIME, MTIME);

    /** @type {HashProgress[]} */
    const started = [];
    const before = performance.now();
    const props = await fileProps(filePath, undefined, {
      onHashStart: (hashing) => started.push(hashing),
    });
    const after = performance.now();

    assert.equal(started.length, 1);
    const [hashing] = started;
    assert.equal(hashing?.size, 10 * 1024 * 1024);
    assert.ok(
      hashing && hashing.startedAt >= before && hashing.startedAt <= after,
    );
    // By the time fileProps resolves the stream is fully drained, so the
    // caller's own poll of `read()` — the one thing this interface exists to
    // report — must agree with the size just hashed.
    assert.equal(hashing?.read(), props.size);

    // The small fixture stays under the streaming threshold: no progress line
    // is worth drawing for a read that never yields the event loop.
    /** @type {HashProgress[]} */
    const smallStarted = [];
    await fileProps(FILE, undefined, {
      onHashStart: (hashing) => smallStarted.push(hashing),
    });
    assert.equal(smallStarted.length, 0);
  });

  it("hashes an empty file to the empty-content hash", async () => {
    const filePath = "./test/fixtures/dir1/zero-size";
    await utimes(filePath, MTIME, MTIME);

    const props = await fileProps(filePath);

    assert.deepEqual(
      { size: props.size, hash: props.hash },
      { size: 0, hash: hash("sha256", "", { outputEncoding: "hex" }) },
    );
  });

  it("reuses the stored hash when size and mtime are unchanged", async () => {
    await utimes(FILE, MTIME, MTIME);
    const stored = { size: 12, mtime: MTIME_ISO, hash: "reused-not-rehashed" };

    const props = await fileProps(FILE, lookupOf(FILE, stored));

    // The exact stored object is returned — proof it was never re-hashed (and
    // so carries no hashDuration, as snapshot entries don't).
    assert.equal(props, stored);
    assert.equal(props.hashDuration, undefined);
  });

  it("re-hashes when the size differs from the lookup", async () => {
    await utimes(FILE, MTIME, MTIME);
    const stale = { size: 999, mtime: MTIME_ISO, hash: "stale" };

    const props = await fileProps(FILE, lookupOf(FILE, stale));

    assert.equal(props.hash, HELLO_HASH);
    assert.equal(props.size, 12);
  });

  it("re-hashes when the mtime differs from the lookup", async () => {
    await utimes(FILE, MTIME, MTIME);
    const stale = {
      size: 12,
      mtime: "2000-01-01T00:00:00.000Z",
      hash: "stale",
    };

    const props = await fileProps(FILE, lookupOf(FILE, stale));

    assert.equal(props.hash, HELLO_HASH);
  });

  it("re-hashes a size+mtime match when the file was touched after the baseline", async () => {
    // The `touch -r` shape (ADR-0094): the utimes call just moved the file's
    // ctime to now, so a baseline instant in the past proves the match stale.
    await utimes(FILE, MTIME, MTIME);
    const stale = { size: 12, mtime: MTIME_ISO, hash: "stale" };

    const props = await fileProps(FILE, lookupOf(FILE, stale, MTIME.getTime()));

    assert.equal(props.hash, HELLO_HASH);
    assert.notEqual(props.hashDuration, undefined);
  });

  it("reuses a size+mtime match when the file's ctime predates the baseline", async () => {
    await utimes(FILE, MTIME, MTIME);
    const stored = { size: 12, mtime: MTIME_ISO, hash: "reused-not-rehashed" };

    // A baseline taken after the file was last touched vouches for the match.
    const afterCtime = Date.now() + 60_000;
    const props = await fileProps(FILE, lookupOf(FILE, stored, afterCtime));

    assert.equal(props, stored);
    assert.equal(props.hashDuration, undefined);
  });

  it("hashes when the path is absent from the lookup", async () => {
    await utimes(FILE, MTIME, MTIME);
    const other = { size: 1, mtime: MTIME_ISO, hash: "other" };

    const props = await fileProps(FILE, lookupOf("/some/other/path", other));

    assert.equal(props.hash, HELLO_HASH);
  });

  it("throws for a non-regular file", async () => {
    const path = "./test/fixtures/dir1"; // a directory
    await assert.rejects(fileProps(path), {
      message: `Not a regular file: ${path}`,
    });
  });
});
