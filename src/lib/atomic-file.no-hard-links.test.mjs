import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import * as realFsPromises from "node:fs/promises";
import { mkdtempDisposable } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { describe, it, mock } from "node:test";
import { DestinationExistsError } from "./error.mjs";

// writeFileAtomic's `noClobber` on a filesystem without hard links (FAT,
// exFAT), where the link fails some other way than `EEXIST`: the temp is
// renamed once nothing is found at the destination.
//
// Its own file, and a dotted aspect name (ADR-0049), because failing the link
// means mocking `node:fs/promises` before `atomic-file.mjs` is loaded.

// `EPERM` is Linux's answer on vfat (link(2)). Everything else passes through,
// bar `constants`, which is non-configurable.
mock.module("node:fs/promises", {
  exports: {
    ...Object.fromEntries(
      Object.entries(realFsPromises).filter(([name]) => name !== "constants"),
    ),
    link: async () => {
      throw Object.assign(new Error("EPERM: operation not permitted, link"), {
        code: "EPERM",
      });
    },
  },
});

const { writeFileAtomic } = await import("./atomic-file.mjs");

describe("writeFileAtomic with noClobber, where the disk has no hard links", () => {
  const mkTmpDir = async () => mkdtempDisposable(join("test", ".tmp"));
  const content = "the real object bytes";
  const hash = createHash("sha256").update(content).digest("hex");

  it("lands the file where nothing is, and leaves no temp", async () => {
    await using dir = await mkTmpDir();
    const dest = join(dir.path, "out.bin");

    await writeFileAtomic(dest, Readable.from(content), {
      hash,
      noClobber: true,
    });

    assert.equal(readFileSync(dest, "utf8"), content);
    assert.deepEqual(readdirSync(dir.path), ["out.bin"]);
  });

  it("leaves a file at the destination alone, and leaves no temp", async () => {
    await using dir = await mkTmpDir();
    const dest = join(dir.path, "out.bin");
    writeFileSync(dest, "theirs");

    await assert.rejects(
      () =>
        writeFileAtomic(dest, Readable.from(content), {
          hash,
          noClobber: true,
        }),
      DestinationExistsError,
    );

    assert.equal(readFileSync(dest, "utf8"), "theirs");
    assert.deepEqual(readdirSync(dir.path), ["out.bin"]);
  });

  it("throws the rename's refusal for a name the filesystem refuses", async () => {
    await using dir = await mkTmpDir();

    await assert.rejects(
      () =>
        writeFileAtomic(
          join(dir.path, "n".repeat(300)),
          Readable.from(content),
          {
            hash,
            noClobber: true,
          },
        ),
      (/** @type {NodeJS.ErrnoException} */ error) =>
        ["ENOENT", "ENAMETOOLONG"].includes(error.code ?? "") &&
        typeof error.path === "string",
    );
    assert.deepEqual(readdirSync(dir.path), []);
  });
});
