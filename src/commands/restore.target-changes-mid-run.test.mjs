import assert from "node:assert/strict";
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import { s3Seam } from "../../test/helpers/s3-seam.mjs";
import { writeFileAtomic } from "../lib/atomic-file.mjs";

// What a restore does when the target changes under it, between one file and
// the next (proposals/audit-restore-2026-11-04.md). The folder check
// (`linkedFolder`) remembers each folder's answer for the run, and a dedup copy
// trusts the file it landed earlier; both are wrong once something else writes
// in `--output` while the restore runs. Same scaffolding as
// restore.downloads.test.mjs: mocks first, then a dynamic import.

/** @type {(hash: string, landed: string) => void} */
let afterFetch = () => {};
/** @type {typeof fourFiles} */
let snapshot;

mock.module("../lib/env.mjs", {
  exports: {
    loadSet: (/** @type {string} */ name) => ({
      name,
      bucket: "my-backups",
      dirs: ["/data"],
      dirsPath: "/home/me/.s3cab/sets/photos/dirs.txt",
    }),
  },
});
mock.module("../lib/remote.mjs", {
  exports: {
    listRemoteSnapshots: async () => ["20260719T1200"],
    readRemoteSnapshot: async () => ({ refused: new Map(), ...snapshot }),
  },
});
mock.module("../lib/objects.mjs", {
  exports: {
    getObject: async (
      /** @type {string} */ _bucket,
      /** @type {string} */ hash,
      /** @type {string} */ destPath,
    ) => {
      await writeFileAtomic(destPath, Readable.from(hash));
      afterFetch(hash, destPath);
    },
  },
});
mock.module("../lib/s3.mjs", { exports: s3Seam() });

const { restore } = await import("./restore.mjs");

const at = { size: 3, mtime: "2026-07-01T10:00:00.000Z" };
const fourFiles = {
  entries: new Map([
    ["/data/a.txt", { ...at, hash: "aaa" }],
    ["/data/b.txt", { ...at, hash: "bbb" }],
    ["/data/sub/c.txt", { ...at, hash: "ccc" }],
  ]),
  dirs: ["/data"],
};

/** @type {number | string | null | undefined} */
let savedExitCode;
/** @type {string} */
let base;
/** @type {string} */
let output;
/** @type {string} */
let elsewhere;
beforeEach(() => {
  savedExitCode = process.exitCode;
  snapshot = fourFiles;
  afterFetch = () => {};
  base = mkdtempSync(join(tmpdir(), "s3cab-restore-mid-run-"));
  output = join(base, "out");
  elsewhere = join(base, "elsewhere");
});
afterEach(() => {
  process.exitCode = savedExitCode;
  rmSync(base, { recursive: true, force: true });
});

describe("restore when the target changes mid-run", () => {
  it("never writes through a link that replaced a folder it already checked", async () => {
    // After a.txt lands, `out/data` moves away and a link to it takes its
    // place: the folder's "no link" answer is now stale.
    afterFetch = (_hash, landed) => {
      if (basename(landed) === "a.txt") {
        renameSync(join(output, "data"), elsewhere);
        symlinkSync(elsewhere, join(output, "data"), "junction");
      }
    };

    const result = await restore([], { all: true, set: "photos", output });

    assert.deepEqual(readdirSync(elsewhere).sort(), ["a.txt"]);
    assert.deepEqual(result.blocked, [
      join(output, "data", "b.txt"),
      join(output, "data", "sub", "c.txt"),
    ]);
    assert.equal(process.exitCode, 1);
  });

  it("doesn't copy a landed file that has changed since, as if it were the content", async () => {
    snapshot = {
      entries: new Map([
        ["/data/a.txt", { ...at, hash: "aaa" }],
        ["/data/b.txt", { ...at, hash: "aaa" }], // copied from a.txt
      ]),
      dirs: ["/data"],
    };
    afterFetch = (_hash, landed) => writeFileSync(landed, "changed");

    const result = await restore([], { all: true, set: "photos", output });

    assert.notEqual(
      readFileSync(join(output, "data", "b.txt"), "utf8"),
      "changed",
    );
    assert.ok(
      !result.restored.includes(join(output, "data", "b.txt")) ||
        process.exitCode === 1,
    );
  });
});
