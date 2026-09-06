import assert from "node:assert/strict";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { mkdtempDisposable } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { MINUTE_MS, VirtualClock, clockHolder } from "./harness/clock.mjs";
import { FakeS3, backendHolder } from "./harness/fake-s3.mjs";
import {
  backup,
  listSnapshotNames,
  readSnapshot,
  setup,
} from "./harness/seam.mjs";

// Every instant an artifact records is minted from the virtual clock, or the
// harness is not the deterministic tier it claims to be (CAPABILITIES.md,
// `virtual-clock`). The seam mocks format.mjs, the one module that reads the
// clock for a record, so this is the test that a new artifact field did not
// quietly read `Temporal.Now` on its own — which is what the `#END` trailer and
// the set marker's CREATED both did before this file existed.

const BUCKET = "model-bucket";

/** @type {NodeJS.ProcessEnv} */
let savedEnv;
beforeEach(() => {
  savedEnv = { ...process.env };
  clockHolder.current = new VirtualClock(Date.UTC(2026, 0, 5));
  backendHolder.current = new FakeS3();
});
afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in savedEnv)) {
      delete process.env[key];
    }
  }
  Object.assign(process.env, savedEnv);
});

describe("under the virtual clock, every recorded instant is virtual", () => {
  it("the set marker's CREATED and the snapshot's #SNAPSHOT and #END instants", async () => {
    await using dir = await mkdtempDisposable(join("test", ".tmp"));
    const home = join(dir.path, ".s3cab");
    process.env.S3CAB_HOME = home;
    const data = join(dir.path, "data");
    mkdirSync(data, { recursive: true });
    writeFileSync(join(data, "a.txt"), "hello");

    await setup([realpathSync.native(data)], { set: "clock", bucket: BUCKET });
    const marker = await backendHolder.current.getBytes(
      BUCKET,
      "sets/clock/info",
    );
    assert.match(
      String(marker),
      /^CREATED=2026-01-05T00:00:00\.000Z$/m,
      `CREATED must be the virtual clock, got:\n${String(marker)}`,
    );

    clockHolder.current.advance(MINUTE_MS);
    await backup("clock");

    const snapshotsDir = join(home, "sets", "clock", "snapshots");
    const [name] = listSnapshotNames(snapshotsDir);
    assert.equal(name, "2026-01-05T0001");
    const { instant, completed, status } = await readSnapshot(
      snapshotsDir,
      name,
    );
    assert.equal(instant, "2026-01-05T00:01:00.000Z");
    assert.equal(status, "COMPLETE");
    // The trailer is minted as the last row lands, from the same seam: no
    // virtual time passes inside a pass, so it equals the header's instant.
    assert.equal(completed, "2026-01-05T00:01:00.000Z");
  });
});
