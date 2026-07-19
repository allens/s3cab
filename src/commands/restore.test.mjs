import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { restore } from "./restore.mjs";

// The pure restore-planning functions (selectEntries, reroot, planRestore) are
// unit-tested in lib/restore.test.mjs; the backup → restore round trip against a
// real bucket lives in test/integration/backup-restore-roundtrip.test.mjs. This file covers the
// command's offline argument validation, which happens before any cloud access.

describe("restore arguments", () => {
  it("requires the set name — no sole-set default (ADR-0040)", async () => {
    // Named by --set, not a positional: the paths are the bulk operand (ADR-0062).
    await assert.rejects(restore([]), {
      code: "ERR_PARSE_ARGS",
      message: "Missing required argument: set",
    });
  });

  it("rejects paths given with no --set rather than reading one as the set", async () => {
    // The pre-ADR-0062 shape took the set as the first positional, so this call
    // would have restored a set named after the path. It must be a usage error.
    await assert.rejects(restore(["C:\\Users\\me\\Photos\\beach.jpg"]), {
      code: "ERR_PARSE_ARGS",
      message: "Missing required argument: set",
    });
  });
});
