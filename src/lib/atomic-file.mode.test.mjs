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
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, it } from "node:test";
import { writeFileAtomic } from "./atomic-file.mjs";

// `restore --overwrite` lands a file by renaming a temp over it, so the temp
// must carry the replaced file's mode, or an owner-only file (a private key, a
// credentials file) comes back readable by whoever the umask lets in.
//
// `tmpdir()`, not `test/.tmp`: under WSL the checkout is a Windows drive,
// which reports every file as 0777.

/** POSIX permissions mean nothing on Windows. */
const skip = process.platform === "win32";

/** @param {string} path */
const modeOf = (path) => (statSync(path).mode & 0o777).toString(8);

/** @type {string} */
let dir;
/** @type {number} */
let savedUmask;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "s3cab-atomic-mode-"));
  // The usual default, pinned so the result doesn't depend on the runner's.
  savedUmask = process.umask(0o022);
});
afterEach(() => {
  process.umask(savedUmask);
  rmSync(dir, { recursive: true, force: true });
});

describe("writeFileAtomic over an existing file", { skip }, () => {
  it("leaves an owner-only one owner-only", async () => {
    const dest = join(dir, "id_ed25519");
    writeFileSync(dest, "old key");
    chmodSync(dest, 0o600);

    await writeFileAtomic(dest, Readable.from(["restored key"]));

    assert.equal(modeOf(dest), "600");
  });

  it("never leaves one wider than the umask allows", async () => {
    const dest = join(dir, "shared.txt");
    writeFileSync(dest, "old");
    chmodSync(dest, 0o666);

    await writeFileAtomic(dest, Readable.from(["restored"]));

    assert.equal(modeOf(dest), "644");
  });
});
