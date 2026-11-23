import assert from "node:assert/strict";
import {
  chmodSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { removeEnvKey, updateEnvFile } from "./env-file.mjs";

// An env file an editor made, as the guides invite, is owner-only once s3cab
// has written into it (creating one is in env-file.test.mjs).
//
// `tmpdir()`, not `test/.tmp`: under WSL the checkout is a Windows drive,
// which reports every file as 0777.

/** POSIX permissions mean nothing on Windows. */
const skip = process.platform === "win32";

/** @param {string} path */
const modeOf = (path) => (statSync(path).mode & 0o777).toString(8);

const SECRET = {
  AWS_SECRET_ACCESS_KEY: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
};

/** @type {string} */
let dir;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "s3cab-env-mode-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("an env file holding a secret is owner-only", { skip }, () => {
  it("when updateEnvFile writes a secret into one that was world-readable", () => {
    const path = join(dir, "env");
    writeFileSync(path, "S3CAB_BUCKET=b\n");
    chmodSync(path, 0o644);

    updateEnvFile(path, SECRET);

    assert.equal(modeOf(path), "600");
  });

  it("when removeEnvKey rewrites one that was world-readable", () => {
    const path = join(dir, "env");
    writeFileSync(path, "AWS_PROFILE=work\nAWS_SECRET_ACCESS_KEY=x\n");
    chmodSync(path, 0o644);

    removeEnvKey(path, "AWS_PROFILE");

    assert.equal(modeOf(path), "600");
  });
});
