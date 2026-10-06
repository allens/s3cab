import assert from "node:assert/strict";
import { mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { mkdtempDisposable } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import { readSnapshot } from "./snapshot-file.mjs";
import { generateSnapshot } from "./snapshot.mjs";

/** @import { TestContext } from "node:test" */
/** @import { SnapshotRow } from "./snapshot-file.mjs" */

// The files a pass couldn't read, as the pass reports them. The backup report
// names each one (ADR-0078), so the list has to be the pass's own and agree with
// the `#ERROR` rows it wrote. Its own file (ADR-0049's dotted aspect) because the
// failure has to be made real: the files are deleted after the walk found them,
// from inside the pipeline, which is the only point between walk and hash.

describe("a pass over files that vanish before they are read", () => {
  it("returns each one with the reason its #ERROR row records", async (/** @type {TestContext} */ t) => {
    t.mock.method(console, "warn", () => {});
    await using dir = await mkdtempDisposable(join("test", ".tmp"));
    const data = join(dir.path, "data");
    const snapshotsDir = join(dir.path, "snapshots");
    mkdirSync(data);
    mkdirSync(snapshotsDir);
    for (const name of ["one.txt", "two.txt", "three.txt"]) {
      writeFileSync(join(data, name), name);
    }
    const root = realpathSync.native(data);
    const all = ["one.txt", "two.txt", "three.txt"].map((name) =>
      join(root, name),
    );

    const pass = await generateSnapshot(
      {
        name: "photos",
        dirs: [root],
        bucket: "b",
        dir: dir.path,
        snapshotsDir,
        dirsPath: join(dir.path, "dirs.txt"),
        excludePath: join(dir.path, "exclude.txt"),
        envPath: join(dir.path, "env"),
      },
      {
        resumeCommand: "s3cab snapshot photos --resume",
        // The pipeline is lazy, so the rows after the first are not yet hashed
        // when the first one arrives here.
        through: async function* (
          /** @type {Iterable<SnapshotRow> | AsyncIterable<SnapshotRow>} */ rows,
        ) {
          let first = true;
          for await (const row of rows) {
            if (first) {
              first = false;
              for (const path of all.filter((path) => path !== row[0])) {
                rmSync(path);
              }
            }
            yield row;
          }
        },
      },
    );

    assert.equal(pass.errors.length, 2);
    for (const { reason } of pass.errors) {
      assert.match(reason, /^ENOENT: /);
    }
    const { errors } = await readSnapshot(snapshotsDir, pass.name);
    assert.deepEqual(
      pass.errors,
      [...errors].map(([path, reason]) => ({ path, reason })),
    );
  });
});
