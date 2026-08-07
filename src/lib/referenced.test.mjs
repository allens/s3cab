import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  isCorruptSnapshotError,
  safeSize,
  sizeDisagreements,
  unreadableMessage,
  unreadableSnapshots,
} from "./referenced.mjs";

// Pure unit tests for the referenced-object enumeration's shared vocabulary —
// the bucket-wide unreadable list every consumer used to derive itself, the one
// message the three commands build from it, the damage classifier that says
// which read failures become findings at all, and the two questions the `sizes`
// Set exists to answer.

/**
 * A `ReferencedObject` from a compact spec: path → the sizes its rows record,
 * optionally with the snapshots referencing it. The torn case — one path at two
 * sizes — is the whole reason `sizes` is a Set, so the helper has to be able to
 * express it.
 * @param {Record<string, number[] | { sizes: number[], snapshots: string[] }>} spec
 */
const object = (spec) => ({
  paths: new Map(
    Object.entries(spec).map(([path, value]) => {
      const { sizes, snapshots } = Array.isArray(value)
        ? { sizes: value, snapshots: ["s1"] }
        : value;
      return [path, { sizes: new Set(sizes), snapshots: new Set(snapshots) }];
    }),
  ),
});

/**
 * A `Map<set, ReferencedResult>` carrying only the field under test: each set
 * maps to the snapshot names that failed to read. `referenced`/`snapshotsChecked`
 * are irrelevant here, so they stay empty rather than being faked.
 * @param {Record<string, string[]>} spec - set → unreadable snapshot names
 */
const enumeration = (spec) =>
  new Map(
    Object.entries(spec).map(([set, names]) => [
      set,
      {
        referenced: new Map(),
        snapshotsChecked: 0,
        unreadable: names.map((snapshot) => ({ snapshot, reason: "zstd" })),
      },
    ]),
  );

describe("unreadableSnapshots", () => {
  it("qualifies each snapshot with its set, bucket-wide", () => {
    const names = unreadableSnapshots(
      enumeration({
        "work-laptop": ["2026-07-30-1400", "2026-07-29-0900"],
        photos: ["2026-07-28-0900"],
      }),
    );

    assert.deepEqual(names, [
      "work-laptop/2026-07-30-1400",
      "work-laptop/2026-07-29-0900",
      "photos/2026-07-28-0900",
    ]);
  });

  it("is empty when every snapshot read — the healthy case", () => {
    const names = unreadableSnapshots(
      enumeration({ "work-laptop": [], photos: [] }),
    );

    assert.deepEqual(names, []);
  });

  it("skips the sets that read cleanly rather than emitting a hole", () => {
    const names = unreadableSnapshots(
      enumeration({ "work-laptop": [], photos: ["2026-07-28-0900"] }),
    );

    assert.deepEqual(names, ["photos/2026-07-28-0900"]);
  });
});

describe("unreadableMessage", () => {
  const names = ["work-laptop/2026-07-30-1400", "photos/2026-07-28-0900"];

  it("leads with the blocked goal, lists every name, and ends with the exact fix", () => {
    const message = unreadableMessage({
      names,
      bucket: "my-bucket",
      lead: "Can't clean up safely",
      consequence:
        "objects nothing else references would look unused and be deleted",
    });

    assert.equal(
      message,
      "Can't clean up safely — these snapshots can't be read, so objects " +
        "nothing else references would look unused and be deleted:\n" +
        "  work-laptop/2026-07-30-1400\n" +
        "  photos/2026-07-28-0900\n" +
        "Check them with:\n" +
        "  s3cab verify my-bucket",
    );
  });

  it("agrees in number with a single unreadable snapshot", () => {
    // One damaged snapshot is the *likelier* case, so it must not read as
    // though several were found. The caller's `consequence` carries no number
    // (that is the contract), leaving this the only agreement to make.
    const message = unreadableMessage({
      names: ["photos/2026-07-28-0900"],
      bucket: "my-bucket",
      lead: "Can't delete safely",
      consequence:
        "an unknown reference could be the only thing keeping this content alive",
    });

    assert.equal(
      message,
      "Can't delete safely — this snapshot can't be read, so an unknown " +
        "reference could be the only thing keeping this content alive:\n" +
        "  photos/2026-07-28-0900\n" +
        "Check it with:\n" +
        "  s3cab verify my-bucket",
    );
  });

  it("opens on the snapshots themselves when there is no blocked goal to name", () => {
    const message = unreadableMessage({
      names: ["photos/2026-07-28-0900"],
      bucket: "my-bucket",
      consequence: "this preview may overstate what becomes unrestorable",
    });

    assert.equal(
      message,
      "This snapshot can't be read, so this preview may overstate what " +
        "becomes unrestorable:\n" +
        "  photos/2026-07-28-0900\n" +
        "Check it with:\n" +
        "  s3cab verify my-bucket",
    );
  });

  it("names every unreadable snapshot — a damage report never elides", () => {
    const many = Array.from({ length: 40 }, (_, i) => `set-${i}/snap`);
    const message = unreadableMessage({
      names: many,
      bucket: "my-bucket",
      lead: "Can't delete safely",
      consequence: "one could be the only thing keeping this content alive",
    });

    for (const name of many) {
      assert.ok(message.includes(`  ${name}\n`), `${name} is listed`);
    }
  });

  it("fills the bucket into the fix, so it pastes as-is", () => {
    const message = unreadableMessage({
      names,
      bucket: "some-other-bucket",
      consequence: "the numbers may be wrong",
    });

    assert.ok(message.endsWith("\n  s3cab verify some-other-bucket"));
  });
});

describe("isCorruptSnapshotError", () => {
  it("treats a snapshot-parse assertion as corruption (a finding)", () => {
    const error = new assert.AssertionError({ message: "Malformed line" });
    assert.equal(isCorruptSnapshotError(error), true);
  });

  it("treats a zstd decompression failure as corruption (a finding)", () => {
    const error = Object.assign(new Error("Unknown frame descriptor"), {
      code: "ZSTD_error_prefix_unknown",
    });
    assert.equal(isCorruptSnapshotError(error), true);
  });

  it("does NOT treat an operational S3 error as corruption (it aborts)", () => {
    const notFound = Object.assign(new Error("nope"), { name: "NoSuchKey" });
    assert.equal(isCorruptSnapshotError(notFound), false);
    assert.equal(isCorruptSnapshotError(new Error("network down")), false);
    assert.equal(isCorruptSnapshotError("not even an error"), false);
  });
});

describe("safeSize", () => {
  it("is the recorded size for a healthy object", () => {
    assert.equal(safeSize(object({ "photos/a.jpg": [4096] })), 4096);
  });

  it("takes the largest when a torn snapshot recorded one path twice", () => {
    // Overstating what a deletion frees is harmless; understating it is not.
    assert.equal(safeSize(object({ "photos/a.jpg": [4096, 9001] })), 9001);
  });

  it("takes the largest across paths, not the first or the last", () => {
    const shared = object({
      "photos/a.jpg": [4096],
      "backup/a.jpg": [9001],
      "archive/a.jpg": [2048],
    });
    assert.equal(safeSize(shared), 9001);
  });

  it("is 0 for an object with no paths, rather than -Infinity or NaN", () => {
    // A degenerate shape the enumeration never builds; asserted so a future
    // `Math.max(...[])` rewrite can't quietly return -Infinity into a byte total.
    assert.equal(safeSize(object({})), 0);
  });
});

describe("sizeDisagreements", () => {
  it("finds nothing when every recorded size matches storage", () => {
    const healthy = object({ "photos/a.jpg": [4096], "b.jpg": [4096] });
    assert.deepEqual(sizeDisagreements(healthy, 4096), []);
  });

  it("reports the path, the recorded size and the stored size it contradicts", () => {
    const wrong = object({
      "photos/a.jpg": { sizes: [512], snapshots: ["2026-08-01-0900"] },
    });

    assert.deepEqual(sizeDisagreements(wrong, 4096), [
      {
        path: "photos/a.jpg",
        snapshots: ["2026-08-01-0900"],
        recordedSize: 512,
      },
    ]);
  });

  it("yields a row per bad size on a torn path, keeping the good one silent", () => {
    // The second size must not hide behind the first — each is checked against
    // the one stored object independently.
    const torn = object({ "photos/a.jpg": [4096, 512, 99] });
    const found = sizeDisagreements(torn, 4096);

    assert.deepEqual(
      found.map(({ recordedSize }) => recordedSize).sort((a, b) => a - b),
      [99, 512],
    );
  });

  it("checks every path, so a second file's bad size is its own row", () => {
    const two = object({ "photos/a.jpg": [4096], "backup/a.jpg": [512] });
    const found = sizeDisagreements(two, 4096);

    assert.deepEqual(
      found.map(({ path }) => path),
      ["backup/a.jpg"],
    );
  });

  it("sorts snapshots, so a report never varies with encounter order", () => {
    const wrong = object({
      "photos/a.jpg": { sizes: [512], snapshots: ["2026-08-02", "2026-08-01"] },
    });

    assert.deepEqual(sizeDisagreements(wrong, 4096)[0]?.snapshots, [
      "2026-08-01",
      "2026-08-02",
    ]);
  });

  it("gives every row of a torn path the same sorted snapshots", () => {
    // The sort is hoisted to once per path, so the rows share one array. They
    // must still each read as sorted — a reader of row two is owed the same
    // order as row one.
    const torn = object({
      "photos/a.jpg": {
        sizes: [512, 99],
        snapshots: ["2026-08-02", "2026-08-01"],
      },
    });
    const found = sizeDisagreements(torn, 4096);

    assert.equal(found.length, 2);
    for (const row of found) {
      assert.deepEqual(row.snapshots, ["2026-08-01", "2026-08-02"]);
    }
  });
});
