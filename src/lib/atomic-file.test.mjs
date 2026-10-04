import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { mkdtempDisposable } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { describe, it } from "node:test";
import { writeFileAtomic } from "./atomic-file.mjs";
import { IntegrityError } from "./error.mjs";

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
    assert.deepEqual(readdirSync(dir.path), ["out.bin"]);
  });

  it("rejects a content/digest mismatch and leaves no file behind", async () => {
    await using dir = await mkTmpDir();
    const dest = join(dir.path, "out.bin");

    // The bytes don't hash to the expected digest — the silent-data-loss case
    // design #1 exists to catch. The throw must come before the rename, and be
    // the type `restore` catches to carry on past one corrupt object.
    await assert.rejects(
      () =>
        writeFileAtomic(
          dest,
          Readable.from("tampered bytes, not the content"),
          {
            hash,
          },
        ),
      (error) =>
        error instanceof IntegrityError &&
        /Integrity check failed/.test(error.message),
    );
    // Nothing is placed, and the known-bad bytes don't survive in the temp: a
    // restore that carries on would otherwise finish with one beside every
    // corrupt file.
    assert.deepEqual(readdirSync(dir.path), []);
  });

  it("copies verbatim (no digest check) when hash is not given", async () => {
    await using dir = await mkTmpDir();
    const dest = join(dir.path, "plain.txt");

    await writeFileAtomic(dest, Readable.from("any bytes at all"));

    assert.equal(readFileSync(dest, "utf8"), "any bytes at all");
    assert.deepEqual(readdirSync(dir.path), ["plain.txt"]);
  });

  it("writes a file whose name is close to the filesystem's length limit", async () => {
    await using dir = await mkTmpDir();
    // 250 is legal on NTFS (255 UTF-16 units) and ext4 (255 bytes), but a
    // temp name that grows with it would not be.
    const dest = join(dir.path, "n".repeat(250));

    await writeFileAtomic(dest, Readable.from(content), { hash });

    assert.equal(readFileSync(dest, "utf8"), content);
    assert.deepEqual(readdirSync(dir.path), ["n".repeat(250)]);
  });

  it("leaves nothing behind when the source stream fails", async () => {
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
    // No partial file at destPath, and no partial temp beside it either.
    assert.deepEqual(readdirSync(dir.path), []);
  });

  it("leaves nothing behind when the filesystem refuses the name", async () => {
    await using dir = await mkTmpDir();
    // Past 255 wherever the suite runs: ENOENT on NTFS, ENAMETOOLONG on ext4
    // and APFS. The temp's own name is always legal, so the refusal comes at
    // the rename, after the whole download is on disk.
    const dest = join(dir.path, "n".repeat(300));

    await assert.rejects(
      () => writeFileAtomic(dest, Readable.from(content), { hash }),
      // Unmasked by the cleanup: `restore` recognizes a refused name by it.
      (/** @type {NodeJS.ErrnoException} */ error) =>
        ["ENOENT", "ENAMETOOLONG"].includes(error.code ?? "") &&
        typeof error.path === "string",
    );
    assert.deepEqual(readdirSync(dir.path), []);
  });
});
