import assert from "node:assert/strict";
import { realpathSync, writeFileSync } from "node:fs";
import { mkdtempDisposable } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { useTempHome } from "../../test/helpers/temp-home.mjs";
import { writeSet } from "../lib/sets.mjs";
import { listSnapshotNames } from "../lib/snapshot-file.mjs";
import { snapshot } from "./snapshot.mjs";

/** @import { TestContext } from "node:test" */

// proposals/audit-durability-2026-11-05.md. guide/format.md names the end of
// daylight saving and a move to another zone as the ways a later snapshot sorts
// first, and promises a warning. Both keep the true instant moving forward.

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

/**
 * Two snapshots of one set, each with the clock showing `moments[n]`, and what
 * the second one warned.
 * @param {TestContext} t
 * @param {[string, string]} moments - Zoned datetimes, the second a later instant
 * @returns {Promise<{ said: string, latest: string | undefined }>}
 */
async function secondSnapshotAfter(t, moments) {
  const [first, second] = moments.map((text) =>
    Temporal.ZonedDateTime.from(text),
  );
  assert.ok(
    first && second && Temporal.ZonedDateTime.compare(first, second) < 0,
  );
  let now = first;
  t.mock.method(Temporal.Now, "zonedDateTimeISO", () => now);
  const warn = t.mock.method(console, "warn", () => {});

  await using dir = await mkdtempDisposable(join("test", ".tmp"));
  useTempHome(dir.path);
  const data = realpathSync.native(dir.path);
  writeFileSync(join(data, "a.txt"), "hello");
  const { snapshotsDir } = writeSet("photos", { dirs: [data], bucket: "b" });

  await snapshot("photos", { rehash: true });
  now = second;
  warn.mock.resetCalls();
  await snapshot("photos", { rehash: true });

  return {
    said: warn.mock.calls.map((call) => String(call.arguments[0])).join("\n"),
    latest: listSnapshotNames(snapshotsDir).at(0),
  };
}

describe("a snapshot whose name sorts before the previous one's warns", () => {
  it("at the end of daylight saving", async (t) => {
    const { said, latest } = await secondSnapshotAfter(t, [
      "2025-10-26T01:45:00+01:00[Europe/London]",
      "2025-10-26T01:10:00+00:00[Europe/London]",
    ]);
    assert.equal(latest, "20251026T0145", "the older snapshot reads as latest");
    assert.match(said, /sorts before the one before it/);
  });

  it("after a move to a zone further west", async (t) => {
    const { said, latest } = await secondSnapshotAfter(t, [
      "2025-01-15T10:30:00+00:00[Europe/London]",
      "2025-01-15T06:00:00-05:00[America/New_York]",
    ]);
    assert.equal(latest, "20250115T1030", "the older snapshot reads as latest");
    assert.match(said, /sorts before the one before it/);
  });
});
