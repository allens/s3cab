import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import * as realFsPromises from "node:fs/promises";
import { mkdtempDisposable } from "node:fs/promises";
import { basename, join } from "node:path";
import { Readable } from "node:stream";
import { describe, it, mock } from "node:test";

// writeFileAtomic's `noClobber` when the temp can't be removed once it has
// landed by hard link: another program holds it open without delete-sharing.
//
// Its own file, and a dotted aspect name (ADR-0049), because failing the
// removal means mocking `node:fs/promises` before `atomic-file.mjs` is loaded.

// `EBUSY` is what Windows gives for a file open without delete-sharing.
// Everything else passes through, bar `constants`, which is non-configurable.
mock.module("node:fs/promises", {
  exports: {
    ...Object.fromEntries(
      Object.entries(realFsPromises).filter(([name]) => name !== "constants"),
    ),
    rm: async () => {
      throw Object.assign(new Error("EBUSY: resource busy or locked, unlink"), {
        code: "EBUSY",
      });
    },
  },
});

const { tempPathFor, writeFileAtomic } = await import("./atomic-file.mjs");

describe("writeFileAtomic with noClobber, when the landed temp is held open", () => {
  it("lands the file, and leaves the temp as a second name", async () => {
    await using dir = await mkdtempDisposable(join("test", ".tmp"));
    const dest = join(dir.path, "out.bin");
    const content = "the real object bytes";
    const hash = createHash("sha256").update(content).digest("hex");

    await writeFileAtomic(dest, Readable.from(content), {
      hash,
      noClobber: true,
    });

    assert.equal(readFileSync(dest, "utf8"), content);
    assert.deepEqual(
      readdirSync(dir.path).sort(),
      ["out.bin", basename(tempPathFor(dest))].sort(),
    );
  });
});
