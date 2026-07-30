import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  isCorruptSnapshotError,
  unreadableMessage,
  unreadableSnapshots,
} from "./referenced.mjs";

// Pure unit tests for the referenced-object enumeration's shared vocabulary —
// the bucket-wide unreadable list every consumer used to derive itself, the one
// message the three commands build from it, and the damage classifier that says
// which read failures become findings at all.

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
