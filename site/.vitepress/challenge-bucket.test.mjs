import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createReadStream, readFileSync, readdirSync } from "node:fs";
import { mkdtempDisposable } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { gunzipSync } from "node:zlib";
import { parseCompressedSnapshotStream } from "../../src/lib/snapshot-file.mjs";
import { writeChallengeBucket } from "./challenge-bucket.mjs";

describe("the challenge bucket", () => {
  // The steps of the answer on site/challenge.md, redone with nothing but
  // Node's built-ins: if the bucket stops being recoverable by hand, so does
  // the page. Its bash and PowerShell aren't run here, so an edit to those
  // still needs trying by hand.
  it("gives beach.jpg back by the challenge's own answer", async () => {
    await using bucket = await mkdtempDisposable(join(tmpdir(), "s3cab-cb-"));
    await writeChallengeBucket(bucket.path);

    // The newest snapshot, from the listing: a key named for its minute,
    // directly under the set's folder, sorting last.
    const listing = readFileSync(join(bucket.path, "index.html"), "utf8");
    const latest = [...listing.matchAll(/<Key>([^<]*)<\/Key>/g)]
      .map(([, key = ""]) => key)
      .filter((key) => /^snapshots\/photos\/\d{8}T\d{4}\.tsv\.gz$/.test(key))
      .sort()
      .at(-1);
    assert.equal(latest, "snapshots/photos/20260814T0930.tsv.gz");

    // Decompressed, its last line is the `.` that says it's whole.
    const lines = gunzipSync(readFileSync(join(bucket.path, latest)))
      .toString("utf8")
      .split("\n");
    assert.deepEqual(lines.slice(-2), [".", ""]);

    // Its one file row whose path ends in \beach.jpg, and that row's hash.
    const rows = lines
      .map((line) => line.split("\t"))
      .filter(
        ([type, , , , path]) => type === "-" && path?.endsWith("\\beach.jpg"),
      );
    assert.equal(rows.length, 1);
    const hash = rows[0]?.[1]?.trim() ?? "";

    // The object at that hash is the file: its SHA-256 is the key.
    const object = readFileSync(join(bucket.path, "objects", hash));
    assert.equal(createHash("sha256").update(object).digest("hex"), hash);
    assert.deepEqual(
      object,
      readFileSync(new URL("../challenge/samples/beach.jpg", import.meta.url)),
    );
  });

  // The preamble rows are written by hand, beside s3cab's writer rather than
  // by it, so s3cab's own reader is the check that they still make a valid
  // snapshot.
  it("holds snapshots s3cab reads whole, every path restorable", async () => {
    await using bucket = await mkdtempDisposable(join(tmpdir(), "s3cab-cb-"));
    await writeChallengeBucket(bucket.path);

    const dir = join(bucket.path, "snapshots", "photos");
    const names = readdirSync(dir);
    assert.equal(names.length, 4);
    for (const name of names) {
      const snapshot = await parseCompressedSnapshotStream(
        createReadStream(join(dir, name)),
      );
      assert.deepEqual([...snapshot.refused], [], name);
      assert.deepEqual(snapshot.dirs, ["C:\\Users\\me\\Photos\\"], name);
      assert.ok(snapshot.entries.size > 0, name);
    }
  });

  // What the answer's closing paragraph says of the first two snapshots.
  it("stores a copy and a move once, five objects in all", async () => {
    await using bucket = await mkdtempDisposable(join(tmpdir(), "s3cab-cb-"));
    await writeChallengeBucket(bucket.path);

    /** @param {string} name */
    const hashes = (name) =>
      new Map(
        gunzipSync(readFileSync(join(bucket.path, "snapshots", "photos", name)))
          .toString("utf8")
          .split("\n")
          .map((line) => line.split("\t"))
          .filter(([type]) => type === "-")
          .map(([, hash = "", , , path = ""]) => [
            path.slice(path.lastIndexOf("\\") + 1),
            hash.trim(),
          ]),
      );
    const first = hashes("20251110T2104.tsv.gz");
    const second = hashes("20251111T0830.tsv.gz");
    assert.equal(second.get("brand-logo.png"), second.get("logo.png"));
    assert.equal(second.get("diary.txt"), first.get("notes.txt"));
    assert.equal(readdirSync(join(bucket.path, "objects")).length, 5);
  });

  it("is the same bytes every time it is built", async () => {
    await using first = await mkdtempDisposable(join(tmpdir(), "s3cab-cb-"));
    await using second = await mkdtempDisposable(join(tmpdir(), "s3cab-cb-"));
    await writeChallengeBucket(first.path);
    await writeChallengeBucket(second.path);

    const files = readdirSync(first.path, {
      recursive: true,
      withFileTypes: true,
    })
      .filter((entry) => entry.isFile())
      .map((entry) =>
        join(entry.parentPath, entry.name).slice(first.path.length),
      );
    assert.ok(files.length > 0);
    for (const file of files) {
      assert.deepEqual(
        readFileSync(second.path + file),
        readFileSync(first.path + file),
        file,
      );
    }
  });
});
