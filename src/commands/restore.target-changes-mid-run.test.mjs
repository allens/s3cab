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
import * as atomicFile from "../lib/atomic-file.mjs";

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

/**
 * @type {(dest: string) => void} Runs while fetched content is written, after
 * its first chunk, so a look before the write can't see what it does.
 */
let beforeLanding = () => {};
/** @type {(dest: string) => void} Runs as a copy starts, after its destination was looked at. */
let beforeCopy = () => {};
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
      /** @type {{ noClobber?: boolean }} */ options,
    ) => {
      const content = /** @type {string} */ (contents.get(hash));
      fetched.push(content);
      async function* download() {
        yield content;
        beforeLanding(destPath);
      }
      try {
        await atomicFile.writeFileAtomic(destPath, Readable.from(download()), {
          hash,
          ...options,
        });
      } finally {
        afterFetch(destPath);
      }
    },
  },
});
mock.module("../lib/atomic-file.mjs", {
  exports: {
    ...atomicFile,
    /** @type {typeof atomicFile.copyFileAtomic} */
    copyFileAtomic: async (from, destPath, options) => {
      beforeCopy(destPath);
      return atomicFile.copyFileAtomic(from, destPath, options);
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
  beforeLanding = () => {};
  beforeCopy = () => {};
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
  it("leaves a file that arrives during its own download alone, and reports it skipped", async () => {
    // b.txt's place was empty when its turn came, so its content is fetched;
    // a sync client writes one there before it lands.
    beforeLanding = (to) => {
      if (basename(to) === "b.txt") {
        writeFileSync(to, "theirs");
      }
    };

    const result = await restore([], { all: true, set: "photos", output });

    assert.equal(readFileSync(dest("b.txt"), "utf8"), "theirs");
    assert.deepEqual(result.skipped, [dest("b.txt")]);
    assert.deepEqual(result.restored, [dest("a.txt"), dest("sub/c.txt")]);
    // Nor is the fetched copy left beside it.
    assert.deepEqual(readdirSync(join(output, "data")).sort(), [
      "a.txt",
      "b.txt",
      "sub",
    ]);
    assert.equal(process.exitCode, savedExitCode);
  });

  it("reports a folder that arrives during its own download as in the way", async () => {
    beforeLanding = (to) => {
      if (basename(to) === "b.txt") {
        mkdirSync(to);
      }
    };

    const result = await restore([], { all: true, set: "photos", output });

    assert.deepEqual(result.blocked, [dest("b.txt")]);
    assert.deepEqual(result.skipped, []);
    assert.deepEqual(readdirSync(dest("b.txt")), []);
    assert.equal(process.exitCode, 1);
  });

  // The rename's refusal (`EISDIR`, `EPERM` on NTFS), where the test above
  // meets the link's.
  it("reports a folder that arrives during its own download as in the way, under --overwrite too", async () => {
    beforeLanding = (to) => {
      if (basename(to) === "b.txt") {
        mkdirSync(to);
      }
    };

    const result = await restore([], {
      all: true,
      set: "photos",
      output,
      overwrite: true,
    });

    assert.deepEqual(result.blocked, [dest("b.txt")]);
    assert.deepEqual(result.restored, [dest("a.txt"), dest("sub/c.txt")]);
    assert.deepEqual(readdirSync(dest("b.txt")), []);
    assert.equal(process.exitCode, 1);
  });

  it("leaves a file that arrives before its copy lands alone, and reports it skipped", async () => {
    snapshot = oneContent;
    beforeCopy = (to) => {
      if (basename(to) === "b.txt") {
        writeFileSync(to, "theirs");
      }
    };

    const result = await restore([], { all: true, set: "photos", output });

    assert.equal(readFileSync(dest("b.txt"), "utf8"), "theirs");
    assert.equal(readFileSync(dest("c.txt"), "utf8"), "aaa");
    assert.deepEqual(fetched, ["aaa"]);
    assert.deepEqual(result.skipped, [dest("b.txt")]);
    assert.deepEqual(result.restored, [dest("a.txt"), dest("c.txt")]);
    assert.deepEqual(readdirSync(join(output, "data")).sort(), [
      "a.txt",
      "b.txt",
      "c.txt",
    ]);
    assert.equal(process.exitCode, savedExitCode);
  });

  it("replaces a file that arrives during its own download under --overwrite", async () => {
    beforeLanding = (to) => {
      if (basename(to) === "b.txt") {
        writeFileSync(to, "theirs");
      }
    };

    const result = await restore([], {
      all: true,
      set: "photos",
      output,
      overwrite: true,
    });

    assert.equal(readFileSync(dest("b.txt"), "utf8"), "bbb");
    assert.deepEqual(result.restored, [
      dest("a.txt"),
      dest("b.txt"),
      dest("sub/c.txt"),
    ]);
  });

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
    // b.txt's fetch, which replaces the failed copy, finds this in the way.
    beforeLanding = (to) => {
      if (basename(to) === "b.txt") {
        mkdirSync(to);
      }
    };
    afterFetch = (fetched) => {
      if (basename(fetched) === "a.txt") {
        writeFileSync(fetched, "changed");
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
