import assert from "node:assert/strict";
import { mkdtempDisposable } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { reattach } from "./reattach.mjs";
import { writeSet } from "../lib/sets.mjs";
import { useTempHome } from "../../test/helpers/temp-home.mjs";

// Offline reattach tests (docs/design/backup.md, ADR-0053): the pre-S3
// validation that fires before any network touch. Reattach adopts an existing
// *remote* set (split out of `setup --inherit`), so its create-vs-adopt sibling
// `setup` is tested in setup.test.mjs; the real-bucket adopt behaviour lives in
// the gated test/integration/set-lifecycle.test.mjs. The set store keeps no
// module state, so each test points S3CAB_HOME at a temp dir.

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
      /Missing required argument: <set>/,
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

  it("takes no directories (it adopts the remote's dirs)", async () => {
    await using dir = await mkTmpDir();
    useTempHome(dir.path);

    await assert.rejects(
      () => reattach("photos", [dir.path], { bucket: "b" }),
      /takes no directories/,
    );
  });

  it("needs a bucket (the one holding the set), with a copy-pasteable fix", async () => {
    await using dir = await mkTmpDir();
    useTempHome(dir.path);

    await assert.rejects(
      () => reattach("photos", [], {}),
      /Reattaching needs the bucket[\s\S]*s3cab reattach photos --bucket/,
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

  it("refuses when the set already exists on this machine", async () => {
    await using dir = await mkTmpDir();
    useTempHome(dir.path);
    // A set already exists locally (written straight to the store, no S3).
    writeSet("photos", { dirs: [dir.path], bucket: "my-bucket" });

    await assert.rejects(
      () => reattach("photos", [], { bucket: "my-bucket" }),
      /already exists on this machine[\s\S]*Delete it first/,
    );
  });
});
