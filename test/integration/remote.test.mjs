import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtempDisposable } from "node:fs/promises";
import { join, resolve } from "node:path";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { zstdCompressSync } from "node:zlib";
import {
  deleteObject,
  getStream,
  listObjects,
  putText,
} from "../../src/lib/s3.mjs";
import {
  parseCompressedSnapshotStream,
  readSnapshot,
  snapshotFileName,
} from "../../src/lib/snapshot-file.mjs";
import {
  deleteRemoteSnapshot,
  downloadRemoteSnapshots,
  listRemoteSnapshots,
  readLatestRemoteSnapshot,
  readRemoteSnapshot,
  referencedObjects,
  remoteSnapshotsPrefix,
  remoteSnapshotUri,
} from "../../src/lib/remote.mjs";
import { isCorruptSnapshotError } from "../../src/lib/referenced.mjs";
import { uploadSnapshot, uploadSnapshotFile } from "../../src/lib/upload.mjs";
import { writeSnapshot } from "../helpers/write-snapshot.mjs";
import { bucket } from "../helpers/integration.mjs";

// The remote engine's S3 round-trips against a real test bucket (S3 test strategy,
// docs/design/testing.md). The gate/harness lives in the shared integration
// helper; the pure name-sorting these listers reuse is covered without a bucket by
// remote.test.mjs / list.test.mjs. These work off an explicit temp `snapshotDir`,
// so they keep no s3cab home and resolve AWS credentials from the ambient chain.
const mkTmpDir = async () => mkdtempDisposable(join("test", ".tmp"));

/** @type {NodeJS.ProcessEnv} */
let savedEnv;
beforeEach(() => {
  savedEnv = { ...process.env };
});
afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in savedEnv)) {
      delete process.env[key];
    }
  }
  Object.assign(process.env, savedEnv);
});

describe("remote snapshot listing (real bucket)", () => {
  it("returns no snapshots for a set that has none yet", async () => {
    // A unique set name no backup has ever written to, so the listing is
    // empty without seeding or cleanup.
    const set = `empty-${Date.now()}`;
    assert.deepEqual(await listRemoteSnapshots(bucket, set), []);
    // A set with no remote snapshot yet diffs against an empty lookup, so every
    // target hash is a candidate (its first backup uploads everything).
    assert.deepEqual(await readLatestRemoteSnapshot(bucket, set), {
      name: undefined,
      lookup: new Map(),
    });
  });
});

describe("downloadRemoteSnapshots (real bucket)", () => {
  it("returns 0 for a set with no remote snapshots", async () => {
    await using dir = await mkTmpDir();
    const set = `empty-dl-${Date.now()}`;
    const pulled = await downloadRemoteSnapshots(
      bucket,
      set,
      join(dir.path, "snapshots"),
    );
    assert.equal(pulled, 0);
  });

  it("pulls each snapshot file down byte-identically (the reattach sync, ADR-0027)", async () => {
    await using dir = await mkTmpDir();
    const set = `dl-${Date.now()}`;
    const name = "2025-02-20T0900";

    const contentDir = resolve(dir.path, "content");
    mkdirSync(contentDir, { recursive: true });
    const fileA = join(contentDir, "a.txt");
    writeFileSync(fileA, `gamma ${set}`);

    const snapshotDir = join(dir.path, "snapshots");
    mkdirSync(snapshotDir, { recursive: true });
    await writeSnapshot(snapshotDir, name, [fileA]);
    const { entries: original } = await readSnapshot(snapshotDir, name);
    const hashes = [...new Set([...original.values()].map((p) => p.hash))];

    const destDir = join(dir.path, "pulled");
    try {
      await uploadSnapshot({ bucket, set, snapshotDir, name });

      const pulled = await downloadRemoteSnapshots(bucket, set, destDir);
      assert.equal(pulled, 1);

      // Verbatim copy: byte-identical to the local snapshot that was uploaded.
      assert.deepEqual(
        readFileSync(join(destDir, `${name}.tsv.zst`)),
        readFileSync(join(snapshotDir, `${name}.tsv.zst`)),
      );
      // And it parses back to the same entries, so a local compare/list can use it.
      const { entries: roundTripped } = await readSnapshot(destDir, name);
      assert.deepEqual(roundTripped, original);
    } finally {
      for (const hash of hashes) {
        await deleteObject(`s3://${bucket}/objects/${hash}`);
      }
      await deleteObject(
        `s3://${bucket}/${remoteSnapshotsPrefix(set)}${name}.tsv.zst`,
      );
    }
  });
});

describe("referencedObjects (real bucket)", () => {
  it("unions a set's snapshot hashes and flags an unreadable snapshot", async () => {
    await using dir = await mkTmpDir();
    const set = `ref-${Date.now()}`;
    const name = "2025-03-10T0800";

    const contentDir = resolve(dir.path, "content");
    mkdirSync(contentDir, { recursive: true });
    const fileA = join(contentDir, "a.txt");
    writeFileSync(fileA, `refobj ${set}`);

    const snapshotDir = join(dir.path, "snapshots");
    mkdirSync(snapshotDir, { recursive: true });
    await writeSnapshot(snapshotDir, name, [fileA]);
    const { entries } = await readSnapshot(snapshotDir, name);
    const [props] = [...entries.values()];
    assert.ok(props, "the seeded snapshot has one entry");
    const { hash, size } = props;
    const hashes = [...new Set([...entries.values()].map((p) => p.hash))];

    // A second, garbage snapshot object under a valid-looking name: it lists but
    // fails to decompress, so it must be recorded unreadable (not abort the run).
    const badName = "2025-03-10T0900";
    const badKey = `${remoteSnapshotsPrefix(set)}${badName}.tsv.zst`;

    try {
      await uploadSnapshot({ bucket, set, snapshotDir, name });
      await putText(`s3://${bucket}/${badKey}`, "not a zstd stream");

      // Bucket-wide, grouped by set: pick out the set this test wrote (the shared
      // test bucket may hold other sets from concurrent runs).
      const bySet = await referencedObjects(bucket);
      const result = bySet.get(set);
      assert.ok(result, "the test's set is present in the enumeration");
      const { referenced, snapshotsChecked, unreadable } = result;

      assert.equal(snapshotsChecked, 1);
      assert.deepEqual(
        unreadable.map((u) => u.snapshot),
        [badName],
      );
      const entry = referenced.get(hash);
      assert.ok(entry, "the referenced hash is present");
      const [first] = [...entry.paths]; // one path backs this content
      assert.ok(first, "the content has a referencing path");
      const [path, pathRef] = first;
      assert.ok(path.endsWith("a.txt"));
      assert.deepEqual([...pathRef.sizes], [size]);
      assert.deepEqual([...pathRef.snapshots], [name]);
    } finally {
      for (const h of hashes) {
        await deleteObject(`s3://${bucket}/objects/${h}`);
      }
      await deleteObject(
        `s3://${bucket}/${remoteSnapshotsPrefix(set)}${name}.tsv.zst`,
      );
      await deleteObject(`s3://${bucket}/${badKey}`);
    }
  });
});

describe("snapshot read stream lifecycle (real bucket)", () => {
  // One seeded snapshot, big enough that its GetObject body spans many network
  // chunks. That size is what makes both tests mean something: the happy read
  // proves the pipeline consumes a live multi-chunk body to completion without
  // aborting the request (#171's ABORT_ERR — the reason the read was ever
  // `.pipe`), and the drop test kills a request that is genuinely still in
  // flight rather than one already buffered.
  const set = `stream-${Date.now()}`;
  const name = "2025-05-05T0700";
  const fileCount = 20_000;

  /** @type {Awaited<ReturnType<typeof mkTmpDir>>} */
  let dir;
  before(async () => {
    // Fabricated rather than walked: 20k real files would slow the suite for
    // nothing — only the bytes on the wire matter here. Chained sha256 hashes
    // keep the rows incompressible, so the object stays large after zstd.
    const rows = [
      `#SNAPSHOT\t${set}\t2025-05-05T06:00:00.000Z\t${name} Etc/UTC`,
    ];
    let hash = set;
    for (let i = 0; i < fileCount; i++) {
      hash = createHash("sha256").update(hash).digest("hex");
      rows.push(`${hash}\t${i}\t2025-05-05T06:00:00.000Z\t/data/file-${i}.bin`);
    }
    dir = await mkTmpDir();
    writeFileSync(
      join(dir.path, snapshotFileName(name)),
      zstdCompressSync(rows.join("\n")),
    );
    await uploadSnapshotFile({ bucket, set, snapshotDir: dir.path, name });
  });
  after(async () => {
    await deleteObject(remoteSnapshotUri(bucket, set, name));
    await dir.remove();
  });

  it("reads a multi-chunk body to completion — teardown must not abort the live request (#171)", async () => {
    const { entries, identity } = await readRemoteSnapshot(bucket, set, name);
    assert.equal(identity, set);
    assert.equal(entries.size, fileCount);
  });

  it(
    "fails, not stalls, when the body drops mid-download",
    { timeout: 60_000 },
    async () => {
      // readRemoteSnapshot owns its body internally, so the drop is injected at
      // the exact seam it uses: a real GetObject body handed to
      // parseCompressedSnapshotStream, destroyed on its first chunk — an
      // in-flight connection death. Before the pipeline rewrite this stalled
      // forever (`.pipe` forwards no source error), hence the timeout. The drop
      // is armed before the parse starts, so catching the first chunk doesn't
      // depend on when the pipeline's own consumption is scheduled.
      const body = await getStream(remoteSnapshotUri(bucket, set, name));
      body.once("data", () =>
        body.destroy(new Error("injected: connection dropped")),
      );
      const parsed = parseCompressedSnapshotStream(body);
      await assert.rejects(parsed, (/** @type {Error} */ error) => {
        assert.match(error.message, /connection dropped/);
        // An operational failure, not snapshot damage: a bucket scan must
        // abort on it, never record the snapshot unreadable (referenced.mjs).
        assert.equal(isCorruptSnapshotError(error), false);
        return true;
      });
    },
  );
});

describe("deleteRemoteSnapshot (real bucket)", () => {
  it("removes just the snapshot, leaving its objects in place", async () => {
    await using dir = await mkTmpDir();
    const set = `del-${Date.now()}`;
    const name = "2025-04-01T1200";

    const contentDir = resolve(dir.path, "content");
    mkdirSync(contentDir, { recursive: true });
    const fileA = join(contentDir, "a.txt");
    writeFileSync(fileA, `delete-me ${set}`);

    const snapshotDir = join(dir.path, "snapshots");
    mkdirSync(snapshotDir, { recursive: true });
    await writeSnapshot(snapshotDir, name, [fileA]);
    const { entries } = await readSnapshot(snapshotDir, name);
    const hashes = [...new Set([...entries.values()].map((p) => p.hash))];

    try {
      await uploadSnapshot({ bucket, set, snapshotDir, name });
      assert.deepEqual(await listRemoteSnapshots(bucket, set), [name]);

      await deleteRemoteSnapshot(bucket, set, name);

      // The snapshot is gone…
      assert.deepEqual(await listRemoteSnapshots(bucket, set), []);
      // …but the objects it referenced remain (delete never touches objects/).
      for (const hash of hashes) {
        const keys = [];
        for await (const o of listObjects(`s3://${bucket}/objects/${hash}`)) {
          if (o.Key) {
            keys.push(o.Key);
          }
        }
        assert.ok(
          keys.includes(`objects/${hash}`),
          `object ${hash} was removed`,
        );
      }
    } finally {
      for (const hash of hashes) {
        await deleteObject(`s3://${bucket}/objects/${hash}`);
      }
      // Best-effort: the snapshot should already be gone from the test body.
      await deleteObject(
        `s3://${bucket}/${remoteSnapshotsPrefix(set)}${name}.tsv.zst`,
      ).catch(() => {});
    }
  });
});
