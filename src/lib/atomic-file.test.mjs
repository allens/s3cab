import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdtempDisposable } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { describe, it } from "node:test";
import { writeFileAtomic } from "./atomic-file.mjs";

// writeFileAtomic takes its source stream as a parameter — that seam is what
// lets the atomicity + integrity logic run here against an in-memory stream
// with zero AWS and no mocks, on every push. The real-bucket happy path is
// covered by test/integration/backup-restore-roundtrip.test.mjs's gated round-trip (restore fetches
// every object through `getObject`, which composes this with the expected
// digest — the key).
describe("writeFileAtomic", () => {
  const mkTmpDir = async () => mkdtempDisposable(join("test", ".tmp"));
  const content = "the real object bytes";
  const hash = createHash("sha256").update(content).digest("hex");

  it("writes the file when its content matches the expected digest", async () => {
    await using dir = await mkTmpDir();
    const dest = join(dir.path, "out.bin");

    await writeFileAtomic(dest, Readable.from(content), { hash });

    assert.equal(readFileSync(dest, "utf8"), content);
    // No temp sibling left behind.
    assert.ok(!existsSync(join(dir.path, ".out.bin.s3cab-tmp")));
  });

  it("rejects a content/digest mismatch and places no file", async () => {
    await using dir = await mkTmpDir();
    const dest = join(dir.path, "out.bin");

    // The bytes don't hash to the expected digest — the silent-data-loss case
    // design #1 exists to catch. The throw must come before the rename.
    await assert.rejects(
      () =>
        writeFileAtomic(
          dest,
          Readable.from("tampered bytes, not the content"),
          {
            hash,
          },
        ),
      /Integrity check failed/,
    );
    // Atomicity is the only guarantee: nothing lands at destPath. The temp
    // sibling may remain (harmless) — cleanup isn't the contract, `rename` is.
    assert.ok(!existsSync(dest), "a mismatched file must not be placed");
  });

  it("copies verbatim (no digest check) when hash is not given", async () => {
    await using dir = await mkTmpDir();
    const dest = join(dir.path, "plain.txt");

    await writeFileAtomic(dest, Readable.from("any bytes at all"));

    assert.equal(readFileSync(dest, "utf8"), "any bytes at all");
    assert.ok(!existsSync(join(dir.path, ".plain.txt.s3cab-tmp")));
  });

  it("places no file at destPath when the source stream fails", async () => {
    await using dir = await mkTmpDir();
    const dest = join(dir.path, "out.bin");

    async function* failingSource() {
      yield "some bytes";
      throw new Error("connection reset");
    }
    await assert.rejects(
      () => writeFileAtomic(dest, Readable.from(failingSource())),
      /connection reset/,
    );
    // Same contract: the error propagates and nothing lands at destPath; a
    // leftover temp sibling is fine.
    assert.ok(!existsSync(dest), "a partial download must not be placed");
  });
});
