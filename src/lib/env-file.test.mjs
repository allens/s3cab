import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtempDisposable } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import { removeEnvKey, updateEnvFile } from "./env-file.mjs";

// Tests for in-place env-file editing. Each test writes to a throwaway file in a
// disposable temp dir, so they assert on the exact bytes left on disk.

const mkTmpDir = async () => mkdtempDisposable(join("test", ".tmp"));

describe("updateEnvFile", () => {
  it("creates the file with a trailing newline when it doesn't exist", async () => {
    await using dir = await mkTmpDir();
    const path = join(dir.path, "env");
    updateEnvFile(path, { AWS_PROFILE: "bert" });
    assert.equal(readFileSync(path, "utf8"), "AWS_PROFILE=bert\n");
  });

  it("appends a new key, adding a separating newline when one is missing", async () => {
    await using dir = await mkTmpDir();
    const path = join(dir.path, "env");
    writeFileSync(path, "S3CAB_BUCKET=my-bucket"); // no trailing newline
    updateEnvFile(path, { AWS_PROFILE: "bert" });
    assert.equal(
      readFileSync(path, "utf8"),
      "S3CAB_BUCKET=my-bucket\nAWS_PROFILE=bert\n",
    );
  });

  it("replaces an existing key's value in place, preserving comments", async () => {
    await using dir = await mkTmpDir();
    const path = join(dir.path, "env");
    writeFileSync(path, "# my config\nAWS_PROFILE=old\nS3CAB_BUCKET=b\n");
    updateEnvFile(path, { AWS_PROFILE: "new" });
    assert.equal(
      readFileSync(path, "utf8"),
      "# my config\nAWS_PROFILE=new\nS3CAB_BUCKET=b\n",
    );
  });

  it("updates every hand-made duplicate of a key to the same value", async () => {
    await using dir = await mkTmpDir();
    const path = join(dir.path, "env");
    writeFileSync(path, "AWS_PROFILE=one\nAWS_PROFILE=two\n");
    updateEnvFile(path, { AWS_PROFILE: "three" });
    assert.equal(
      readFileSync(path, "utf8"),
      "AWS_PROFILE=three\nAWS_PROFILE=three\n",
    );
  });
});

describe("removeEnvKey", () => {
  it("removes the key's line, preserving other lines and comments", async () => {
    await using dir = await mkTmpDir();
    const path = join(dir.path, "env");
    writeFileSync(path, "# keep me\nAWS_PROFILE=bert\nS3CAB_BUCKET=b\n");
    removeEnvKey(path, "AWS_PROFILE");
    assert.equal(readFileSync(path, "utf8"), "# keep me\nS3CAB_BUCKET=b\n");
  });

  it("removes every duplicate of the key", async () => {
    await using dir = await mkTmpDir();
    const path = join(dir.path, "env");
    writeFileSync(path, "AWS_PROFILE=one\nS3CAB_BUCKET=b\nAWS_PROFILE=two\n");
    removeEnvKey(path, "AWS_PROFILE");
    assert.equal(readFileSync(path, "utf8"), "S3CAB_BUCKET=b\n");
  });

  it("empties the file when the key was its only line", async () => {
    await using dir = await mkTmpDir();
    const path = join(dir.path, "env");
    writeFileSync(path, "AWS_PROFILE=bert\n");
    removeEnvKey(path, "AWS_PROFILE");
    assert.equal(readFileSync(path, "utf8"), "");
  });

  it("leaves a key that's a prefix of another untouched", async () => {
    await using dir = await mkTmpDir();
    const path = join(dir.path, "env");
    writeFileSync(path, "AWS_PROFILE=bert\n");
    removeEnvKey(path, "AWS");
    assert.equal(readFileSync(path, "utf8"), "AWS_PROFILE=bert\n");
  });

  it("is a no-op when the key is absent", async () => {
    await using dir = await mkTmpDir();
    const path = join(dir.path, "env");
    writeFileSync(path, "S3CAB_BUCKET=b\n");
    removeEnvKey(path, "AWS_PROFILE");
    assert.equal(readFileSync(path, "utf8"), "S3CAB_BUCKET=b\n");
  });

  it("is a no-op when the file doesn't exist", async () => {
    await using dir = await mkTmpDir();
    const path = join(dir.path, "env");
    removeEnvKey(path, "AWS_PROFILE"); // must not throw
    assert.equal(existsSync(path), false); // and creates nothing
  });
});
