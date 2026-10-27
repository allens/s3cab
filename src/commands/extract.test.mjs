import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { platform } from "node:process";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import { s3Seam } from "../../test/helpers/s3-seam.mjs";
import { writeFileAtomic } from "../lib/atomic-file.mjs";

// Offline tests for what `extract` adds to restore (ADR-0111): the name the item
// lands under, its arguments, and the refusal of a name already taken. The S3
// reads are faked at the lib seam (docs/design/testing.md) and the writes are
// real; how each file lands, and fails to, is `restoreTargets`', pinned in
// restore.downloads.test.mjs. Module-mock ordering (objects.test.mjs) applies:
// mocks first, then a dynamic import of the command.

/** @type {Map<string, { size: number, mtime: string, hash: string }>} */
let entries = new Map();
/** How many times the snapshot was read: 0 proves a refusal came first. */
let snapshotReads = 0;

mock.module("../lib/env.mjs", {
  exports: {
    loadSet: (/** @type {string} */ name) => ({ name, bucket: "b" }),
  },
});
mock.module("../lib/remote.mjs", {
  exports: {
    listRemoteSnapshots: async () => ["2026-07-19T1200"],
    readRemoteSnapshot: async () => {
      snapshotReads++;
      return { entries, refused: new Map(), dirs: [] };
    },
  },
});
mock.module("../lib/objects.mjs", {
  exports: {
    // Each file's content is its hash, so a test can tell which row landed.
    getObject: async (
      /** @type {string} */ _bucket,
      /** @type {string} */ hash,
      /** @type {string} */ dest,
    ) => writeFileAtomic(dest, Readable.from(hash)),
  },
});
mock.module("../lib/s3.mjs", { exports: s3Seam() });

const { extract } = await import("./extract.mjs");

const row = (/** @type {string} */ hash) => ({
  size: hash.length,
  mtime: "2026-07-01T10:00:00.000Z",
  hash,
});

/** @type {string} */
let out;
beforeEach(() => {
  out = mkdtempSync(join(tmpdir(), "s3cab-extract-"));
  snapshotReads = 0;
  entries = new Map([
    ["/home/me/Photos/a.jpg", row("aaa")],
    ["/home/me/Photos/2024/b.jpg", row("bbb")],
    ["/home/me/Photos-old/c.jpg", row("ccc")],
    ["C:\\Users\\me\\report.pdf", row("ppp")],
  ]);
});
afterEach(() => rmSync(out, { recursive: true, force: true }));

describe("extract puts the item in --output under its own name", () => {
  it("a folder lands as its last name, everything inside keeping its own", async () => {
    const result = await extract(["/home/me/Photos"], {
      set: "s",
      output: out,
    });

    assert.equal(result.to, join(out, "Photos"));
    assert.deepEqual(readdirSync(join(out, "Photos")).sort(), [
      "2024",
      "a.jpg",
    ]);
    assert.equal(
      readFileSync(join(out, "Photos", "2024", "b.jpg"), "utf8"),
      "bbb",
    );
    // `Photos-old` is beside the item, not under it.
    assert.deepEqual(readdirSync(out), ["Photos"]);
  });

  it("a file lands as its own name, from a Windows backup on any machine", async () => {
    await extract(["c:/users/ME/report.pdf"], { set: "s", output: out });

    assert.equal(readFileSync(join(out, "report.pdf"), "utf8"), "ppp");
  });

  it("--name gives the copy another name", async () => {
    await extract(["/home/me/Photos/"], {
      set: "s",
      output: out,
      name: "Photos-May",
    });

    assert.equal(readFileSync(join(out, "Photos-May", "a.jpg"), "utf8"), "aaa");
  });

  it("puts it in the current folder by default", async () => {
    const was = process.cwd();
    process.chdir(out);
    try {
      await extract(["/home/me/Photos/a.jpg"], { set: "s" });
    } finally {
      process.chdir(was);
    }

    assert.equal(readFileSync(join(out, "a.jpg"), "utf8"), "aaa");
  });
});

describe("extract won't hand back what was already there", () => {
  it("refuses a name already taken before reading the snapshot, offering the three ways out in order", async () => {
    writeFileSync(join(out, "a.jpg"), "the live file");

    await assert.rejects(
      extract(["/home/me/Photos/a.jpg"], {
        set: "s",
        snapshot: "2026-07-19T1200",
        output: out,
      }),
      (/** @type {Error} */ error) => {
        assert.match(
          error.message,
          /would replace '.*a\.jpg', which is already there/,
        );
        // Each keeps the rest of the line, so a pasted --overwrite can't land
        // the latest copy in the cwd instead.
        const run = `s3cab extract --set s "/home/me/Photos/a.jpg" --snapshot 2026-07-19T1200`;
        assert.ok(
          error.message.endsWith(
            [
              `  ${run} --output "${out}" --name <name>`,
              `  ${run} --output <folder>`,
              `  ${run} --output "${out}" --overwrite`,
            ].join("\n"),
          ),
          error.message,
        );
        return true;
      },
    );
    assert.equal(snapshotReads, 0);
    assert.equal(readFileSync(join(out, "a.jpg"), "utf8"), "the live file");
  });

  it("refuses a folder already there just the same", async () => {
    mkdirSync(join(out, "Photos"));

    await assert.rejects(
      extract(["/home/me/Photos"], { set: "s", output: out }),
      /would replace/,
    );
  });

  it("--overwrite writes over a file already there", async () => {
    writeFileSync(join(out, "a.jpg"), "the live file");

    const result = await extract(["/home/me/Photos/a.jpg"], {
      set: "s",
      output: out,
      overwrite: true,
    });

    assert.deepEqual(result.restored, [join(out, "a.jpg")]);
    assert.equal(readFileSync(join(out, "a.jpg"), "utf8"), "aaa");
  });

  it("--overwrite into a folder already there writes the backup's files and leaves the rest", async () => {
    mkdirSync(join(out, "Photos"));
    writeFileSync(join(out, "Photos", "a.jpg"), "the live file");
    writeFileSync(join(out, "Photos", "new.jpg"), "not in the backup");

    await extract(["/home/me/Photos"], {
      set: "s",
      output: out,
      overwrite: true,
    });

    assert.equal(readFileSync(join(out, "Photos", "a.jpg"), "utf8"), "aaa");
    assert.equal(
      readFileSync(join(out, "Photos", "new.jpg"), "utf8"),
      "not in the backup",
    );
  });

  it("exits 1 when what's there is in the way", async () => {
    writeFileSync(join(out, "Photos"), "a file where the folder goes");
    const savedExitCode = process.exitCode;
    process.exitCode = undefined;
    try {
      const result = await extract(["/home/me/Photos"], {
        set: "s",
        output: out,
        overwrite: true,
      });

      assert.equal(result.blocked.length, 2);
      assert.equal(process.exitCode, 1);
    } finally {
      process.exitCode = savedExitCode;
    }
  });
});

describe("extract's arguments", () => {
  it("takes one path, not two", async () => {
    await assert.rejects(
      extract(["/home/me/Photos", "/home/me/Photos-old"], { set: "s" }),
      { code: "ERR_PARSE_ARGS", message: /one file or folder per run/ },
    );
  });

  it("needs a path", async () => {
    await assert.rejects(extract([" "], { set: "s" }), {
      code: "ERR_PARSE_ARGS",
    });
  });

  it("needs a full path, as backed up", async () => {
    for (const item of ["Photos", "x", "home/me/Photos"]) {
      await assert.rejects(
        extract([item], { set: "s", output: out }),
        { code: "ERR_PARSE_ARGS", message: /isn't a full path/ },
        item,
      );
    }
    assert.equal(snapshotReads, 0);
  });

  it("needs --name for a root, which has no name of its own", async () => {
    await assert.rejects(extract(["/"], { set: "s", output: out }), {
      code: "ERR_PARSE_ARGS",
      message: /no name of its own: give the copy one with --name/,
    });
  });

  it("refuses a --name that is a path, not a name", async () => {
    for (const name of ["a/b", "..", ".", ""]) {
      await assert.rejects(
        extract(["/home/me/Photos"], { set: "s", output: out, name }),
        { code: "ERR_PARSE_ARGS", message: /not a path/ },
        name,
      );
    }
  });

  it(
    "refuses a \\ in --name where the folder is a Windows one",
    {
      skip: platform !== "win32" && "the output folder must be a Windows path",
    },
    async () => {
      await assert.rejects(
        extract(["/home/me/Photos"], { set: "s", output: out, name: "a\\b" }),
        { code: "ERR_PARSE_ARGS", message: /not a path/ },
      );
    },
  );

  it("says when the snapshot holds nothing at that path", async () => {
    await assert.rejects(
      extract(["/home/me/Phots"], { set: "s", output: out }),
      /No files in snapshot '2026-07-19T1200' matched:\n {2}\/home\/me\/Phots\n/,
    );
  });
});
