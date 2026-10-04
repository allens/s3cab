import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as realFsPromises from "node:fs/promises";
import { mkdtempDisposable } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { describe, it, mock } from "node:test";
import { IntegrityError } from "./error.mjs";

// writeFileAtomic when removing its temp fails too — on Windows, a scanner
// holding the fresh file is enough. `restore` decides whether to carry on from
// the error that stopped the write (its type, its code and path), so the
// cleanup's own failure must never replace it.
//
// Its own file, and a dotted aspect name (ADR-0049), because making `rm` fail
// means mocking `node:fs/promises` before `atomic-file.mjs` is loaded.

// Everything else passes through, bar `constants`, which is non-configurable:
// the failures under test come from the real filesystem.
mock.module("node:fs/promises", {
  exports: {
    ...Object.fromEntries(
      Object.entries(realFsPromises).filter(([name]) => name !== "constants"),
    ),
    rm: async () => {
      throw Object.assign(new Error("EBUSY: resource busy or locked, rm"), {
        code: "EBUSY",
      });
    },
  },
});

const { writeFileAtomic } = await import("./atomic-file.mjs");

describe("writeFileAtomic when its temp can't be removed", () => {
  const mkTmpDir = async () => mkdtempDisposable(join("test", ".tmp"));
  const content = "the real object bytes";
  const hash = createHash("sha256").update(content).digest("hex");

  it("still throws the refused name, not the failed cleanup", async () => {
    await using dir = await mkTmpDir();

    await assert.rejects(
      () =>
        writeFileAtomic(
          join(dir.path, "n".repeat(300)),
          Readable.from(content),
        ),
      (/** @type {NodeJS.ErrnoException} */ error) =>
        ["ENOENT", "ENAMETOOLONG"].includes(error.code ?? "") &&
        typeof error.path === "string",
    );
  });

  it("still throws the integrity failure, not the failed cleanup", async () => {
    await using dir = await mkTmpDir();

    await assert.rejects(
      () =>
        writeFileAtomic(join(dir.path, "out.bin"), Readable.from("tampered"), {
          hash,
        }),
      IntegrityError,
    );
  });
});
