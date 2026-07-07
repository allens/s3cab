import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { restore } from "./restore.mjs";

// The pure restore-planning functions (selectEntries, reroot, planRestore) are
// unit-tested in lib/restore.test.mjs; the backup → restore round trip against a
// real bucket lives in restore.integration.test.mjs. This file covers the
// command's offline argument validation, which happens before any cloud access.

describe("restore arguments", () => {
  it("requires the set name — no sole-set default (ADR-0040)", async () => {
    await assert.rejects(restore(undefined), {
      code: "ERR_PARSE_ARGS",
      message: "Missing required argument: <set>",
    });
  });
});
