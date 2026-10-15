import assert from "node:assert/strict";
import { mkdtempDisposable } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { reattach } from "./reattach.mjs";
import { writeSet } from "../lib/sets.mjs";
import { useTempHome } from "../../test/helpers/temp-home.mjs";

// Offline reattach tests (docs/design/backup.md, ADR-0053, ADR-0108): the
// validation that fires before any network touch. What it does with the bucket
// is reattach.attach.test.mjs, and against a real one the gated
// test/integration/set-lifecycle.test.mjs. The set store keeps no module state,
// so each test points S3CAB_HOME at a temp dir.

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

describe("reattach (offline validation)", () => {
  it("requires a set name", async () => {
    await using dir = await mkTmpDir();
    useTempHome(dir.path);

    await assert.rejects(
      () => reattach(undefined, [], { bucket: "b" }),
      /Missing required argument: set/,
    );
  });

  it("rejects an invalid set name, teaching the rule and a kebab form", async () => {
    await using dir = await mkTmpDir();
    useTempHome(dir.path);

    await assert.rejects(
      () => reattach("My Photos", [], { bucket: "b" }),
      /Invalid set name: My Photos[\s\S]*Try: my-photos/,
    );
  });

  it("takes no directories (they are the holder's)", async () => {
    await using dir = await mkTmpDir();
    useTempHome(dir.path);

    await assert.rejects(
      () => reattach("photos", [dir.path], { bucket: "b" }),
      /takes no directories/,
    );
  });

  it("needs the bucket holding a set that isn't here yet", async () => {
    await using dir = await mkTmpDir();
    useTempHome(dir.path);

    await assert.rejects(
      () => reattach("photos", [], {}),
      /isn't on this machine yet[\s\S]*--bucket <bucket>/,
    );
  });

  it("rejects an s3:// URL passed as the bucket", async () => {
    await using dir = await mkTmpDir();
    useTempHome(dir.path);

    await assert.rejects(
      () => reattach("photos", [], { bucket: "s3://my-bucket" }),
      /Invalid bucket name[\s\S]*not a URL/,
    );
  });

  it("refuses to refresh a set from a bucket it isn't attached from", async () => {
    await using dir = await mkTmpDir();
    useTempHome(dir.path);
    // A set already exists locally (written straight to the store, no S3).
    writeSet("photos", { dirs: [dir.path], bucket: "my-bucket" });

    await assert.rejects(
      () => reattach("photos", [], { bucket: "other-bucket" }),
      /attached from bucket 'my-bucket', not 'other-bucket'/,
    );
  });
});
