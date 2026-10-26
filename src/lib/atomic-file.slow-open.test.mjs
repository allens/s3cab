import assert from "node:assert/strict";
import * as realFs from "node:fs";
import * as realFsPromises from "node:fs/promises";
import { mkdtempDisposable } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { setTimeout as sleep } from "node:timers/promises";
import { describe, it, mock } from "node:test";

// writeFileAtomic on a filesystem whose `open` is slow, such as a Windows drive
// under WSL, where every call is a round trip to Windows. A source that fails
// before the temp has been opened must still leave nothing behind.
//
// Its own file, and a dotted aspect name (ADR-0049), because slowing the open
// means mocking `node:fs` and `node:fs/promises` before `atomic-file.mjs` is
// loaded.

/** How long each open takes: far longer than the source takes to fail. */
const OPEN_DELAY_MS = 100;

/** Every delayed open, so the test can wait until each has created its file. */
const opens = /** @type {Promise<unknown>[]} */ ([]);

/**
 * @template T
 * @param {() => Promise<T>} openNow
 */
function slowly(openNow) {
  const opened = sleep(OPEN_DELAY_MS).then(openNow);
  opens.push(opened.catch(() => {}));
  return opened;
}

mock.module("node:fs/promises", {
  exports: {
    copyFile: realFsPromises.copyFile,
    rename: realFsPromises.rename,
    rm: realFsPromises.rm,
    /** @type {typeof realFsPromises.open} */
    open: (...args) => slowly(() => realFsPromises.open(...args)),
  },
});
// The lazy open the race came from, slowed too, so going back to
// `createWriteStream(tmpPath)` fails this test rather than skipping its mock.
mock.module("node:fs", {
  exports: {
    /**
     * @param {string} path
     * @param {object} [options]
     */
    createWriteStream: (path, options) =>
      realFs.createWriteStream(path, {
        ...options,
        fs: {
          /**
           * @param {string} file
           * @param {string} flags
           * @param {number} mode
           * @param {(error: Error | null, fd: number) => void} callback
           */
          open: (file, flags, mode, callback) =>
            void slowly(
              () =>
                new Promise((resolve) =>
                  realFs.open(file, flags, mode, (error, fd) => {
                    callback(error, fd);
                    resolve(undefined);
                  }),
                ),
            ),
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
    await Promise.all(opens);
    assert.deepEqual(realFs.readdirSync(dir.path), []);
  });
});
