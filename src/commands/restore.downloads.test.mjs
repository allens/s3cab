import assert from "node:assert/strict";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import * as fsPromises from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import { s3Seam } from "../../test/helpers/s3-seam.mjs";
import { writeFileAtomic } from "../lib/atomic-file.mjs";
import { IntegrityError } from "../lib/error.mjs";

// Offline tests for how restore lands its downloads: content shared by several
// paths is downloaded once and copied to the rest, and one object absent from
// the bucket — or present but corrupt, or under a name this disk refuses —
// must not abort the run. The S3 reads are faked at the lib seam
// (docs/design/testing.md), so the skip, the continue, the end report and the
// exit-code side effect are pinned without a bucket — but the restore
// *planning* (lib/restore.mjs) and the real filesystem writes are left alone,
// so the copies, and the failures they must route around, happen for real.
// Argument validation lives in restore.test.mjs; the round trip against a real
// bucket in test/integration/backup-restore-roundtrip.test.mjs.
// Module-mock ordering (objects.test.mjs) applies: mocks first, then a dynamic
// import of the command.

const BUCKET = "my-backups";

/** Hash → what `getObject` does with it; anything absent here downloads fine. */
/** @type {Map<string, Error>} */
let failures = new Map();
/** @type {string[]} Hashes `getObject` was actually asked for, in order. */
let fetched = [];
/** @type {Map<string, { deletedOn: string }>} the bucket's deletion records */
let deletionRecords = new Map();
/** How many times the records were fetched — laziness evidence (0 on a clean run). */
let recordReads = 0;
/** @type {(hash: string) => void} Runs after each fake download that succeeds — a test's way to act mid-restore. */
let afterFetch = () => {};
/** @type {(mtime: Date) => Date} The time `utimes` stores for the one it is asked for, as a filesystem that rounds or clamps does. */
let keeps = (mtime) => mtime;

// `utimes` alone is wrapped: no filesystem the suite runs on rounds or clamps a
// time it can be relied on to, so `keeps` plays one. The static import above is
// the real module, resolved before this mock exists. The mock replaces the
// builtin for every module imported after it, `atomic-file.mjs` included, which
// is why the rest of the real namespace is spread in.
mock.module("node:fs/promises", {
  exports: {
    ...fsPromises,
    utimes: (
      /** @type {string} */ path,
      /** @type {Date} */ atime,
      /** @type {Date} */ mtime,
    ) => fsPromises.utimes(path, atime, keeps(mtime)),
  },
});

mock.module("../lib/env.mjs", {
  exports: {
    loadSet: (/** @type {string} */ name) => ({ name, bucket: BUCKET }),
  },
});
mock.module("../lib/remote.mjs", {
  exports: {
    listRemoteSnapshots: async () => ["2026-07-19T1200"],
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
      fetched.push(hash);
      const failure = failures.get(hash);
      if (failure) {
        throw failure;
      }
      // Landed the way the real getObject lands it, so a name the disk refuses
      // fails where it really does (the rename, after the download) and leaves
      // what it really leaves. The digest check is the one part skipped: these
      // hashes are labels, not digests.
      await writeFileAtomic(destPath, Readable.from(hash));
      afterFetch(hash);
    },
  },
});
// The fetch is faked above at `objects.mjs`, so nothing here reaches the store
// itself — but restore's degrade branch keys on `isObjectNotFound`'s verdict,
// and the stencil's default is the real name-based predicate.
mock.module("../lib/s3.mjs", { exports: s3Seam() });
mock.module("../lib/deletion-record.mjs", {
  exports: {
    readDeletionRecords: async () => {
      recordReads++;
      return { deleted: deletionRecords, invalid: [] };
    },
  },
});

const { restore } = await import("./restore.mjs");

/**
 * The snapshot most tests restore: four files under one member root, two of
 * them (`gone.txt`, `gone-copy.txt`) sharing content — so the second shares the
 * first's fate: copied from where it landed, or the same casualty.
 */
const fourFiles = {
  entries: new Map([
    [
      "/data/first.txt",
      { size: 3, mtime: "2026-07-01T10:00:00.000Z", hash: "aaa" },
    ],
    [
      "/data/gone.txt",
      { size: 3, mtime: "2026-07-01T10:00:00.000Z", hash: "bbb" },
    ],
    [
      "/data/gone-copy.txt",
      { size: 3, mtime: "2026-07-01T10:00:00.000Z", hash: "bbb" },
    ],
    [
      "/data/last.txt",
      { size: 3, mtime: "2026-07-01T10:00:00.000Z", hash: "ccc" },
    ],
  ]),
  dirs: ["/data"],
};
/**
 * What `readRemoteSnapshot` returns; `fourFiles` unless a test swaps it.
 * @type {typeof fourFiles & { refused?: Map<string, string> }}
 */
let snapshot = fourFiles;

/** @param {string} name */
const named = (name) => Object.assign(new Error(name), { name });

// A name component past 255 characters is refused wherever the suite runs —
// ENOENT on NTFS, ENAMETOOLONG on ext4 and APFS — so tests using it drive the
// real filesystem's refusal rather than a faked error. Windows forbidding a
// form feed is the case that found this; length is the one every platform
// shares.
const long = "x".repeat(300);
const at = { size: 3, mtime: "2026-07-01T10:00:00.000Z" };

/** @type {number | string | null | undefined} */
let savedExitCode;
/** @type {string} */
let output;
beforeEach(() => {
  savedExitCode = process.exitCode;
  snapshot = fourFiles;
  failures = new Map();
  fetched = [];
  deletionRecords = new Map();
  recordReads = 0;
  afterFetch = () => {};
  keeps = (mtime) => mtime;
  output = mkdtempSync(join(tmpdir(), "s3cab-restore-"));
});
afterEach(() => {
  process.exitCode = savedExitCode; // never leak a set exit code to the runner
  rmSync(output, { recursive: true, force: true }); // don't leak the temp dir
});

/** Where `--output` re-roots `/data/<name>` to. */
const dest = (/** @type {string} */ name) => join(output, "data", name);

describe("restore reads each modification time back", () => {
  it("reports a time kept 2 seconds or more off, and exits 1", async () => {
    keeps = (mtime) => new Date(mtime.getTime() - 2000);

    const result = await restore([], { set: "photos", output });

    assert.equal(result.restored.length, 4);
    assert.deepEqual(
      result.clamped.map(({ path }) => path),
      result.restored,
    );
    assert.deepEqual(
      new Set(result.clamped.map(({ kept }) => kept)),
      new Set(["2026-07-01T09:59:58.000Z"]),
    );
    assert.equal(result.coarseTimes, 0);
    assert.equal(process.exitCode, 1);
  });

  it("counts a time a disk rounded by less than 2 seconds, and exits 0", async () => {
    keeps = (mtime) => new Date(mtime.getTime() + 1999);

    const result = await restore([], { set: "photos", output });

    assert.equal(result.restored.length, 4);
    assert.deepEqual(result.clamped, []);
    assert.equal(result.coarseTimes, 4);
    assert.notEqual(process.exitCode, 1);
  });

  it("reports nothing when every time is kept", async () => {
    const result = await restore([], { set: "photos", output });

    assert.deepEqual(result.clamped, []);
    assert.equal(result.coarseTimes, 0);
    assert.notEqual(process.exitCode, 1);
  });

  it("reports a time the disk refuses outright, and carries on", async () => {
    // NTFS before 1601: EINVAL. The file keeps the time it was written at.
    keeps = () => {
      throw Object.assign(new Error("EINVAL: invalid argument, utime"), {
        code: "EINVAL",
      });
    };

    const result = await restore([], { set: "photos", output });

    assert.equal(result.restored.length, 4);
    assert.deepEqual(
      result.clamped.map(({ path }) => path),
      result.restored,
    );
    for (const { kept } of result.clamped) {
      assert.ok(Date.parse(kept) > Date.parse("2026-07-01T10:00:00.000Z"));
    }
    assert.equal(process.exitCode, 1);
  });

  it(
    "reports 1601-01-01 on Windows, which NTFS takes as leave the time alone",
    { skip: process.platform === "win32" ? false : "a Windows-only time" },
    async () => {
      snapshot = {
        entries: new Map([
          [
            "/data/epoch.txt",
            { size: 3, mtime: "1601-01-01T00:00:00.000Z", hash: "aaa" },
          ],
        ]),
        dirs: ["/data"],
      };

      const result = await restore([], { set: "photos", output });

      assert.deepEqual(result.restored, [dest("epoch.txt")]);
      assert.deepEqual(
        result.clamped.map(({ path }) => path),
        [dest("epoch.txt")],
      );
      assert.equal(process.exitCode, 1);
    },
  );

  it(
    "doesn't read back a time Node misreads on Windows",
    { skip: process.platform === "win32" ? false : "a Windows-only guard" },
    async () => {
      snapshot = {
        entries: new Map([
          [
            "/data/far.txt",
            { size: 3, mtime: "2300-01-01T00:00:00.000Z", hash: "aaa" },
          ],
        ]),
        dirs: ["/data"],
      };

      const result = await restore([], { set: "photos", output });

      assert.deepEqual(result.restored, [dest("far.txt")]);
      assert.deepEqual(result.clamped, []);
    },
  );
});

describe("restore --output places only the directories it restores from", () => {
  const twoPhotos = {
    entries: new Map([
      ["/a/Photos/x.jpg", { ...at, hash: "aaa" }],
      ["/b/Photos/y.jpg", { ...at, hash: "bbb" }],
    ]),
    dirs: ["/a/Photos", "/b/Photos"],
  };

  it("refuses two directories that would share a folder", async () => {
    snapshot = twoPhotos;

    await assert.rejects(restore([], { set: "photos", output }), {
      message: /would both land in a folder named "Photos"/,
    });
  });

  it("restores one of them with a path filter, as the refusal says", async () => {
    snapshot = twoPhotos;

    const result = await restore(["/b/Photos"], { set: "photos", output });

    assert.deepEqual(result.restored, [join(output, "Photos", "y.jpg")]);
  });
});

describe("restore with content shared by several paths", () => {
  it("downloads each content once and copies it to every other path", async () => {
    const result = await restore([], { set: "photos", output });

    assert.deepEqual(fetched, ["aaa", "bbb", "ccc"]);
    assert.equal(result.restored.length, 4);
    assert.equal(readFileSync(dest("gone-copy.txt"), "utf8"), "bbb");
  });

  it("still copies rather than downloads under --overwrite", async () => {
    mkdirSync(join(output, "data"));
    for (const name of ["first.txt", "gone.txt", "gone-copy.txt", "last.txt"]) {
      writeFileSync(dest(name), "old");
    }

    const result = await restore([], {
      set: "photos",
      output,
      overwrite: true,
    });

    assert.deepEqual(fetched, ["aaa", "bbb", "ccc"]);
    assert.equal(result.restored.length, 4);
    assert.equal(readFileSync(dest("gone-copy.txt"), "utf8"), "bbb");
  });

  it("never copies from a file it skipped, whose content is unverified", async () => {
    mkdirSync(join(output, "data"));
    writeFileSync(dest("gone.txt"), "stale");

    const result = await restore([], { set: "photos", output });

    assert.deepEqual(result.skipped, [dest("gone.txt")]);
    assert.deepEqual(fetched, ["aaa", "bbb", "ccc"]);
    assert.equal(readFileSync(dest("gone-copy.txt"), "utf8"), "bbb");
  });

  it("copies from the next path that landed when the first one's name was refused", async () => {
    snapshot = {
      entries: new Map([
        [`/data/a-${long}`, { ...at, hash: "bbb" }], // refused at the download
        ["/data/b-second.txt", { ...at, hash: "bbb" }],
        ["/data/c-third.txt", { ...at, hash: "bbb" }],
      ]),
      dirs: ["/data"],
    };

    const result = await restore([], { set: "photos", output });

    assert.deepEqual(result.refused, [dest(`a-${long}`)]);
    assert.deepEqual(result.restored, [
      dest("b-second.txt"),
      dest("c-third.txt"),
    ]);
    assert.deepEqual(fetched, ["bbb", "bbb"]);
    assert.equal(readFileSync(dest("c-third.txt"), "utf8"), "bbb");
  });

  it("copies from the next path that landed when the first one collided", async (t) => {
    // Only a filesystem that folds case can collide `File.txt` with `file.txt`.
    mkdirSync(join(output, "data"));
    writeFileSync(dest("probe.tmp"), "");
    if (!existsSync(dest("PROBE.TMP"))) {
      t.skip("filesystem is case-sensitive");
      return;
    }
    rmSync(dest("probe.tmp"));
    snapshot = {
      entries: new Map([
        ["/data/File.txt", { ...at, hash: "aaa" }],
        ["/data/file.txt", { ...at, hash: "bbb" }], // collides with File.txt
        ["/data/g-second.txt", { ...at, hash: "bbb" }],
        ["/data/h-third.txt", { ...at, hash: "bbb" }],
      ]),
      dirs: ["/data"],
    };

    const result = await restore([], { set: "photos", output });

    assert.deepEqual(result.collided, [dest("file.txt")]);
    assert.deepEqual(fetched, ["aaa", "bbb"]);
    assert.equal(readFileSync(dest("h-third.txt"), "utf8"), "bbb");
  });
});

describe("restore with an object missing from the bucket", () => {
  it("skips the file, restores the rest, and reports every missing path", async () => {
    failures.set("bbb", named("NoSuchKey"));

    const result = await restore([], { set: "photos", output });

    assert.deepEqual(result.restored, [dest("first.txt"), dest("last.txt")]);
    assert.deepEqual(result.missing, [dest("gone.txt"), dest("gone-copy.txt")]);
    assert.deepEqual(result.skipped, []);
    // The run really continued: the file *after* the failure is on disk.
    assert.equal(readFileSync(dest("last.txt"), "utf8"), "ccc");
  });

  it("exits 1 so a failed restore can't look like a clean one", async () => {
    failures.set("bbb", named("NoSuchKey"));
    await restore([], { set: "photos", output });
    assert.equal(process.exitCode, 1);
  });

  it("does not re-fetch content already found missing", async () => {
    // `gone-copy.txt` shares `gone.txt`'s content, which the bucket has already
    // said it doesn't hold: asking again would only cost a request for the same
    // answer, so it is recorded as the same casualty.
    failures.set("bbb", named("NoSuchKey"));
    await restore([], { set: "photos", output });
    assert.deepEqual(fetched, ["aaa", "bbb", "ccc"]);
  });

  it("treats a provider's HEAD-style NotFound as missing too", async () => {
    failures.set("ccc", named("NotFound"));
    const result = await restore([], { set: "photos", output });
    assert.deepEqual(result.missing, [dest("last.txt")]);
  });

  it("still aborts on a failure that isn't an absent object", async () => {
    // A credentials failure is wrong about the run, not about one file —
    // swallowing it would restore nothing and report success.
    failures.set("bbb", named("AccessDenied"));
    await assert.rejects(restore([], { set: "photos", output }), {
      name: "AccessDenied",
    });
    assert.equal(process.exitCode, savedExitCode);
  });

  it("leaves the exit code alone when nothing is missing", async () => {
    const result = await restore([], { set: "photos", output });
    assert.deepEqual(result.missing, []);
    assert.equal(result.bucket, BUCKET);
    assert.equal(process.exitCode, savedExitCode);
  });

  it("never fetches the deletion records on a clean run — laziness is the happy path's price of zero", async () => {
    await restore([], { set: "photos", output });
    assert.equal(recordReads, 0);
  });
});

describe("restore with a corrupt object in the bucket", () => {
  it("skips the file, restores the rest, and reports every corrupt path", async () => {
    // Clean-room run 3's finding A1: the old restore stopped at `bbb` and never
    // reached `ccc`, whose object is fine.
    failures.set("bbb", new IntegrityError("Integrity check failed"));

    const result = await restore([], { set: "photos", output });

    assert.deepEqual(result.restored, [dest("first.txt"), dest("last.txt")]);
    // The twin sharing its content is the same casualty, recorded without a
    // second fetch.
    assert.deepEqual(result.corrupt, [dest("gone.txt"), dest("gone-copy.txt")]);
    assert.deepEqual(fetched, ["aaa", "bbb", "ccc"]);
    assert.deepEqual(result.missing, []);
    assert.equal(readFileSync(dest("last.txt"), "utf8"), "ccc");
    assert.equal(process.exitCode, 1);
  });

  it("is a fault even beside a deletion record for the same hash", async () => {
    // The record explains an *absence*. Present-but-wrong bytes are damage no
    // `delete` produces, so they never consult the records.
    failures.set("bbb", new IntegrityError("Integrity check failed"));
    deletionRecords.set("bbb", { deletedOn: "2026-07-19T14:22:41.000Z" });

    const result = await restore([], { set: "photos", output });

    assert.deepEqual(result.deleted, []);
    assert.equal(recordReads, 0);
    assert.equal(process.exitCode, 1);
  });
});

describe("restore with a name this disk refuses", () => {
  beforeEach(() => {
    // Named so the snapshot's order is also sorted order.
    snapshot = {
      entries: new Map([
        ["/data/a-first.txt", { ...at, hash: "aaa" }],
        [`/data/b-${long}`, { ...at, hash: "bbb" }], // refused at the download
        ["/data/c-copy.txt", { ...at, hash: "bbb" }], // the refused one's content
        [`/data/d-${long}/inner.txt`, { ...at, hash: "ccc" }], // refused directory
        ["/data/e-last.txt", { ...at, hash: "ddd" }],
        [`/data/f-${long}`, { ...at, hash: "ddd" }], // refused at a dedup copy
      ]),
      dirs: ["/data"],
    };
  });

  it("skips each refused file, restores the rest, and exits 1", async () => {
    // The Windows run of the clean-room `edge` set stopped dead at its first
    // form feed, eight files in, with the rest of the set never attempted.
    const result = await restore([], { set: "photos", output });

    assert.deepEqual(result.restored, [
      dest("a-first.txt"),
      dest("c-copy.txt"),
      dest("e-last.txt"),
    ]);
    assert.deepEqual(result.refused, [
      dest(`b-${long}`),
      dest(join(`d-${long}`, "inner.txt")),
      dest(`f-${long}`),
    ]);
    assert.deepEqual(result.missing, []);
    assert.deepEqual(result.corrupt, []);
    assert.equal(readFileSync(dest("e-last.txt"), "utf8"), "ddd");
    assert.equal(process.exitCode, 1);
  });

  it("leaves nothing in the tree for a name refused after its download", async () => {
    await restore([], { set: "photos", output });

    assert.deepEqual(readdirSync(join(output, "data")).sort(), [
      "a-first.txt",
      "c-copy.txt",
      "e-last.txt",
    ]);
  });

  it("fetches a refused file's content again for the next path that shares it", async () => {
    // `b-…` was never written, so nothing holds its content yet; the content is
    // sound, so `c-copy.txt` fetches it rather than going down with the name.
    // The refused directory never reaches a fetch at all, and nor does `f-…`:
    // its copy fails with the source still on disk, so the name was the
    // problem, and a fetch would download it only to be refused again.
    const result = await restore([], { set: "photos", output });

    assert.deepEqual(fetched, ["aaa", "bbb", "bbb", "ddd"]);
    assert.equal(readFileSync(dest("c-copy.txt"), "utf8"), "bbb");
    assert.ok(result.restored.includes(dest("c-copy.txt")));
  });

  it("restores a copy whose source vanished mid-run, rather than calling its name refused", async () => {
    // A source deleted after it was restored fails the copy with ENOENT and a
    // path, as a refused destination fails the rename after it. Only the
    // source's absence tells them apart.
    snapshot = {
      entries: new Map([
        ["/data/a-source.txt", { ...at, hash: "aaa" }],
        ["/data/b-other.txt", { ...at, hash: "bbb" }], // its fetch deletes a-source
        ["/data/c-copy.txt", { ...at, hash: "aaa" }], // a copy of a-source
      ]),
      dirs: ["/data"],
    };
    afterFetch = (hash) => {
      if (hash === "bbb") {
        rmSync(dest("a-source.txt"));
      }
    };

    const result = await restore([], { set: "photos", output });

    assert.deepEqual(result.refused, []);
    assert.ok(result.restored.includes(dest("c-copy.txt")));
    assert.equal(readFileSync(dest("c-copy.txt"), "utf8"), "aaa");
    assert.deepEqual(fetched, ["aaa", "bbb", "aaa"]);
    assert.equal(process.exitCode, savedExitCode);
  });

  it(
    "refuses a `:` in a name before writing anything, rather than into a stream",
    { skip: process.platform !== "win32" ? "win32-only behaviour" : false },
    async () => {
      // NTFS takes `b:stream.txt` as stream `stream.txt` of a file `b`, so a
      // write or a copy to it leaves a stray file in the listing and the
      // content where no listing shows it. Only a Windows-shaped destination
      // says so, hence only here; lib/restore.test.mjs pins the decision itself
      // on every platform.
      snapshot = {
        entries: new Map([
          ["/data/a-first.txt", { ...at, hash: "aaa" }],
          ["/data/b:stream.txt", { ...at, hash: "bbb" }], // would be a fetch
          ["/data/c-copy.txt", { ...at, hash: "bbb" }], // its content, fetched
          ["/data/d-twin.txt", { ...at, hash: "ddd" }],
          ["/data/e:twin.txt", { ...at, hash: "ddd" }], // would be a dedup copy
        ]),
        dirs: ["/data"],
      };

      const result = await restore([], { set: "photos", output });

      assert.deepEqual(result.refused, [
        dest("b:stream.txt"),
        dest("e:twin.txt"),
      ]);
      assert.deepEqual(result.restored, [
        dest("a-first.txt"),
        dest("c-copy.txt"),
        dest("d-twin.txt"),
      ]);
      assert.deepEqual(fetched, ["aaa", "bbb", "ddd"]);
      assert.deepEqual(readdirSync(join(output, "data")).sort(), [
        "a-first.txt",
        "c-copy.txt",
        "d-twin.txt",
      ]);
      assert.equal(process.exitCode, 1);
    },
  );
});

describe("restore with a local failure that isn't about one name", () => {
  it("still aborts on a full disk", async () => {
    // Carrying on would fail every remaining file the same way and bury the
    // one message that matters under a list of them.
    failures.set(
      "bbb",
      Object.assign(new Error("ENOSPC: no space left on device"), {
        code: "ENOSPC",
        path: dest("gone.txt"),
      }),
    );
    await assert.rejects(restore([], { set: "photos", output }), {
      code: "ENOSPC",
    });
    assert.equal(process.exitCode, savedExitCode);
  });

  it("still aborts on an ENOENT that names no path", async () => {
    failures.set("bbb", Object.assign(new Error("ENOENT"), { code: "ENOENT" }));
    await assert.rejects(restore([], { set: "photos", output }), {
      code: "ENOENT",
    });
  });
});

describe("restore with deliberately deleted content (ADR-0064)", () => {
  it("reports a recorded absence as deleted-with-date, not missing, and exits 0", async () => {
    failures.set("bbb", named("NoSuchKey"));
    deletionRecords.set("bbb", { deletedOn: "2026-07-19T14:22:41.000Z" });

    const result = await restore([], { set: "photos", output });

    // Both paths of the shared content are the same deliberate casualty —
    // including the twin that was never attempted.
    assert.deepEqual(result.deleted, [
      { path: dest("gone.txt"), deletedOn: "2026-07-19T14:22:41.000Z" },
      { path: dest("gone-copy.txt"), deletedOn: "2026-07-19T14:22:41.000Z" },
    ]);
    assert.deepEqual(result.missing, []);
    // Deliberate ≠ fault: the record explains the gap, so the run is clean.
    assert.equal(process.exitCode, savedExitCode);
    // The rest still restored.
    assert.equal(readFileSync(dest("last.txt"), "utf8"), "ccc");
  });

  it("fetches the records once, however many objects are absent", async () => {
    failures.set("bbb", named("NoSuchKey"));
    failures.set("ccc", named("NoSuchKey"));
    deletionRecords.set("bbb", { deletedOn: "2026-07-19T14:22:41.000Z" });

    await restore([], { set: "photos", output });

    assert.equal(recordReads, 1);
  });

  it("an unrecorded absence beside a recorded one still exits 1", async () => {
    failures.set("bbb", named("NoSuchKey")); // recorded
    failures.set("ccc", named("NoSuchKey")); // unexplained
    deletionRecords.set("bbb", { deletedOn: "2026-07-19T14:22:41.000Z" });

    const result = await restore([], { set: "photos", output });

    assert.deepEqual(
      result.deleted.map((d) => d.path),
      [dest("gone.txt"), dest("gone-copy.txt")],
    );
    assert.deepEqual(result.missing, [dest("last.txt")]);
    assert.equal(process.exitCode, 1);
  });
});

describe("restore when something on disk is in the way", () => {
  it("skips a file whose folder is a file on disk, restores the rest, and exits 1", async () => {
    // A real disk's answer, not a faked error, on NTFS and ext4 alike: EEXIST
    // for a file in the place of the file's own folder, ENOTDIR for one higher.
    mkdirSync(join(output, "data"));
    writeFileSync(dest("first.txt"), "a file, not a folder");
    snapshot = {
      entries: new Map([
        ["/data/first.txt/inner.txt", { ...at, hash: "aaa" }],
        ["/data/first.txt/deeper/inner.txt", { ...at, hash: "bbb" }],
        ["/data/last.txt", { ...at, hash: "ccc" }],
      ]),
      dirs: ["/data"],
    };

    const result = await restore([], { set: "photos", output });

    assert.deepEqual(result.blocked, [
      dest(join("first.txt", "inner.txt")),
      dest(join("first.txt", "deeper", "inner.txt")),
    ]);
    assert.deepEqual(result.restored, [dest("last.txt")]);
    assert.equal(process.exitCode, 1);
  });

  it("skips a file whose place is a folder on disk before downloading it, --overwrite or not", async () => {
    // Not "skipped, rerun with --overwrite": that can't replace a folder, and
    // would download the whole object only to fail at the rename.
    for (const overwrite of [false, true]) {
      fetched = [];
      mkdirSync(join(output, "data", "gone.txt"), { recursive: true });
      mkdirSync(join(output, "data", "gone-copy.txt"), { recursive: true });

      const result = await restore([], { set: "photos", output, overwrite });

      assert.deepEqual(result.blocked, [
        dest("gone.txt"),
        dest("gone-copy.txt"),
      ]);
      assert.deepEqual(fetched, ["aaa", "ccc"]);
      assert.equal(process.exitCode, 1);
      rmSync(join(output, "data"), { recursive: true });
    }
  });

  it("treats a link to a folder at the destination as a file, not a folder", async (t) => {
    // Skipped like any existing file, and under --overwrite replaced where the
    // disk allows it: ext4 renames over the link, NTFS refuses with EPERM.
    mkdirSync(join(output, "elsewhere"));
    mkdirSync(join(output, "data"));
    try {
      symlinkSync(join(output, "elsewhere"), dest("first.txt"), "dir");
    } catch (error) {
      if (/** @type {NodeJS.ErrnoException} */ (error).code === "EPERM") {
        t.skip("creating a symlink needs a privilege this account lacks");
        return;
      }
      throw error;
    }

    const plain = await restore([], { set: "photos", output });
    assert.deepEqual(plain.skipped, [dest("first.txt")]);
    assert.deepEqual(plain.blocked, []);

    const over = await restore([], { set: "photos", output, overwrite: true });
    if (process.platform === "win32") {
      assert.deepEqual(over.blocked, [dest("first.txt")]);
    } else {
      assert.ok(over.restored.includes(dest("first.txt")));
      assert.ok(lstatSync(dest("first.txt")).isFile());
    }
  });

  it("treats a junction to a folder that's gone as in the way on NTFS, and replaces it elsewhere", async () => {
    // A junction needs no privilege on Windows; elsewhere the type is ignored
    // and it's a plain dangling link, which the rename replaces.
    mkdirSync(join(output, "data"));
    mkdirSync(join(output, "gone-folder"));
    symlinkSync(join(output, "gone-folder"), dest("first.txt"), "junction");
    rmSync(join(output, "gone-folder"), { recursive: true });

    const plain = await restore([], { set: "photos", output });
    assert.deepEqual(plain.skipped, [dest("first.txt")]);

    const over = await restore([], { set: "photos", output, overwrite: true });
    if (process.platform === "win32") {
      assert.deepEqual(over.blocked, [dest("first.txt")]);
    } else {
      assert.ok(over.restored.includes(dest("first.txt")));
      assert.ok(lstatSync(dest("first.txt")).isFile());
    }
  });

  it("replaces a link at a copied path under --overwrite, never writing through it", async (t) => {
    // `gone-copy.txt` shares `gone.txt`'s content, so it is copied from it.
    mkdirSync(join(output, "data"));
    writeFileSync(join(output, "outside.txt"), "precious");
    try {
      symlinkSync(join(output, "outside.txt"), dest("gone-copy.txt"), "file");
    } catch (error) {
      if (/** @type {NodeJS.ErrnoException} */ (error).code === "EPERM") {
        t.skip("creating a symlink needs a privilege this account lacks");
        return;
      }
      throw error;
    }

    const result = await restore([], {
      set: "photos",
      output,
      overwrite: true,
    });

    assert.deepEqual(fetched, ["aaa", "bbb", "ccc"]);
    assert.ok(result.restored.includes(dest("gone-copy.txt")));
    assert.ok(lstatSync(dest("gone-copy.txt")).isFile());
    assert.equal(readFileSync(dest("gone-copy.txt"), "utf8"), "bbb");
    assert.equal(readFileSync(join(output, "outside.txt"), "utf8"), "precious");
  });

  it("replaces a link to a file restored earlier in the run under --overwrite, rather than calling it collided", async (t) => {
    snapshot = {
      entries: new Map([
        ["/data/a.txt", { ...at, hash: "aaa" }],
        ["/data/b.txt", { ...at, hash: "bbb" }],
      ]),
      dirs: ["/data"],
    };
    mkdirSync(join(output, "data"));
    writeFileSync(dest("a.txt"), "old");
    try {
      symlinkSync(dest("a.txt"), dest("b.txt"), "file");
    } catch (error) {
      if (/** @type {NodeJS.ErrnoException} */ (error).code === "EPERM") {
        t.skip("creating a symlink needs a privilege this account lacks");
        return;
      }
      throw error;
    }

    const result = await restore([], {
      set: "photos",
      output,
      overwrite: true,
    });

    assert.deepEqual(result.collided, []);
    assert.ok(lstatSync(dest("b.txt")).isFile());
    assert.equal(readFileSync(dest("b.txt"), "utf8"), "bbb");
    assert.equal(readFileSync(dest("a.txt"), "utf8"), "aaa");
  });

  it("skips a file whose place became a folder mid-run, at the download and at a copy", async () => {
    // A real disk's answer again: EPERM on NTFS, EISDIR on ext4, named for the
    // source of the rename or the copy. The folders appear after the plan, as
    // another row's folder would.
    afterFetch = (hash) => {
      if (hash === "bbb") {
        mkdirSync(dest("gone-copy.txt"));
        mkdirSync(dest("last.txt"));
      }
    };

    const result = await restore([], { set: "photos", output });

    assert.deepEqual(result.restored, [dest("first.txt"), dest("gone.txt")]);
    assert.deepEqual(result.blocked, [
      dest("gone-copy.txt"), // copied from gone.txt
      dest("last.txt"), // downloaded
    ]);
    assert.deepEqual(fetched, ["aaa", "bbb", "ccc"]);
    assert.equal(process.exitCode, 1);
  });
});

describe("restore with a snapshot row the reader refused (ADR-0101)", () => {
  const reason = "its hash isn't 64 lowercase hex digits";

  it("restores the rest, reports the path with why, and exits 1", async () => {
    snapshot = { ...fourFiles, refused: new Map([["/data/torn.txt", reason]]) };

    const result = await restore([], { set: "photos", output });

    assert.deepEqual(result.invalid, [{ path: "/data/torn.txt", reason }]);
    assert.equal(result.restored.length, 4);
    assert.equal(process.exitCode, 1);
  });

  it("answers a request for just that path with the refusal, not 'no match'", async () => {
    snapshot = { ...fourFiles, refused: new Map([["/data/torn.txt", reason]]) };

    const result = await restore(["/data/torn.txt"], { set: "photos", output });

    assert.deepEqual(result.invalid, [{ path: "/data/torn.txt", reason }]);
    assert.deepEqual(fetched, []);
  });
});
