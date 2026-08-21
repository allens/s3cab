import assert from "node:assert/strict";
import { hash } from "node:crypto";
import { utimes } from "node:fs/promises";
import { describe, it } from "node:test";
import { fileProps } from "./file-props.mjs";

/** @import { Props } from "./snapshot-file.mjs" */
/** @import { HashSource } from "./file-props.mjs" */

const FILE = "./test/fixtures/dir1/hello-world.txt";
const MTIME = new Date("2025-01-15T10:30:00.000Z");
const MTIME_ISO = "2025-01-15T10:30:00.000Z";
const HELLO_HASH =
  "c0535e4be2b79ffd93291305436bf889314e4a3faec05ecffcbb7df31ad9e51a";

/** A one-entry hash source, optionally carrying a trust boundary. @returns {HashSource[]} */
const lookupOf = (
  /** @type {string} */ path,
  /** @type {Props} */ props,
  /** @type {number | undefined} */ baselineMs = undefined,
) => [{ entries: new Map([[path, props]]), baselineMs }];

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
    // The `touch -r` shape (ADR-0085): the utimes call just moved the file's
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

  it("judges each source against its own boundary, not one shared instant", async () => {
    // The parked-hashes regression (ADR-0067 + ADR-0085). The interrupted run
    // hashed this file moments ago, so its ctime is *now* — later than the
    // previous snapshot, earlier than the parking. Merged into one map there was
    // a single boundary to judge both by, and it was the older one, so the
    // parked hash was thrown away and the resume re-hashed what it had saved.
    await utimes(FILE, MTIME, MTIME);
    const parked = { size: 12, mtime: MTIME_ISO, hash: "parked-hash" };
    const older = { size: 12, mtime: MTIME_ISO, hash: "previous-hash" };

    const props = await fileProps(FILE, [
      { entries: new Map([[FILE, parked]]), baselineMs: Date.now() + 60_000 },
      { entries: new Map([[FILE, older]]), baselineMs: MTIME.getTime() },
    ]);

    assert.equal(props, parked);
    assert.equal(props.hashDuration, undefined);
  });

  it("falls through a source that doesn't know the path", async () => {
    await utimes(FILE, MTIME, MTIME);
    const stored = { size: 12, mtime: MTIME_ISO, hash: "reused-not-rehashed" };

    const props = await fileProps(FILE, [
      { entries: new Map(), baselineMs: Date.now() + 60_000 },
      { entries: new Map([[FILE, stored]]), baselineMs: Date.now() + 60_000 },
    ]);

    assert.equal(props, stored);
  });

  it("reports why it re-read the file", async () => {
    await utimes(FILE, MTIME, MTIME);
    const changed = { size: 999, mtime: MTIME_ISO, hash: "stale" };
    const untrusted = { size: 12, mtime: MTIME_ISO, hash: "stale" };

    // `utimes` above moved the ctime to now, so a boundary in the past vetoes
    // the size+mtime match — and re-reading the file on an ordinary filesystem
    // leaves the ctime alone, which is what separates `ctime` from the
    // `ctime-on-read` a sync-filtered volume produces.
    const reasons = await Promise.all([
      fileProps(FILE, lookupOf(FILE, changed)),
      fileProps(FILE, lookupOf(FILE, untrusted, MTIME.getTime())),
      fileProps(FILE, lookupOf("/some/other/path", changed)),
      fileProps(FILE, lookupOf(FILE, { ...untrusted }, Date.now() + 60_000)),
    ]).then((all) => all.map((props) => props.rehashReason));

    assert.deepEqual(reasons, ["changed", "ctime", undefined, undefined]);
  });

  it("throws for a non-regular file", async () => {
    const path = "./test/fixtures/dir1"; // a directory
    await assert.rejects(fileProps(path), {
      message: `Not a regular file: ${path}`,
    });
  });
});
