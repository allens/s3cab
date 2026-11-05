import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, it } from "node:test";
import { copyFileAtomic, writeFileAtomic } from "./atomic-file.mjs";

/** @import { TestContext } from "node:test" */

// The temp sibling's name is derived from the destination's name alone, so
// anyone who can write in the destination folder can put a link there first
// (proposals/audit-restore-2026-11-04.md). `open(tmp, "w")` and `copyFile`
// both follow a link, so the bytes land in whatever it points at — outside
// the folder — and the rename then moves the link, not a file, into place.

/** The temp name `land` derives for `dest`. */
const tempFor = (/** @type {string} */ dest) =>
  join(
    join(dest, ".."),
    `.${createHash("sha256").update(basename(dest)).digest("hex").slice(0, 16)}.s3cab-tmp`,
  );

/** @type {string} */
let dir;
/** @type {string} */
let victim;
/** @type {string} */
let dest;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "s3cab-atomic-link-"));
  victim = join(dir, "victim.txt");
  writeFileSync(victim, "precious");
  dest = join(dir, "sub-dest.txt");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/**
 * Plant a link at the temp name, or skip where this account can't make one.
 * @param {TestContext} t
 */
const plant = (t) => {
  try {
    symlinkSync(victim, tempFor(dest), "file");
    return true;
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code === "EPERM") {
      t.skip("creating a symlink needs a privilege this account lacks");
      return false;
    }
    throw error;
  }
};

describe("a link planted at the temp name", () => {
  it("doesn't carry a download outside the destination's folder", async (t) => {
    if (!plant(t)) {
      return;
    }
    const payload = "PAYLOAD";
    const hash = createHash("sha256").update(payload).digest("hex");

    await writeFileAtomic(dest, Readable.from([payload]), { hash }).catch(
      () => {},
    );

    assert.equal(readFileSync(victim, "utf8"), "precious");
    assert.ok(!lstatSync(dest, { throwIfNoEntry: false })?.isSymbolicLink());
  });

  it("doesn't carry a copy outside the destination's folder", async (t) => {
    if (!plant(t)) {
      return;
    }
    const source = join(dir, "source.txt");
    writeFileSync(source, "PAYLOAD");

    await copyFileAtomic(source, dest).catch(() => {});

    assert.equal(readFileSync(victim, "utf8"), "precious");
    assert.ok(!lstatSync(dest, { throwIfNoEntry: false })?.isSymbolicLink());
  });
});
