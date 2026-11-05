import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdirSync,
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
// the next (ADR-0116): something else writing in `--output` while it runs. Same
// scaffolding as restore.downloads.test.mjs: mocks first, then a dynamic import.

/** @param {string} content */
const digestOf = (content) =>
  createHash("sha256").update(content).digest("hex");

/** Digest → the bytes `getObject` lands for it. */
const contents = new Map(
  ["aaa", "bbb", "ccc"].map((content) => [digestOf(content), content]),
);

/** @type {(dest: string) => void} Runs after each fetch, landed or not. */
let afterFetch = () => {};
/** @type {string[]} What `getObject` was asked for, in order. */
let fetched = [];
/** @type {typeof threeFiles} */
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
      const content = /** @type {string} */ (contents.get(hash));
      fetched.push(content);
      try {
        await writeFileAtomic(destPath, Readable.from(content), { hash });
      } finally {
        afterFetch(destPath);
      }
    },
  },
});
mock.module("../lib/s3.mjs", { exports: s3Seam() });

const { restore } = await import("./restore.mjs");

const at = { size: 3, mtime: "2026-07-01T10:00:00.000Z" };
const threeFiles = {
  entries: new Map([
    ["/data/a.txt", { ...at, hash: digestOf("aaa") }],
    ["/data/b.txt", { ...at, hash: digestOf("bbb") }],
    ["/data/sub/c.txt", { ...at, hash: digestOf("ccc") }],
  ]),
  dirs: ["/data"],
};
/** Three paths holding one content: the first lands, the others are copied. */
const oneContent = {
  entries: new Map([
    ["/data/a.txt", { ...at, hash: digestOf("aaa") }],
    ["/data/b.txt", { ...at, hash: digestOf("aaa") }],
    ["/data/c.txt", { ...at, hash: digestOf("aaa") }],
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
  snapshot = threeFiles;
  afterFetch = () => {};
  fetched = [];
  base = mkdtempSync(join(tmpdir(), "s3cab-restore-mid-run-"));
  output = join(base, "out");
  elsewhere = join(base, "elsewhere");
});
afterEach(() => {
  process.exitCode = savedExitCode;
  rmSync(base, { recursive: true, force: true });
});

/** Where `--output` re-roots `/data/<name>` to. */
const dest = (/** @type {string} */ name) => join(output, "data", name);

describe("restore when the target changes mid-run", () => {
  it("never writes through a link that replaced a folder it already checked", async () => {
    // After a.txt lands, `out/data` moves away and a link to it takes its
    // place: the folder's "no link" answer is now stale.
    afterFetch = (landed) => {
      if (basename(landed) === "a.txt") {
        renameSync(join(output, "data"), elsewhere);
        symlinkSync(elsewhere, join(output, "data"), "junction");
      }
    };

    const result = await restore([], { all: true, set: "photos", output });

    assert.deepEqual(readdirSync(elsewhere).sort(), ["a.txt"]);
    assert.deepEqual(result.restored, [dest("a.txt")]);
    assert.deepEqual(result.blocked, [dest("b.txt"), dest("sub/c.txt")]);
    assert.deepEqual(fetched, ["aaa"]);
    assert.equal(process.exitCode, 1);
  });

  it("fetches the content again rather than copy a landed file that has changed", async () => {
    snapshot = oneContent;
    afterFetch = (landed) => {
      if (basename(landed) === "a.txt") {
        writeFileSync(landed, "changed");
      }
    };

    const result = await restore([], { all: true, set: "photos", output });

    // a.txt's change is whoever made it's business, so nothing is said about it.
    assert.equal(readFileSync(dest("a.txt"), "utf8"), "changed");
    assert.equal(readFileSync(dest("b.txt"), "utf8"), "aaa");
    // Copied, not fetched a third time: b.txt is where the content is now.
    assert.equal(readFileSync(dest("c.txt"), "utf8"), "aaa");
    assert.deepEqual(fetched, ["aaa", "aaa"]);
    assert.deepEqual(result.restored, [
      dest("a.txt"),
      dest("b.txt"),
      dest("c.txt"),
    ]);
    assert.deepEqual(result.corrupt, []);
    assert.equal(process.exitCode, savedExitCode);
  });

  it("fetches the content again rather than copy a landed file that is a folder now", async () => {
    snapshot = oneContent;
    afterFetch = (landed) => {
      if (basename(landed) === "a.txt") {
        rmSync(landed);
        mkdirSync(landed);
      }
    };

    const result = await restore([], { all: true, set: "photos", output });

    assert.equal(readFileSync(dest("b.txt"), "utf8"), "aaa");
    assert.equal(readFileSync(dest("c.txt"), "utf8"), "aaa");
    assert.deepEqual(fetched, ["aaa", "aaa"]);
    assert.deepEqual(result.restored, [
      dest("a.txt"),
      dest("b.txt"),
      dest("c.txt"),
    ]);
    assert.deepEqual(result.blocked, []);
    assert.equal(process.exitCode, savedExitCode);
  });

  it("doesn't go back to a landed file once a copy from it has failed", async () => {
    snapshot = oneContent;
    afterFetch = (fetched) => {
      if (basename(fetched) === "a.txt") {
        writeFileSync(fetched, "changed");
        // b.txt's fetch, which replaces the failed copy, will find this in the way.
        mkdirSync(dest("b.txt"));
      } else if (basename(fetched) === "b.txt") {
        // Changed back, so a copy from it would succeed again: whether one is
        // tried at all is what is asserted.
        writeFileSync(dest("a.txt"), "aaa");
      }
    };

    const result = await restore([], { all: true, set: "photos", output });

    assert.equal(readFileSync(dest("c.txt"), "utf8"), "aaa");
    assert.deepEqual(fetched, ["aaa", "aaa", "aaa"]);
    assert.deepEqual(result.restored, [dest("a.txt"), dest("c.txt")]);
    assert.deepEqual(result.blocked, [dest("b.txt")]);
    assert.equal(process.exitCode, 1);
  });
});
