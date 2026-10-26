import assert from "node:assert/strict";
import * as realFs from "node:fs";
import { mkdtempDisposable } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { setTimeout as sleep } from "node:timers/promises";
import { describe, it, mock } from "node:test";

// writeFileAtomic on a filesystem whose `open` is slow, such as a Windows drive
// under WSL, where every call is a round trip to Windows. A source that fails
// before the temp's write stream has opened its file must still leave nothing
// behind: the file appears when the open completes, after the failure.
//
// Its own file, and a dotted aspect name (ADR-0049), because slowing the open
// means mocking `node:fs` before `atomic-file.mjs` is loaded.

/** How long the temp's `open` takes: far longer than the source takes to fail. */
const OPEN_DELAY_MS = 100;

// Everything else passes through, bar `constants`, which is non-configurable.
mock.module("node:fs", {
  exports: {
    ...Object.fromEntries(
      Object.entries(realFs).filter(([name]) => name !== "constants"),
    ),
    /**
     * @param {string} path
     * @param {object} [options]
     */
    createWriteStream: (path, options) =>
      realFs.createWriteStream(path, {
        ...options,
        fs: {
          /** @type {(...args: Parameters<typeof realFs.open>) => void} */
          open: (...args) =>
            void setTimeout(() => realFs.open(...args), OPEN_DELAY_MS),
          write: realFs.write,
          writev: realFs.writev,
          close: realFs.close,
        },
      }),
  },
});

const { writeFileAtomic } = await import("./atomic-file.mjs");

describe("writeFileAtomic when the temp opens slowly", () => {
  it("leaves nothing behind when the source fails before the open completes", async () => {
    await using dir = await mkdtempDisposable(join("test", ".tmp"));

    async function* failingSource() {
      yield "some bytes";
      throw new Error("connection reset");
    }
    await assert.rejects(
      () =>
        writeFileAtomic(
          join(dir.path, "out.bin"),
          Readable.from(failingSource()),
        ),
      /connection reset/,
    );
    // Long enough for an open still under way to have created the file.
    await sleep(OPEN_DELAY_MS * 2);
    assert.deepEqual(realFs.readdirSync(dir.path), []);
  });
});
