import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderSetup } from "./render.mjs";

/** @import { BackupSet } from "./lib/sets.mjs" */

// The render layer (ADR-0043) turns a command's returned data into the
// human-readable text the dispatcher writes to stdout. Renderers are pure
// (data in, string out), so they test without any I/O — this is where a
// command's *human* output is pinned as it converts. As slices land, each new
// renderer gets its cases here.

/**
 * A minimal `BackupSet` for the renderer — it reads only name/bucket/dirs, so
 * the derived path fields are elided (cast covers the missing ones).
 * @param {string} name
 * @param {string} bucket
 * @param {string[]} dirs
 * @returns {BackupSet}
 */
const set = (name, bucket, dirs) =>
  /** @type {BackupSet} */ ({ name, bucket, dirs });

describe("renderSetup", () => {
  it("confirms the set with its bucket and member directories", () => {
    const text = renderSetup(
      set("photos", "my-backups", ["/home/me/Photos", "/home/me/Pics"]),
    );

    assert.equal(
      text,
      "Set 'photos' → bucket 'my-backups'\n" +
        "  /home/me/Photos\n" +
        "  /home/me/Pics",
    );
  });

  it("guides toward adding directories when a set has none yet", () => {
    // An inherited set can land with no member dirs (a partial/legacy remote
    // marker); the confirmation must not print an empty directory list, and
    // should point at how to add them.
    const text = renderSetup(set("photos", "my-backups", []));

    assert.match(text, /Set 'photos' → bucket 'my-backups'/);
    assert.match(text, /no directories yet/);
    assert.match(text, /s3cab setup photos <directory>\.\.\./);
  });
});
