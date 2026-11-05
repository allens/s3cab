import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
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
// anyone who can write in the destination folder can put something there first
// (ADR-0116). A link must not carry the bytes out of the folder, nor end up at
// the destination when the rename moves it.

/** The temp name `writeFileAtomic` derives for `dest`. */
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
 * @param {string} [target]
 */
const plant = (t, target = victim) => {
  try {
    symlinkSync(target, tempFor(dest), "file");
    return true;
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code === "EPERM") {
      t.skip("creating a symlink needs a privilege this account lacks");
      return false;
    }
    throw error;
  }
};

const payload = "PAYLOAD";
const hash = createHash("sha256").update(payload).digest("hex");

/** The file landed as a file, in the folder, with nothing left beside it. */
const assertLanded = () => {
  assert.ok(lstatSync(dest).isFile());
  assert.equal(readFileSync(dest, "utf8"), payload);
  assert.ok(!existsSync(tempFor(dest)));
};

describe("a link planted at the temp name", () => {
  it("doesn't carry a download outside the destination's folder", async (t) => {
    if (!plant(t)) {
      return;
    }

    await writeFileAtomic(dest, Readable.from([payload]), { hash });

    assert.equal(readFileSync(victim, "utf8"), "precious");
    assertLanded();
  });

  it("doesn't carry a copy outside the destination's folder", async (t) => {
    if (!plant(t)) {
      return;
    }
    const source = join(dir, "source.txt");
    writeFileSync(source, payload);

    await copyFileAtomic(source, dest);

    assert.equal(readFileSync(victim, "utf8"), "precious");
    assertLanded();
  });

  it("doesn't create the target of a link whose target doesn't exist", async (t) => {
    // NTFS's exclusive open goes through this one, where ext4's refuses.
    const nowhere = join(dir, "nowhere.txt");
    if (!plant(t, nowhere)) {
      return;
    }

    await writeFileAtomic(dest, Readable.from([payload]), { hash });

    assert.ok(!existsSync(nowhere));
    assertLanded();
  });
});

describe("what else can be at the temp name", () => {
  it("removes a dead run's leftover", async () => {
    writeFileSync(tempFor(dest), "half a download");

    await writeFileAtomic(dest, Readable.from([payload]), { hash });

    assertLanded();
  });

  it("refuses a folder, which is someone else's, and lets go of the source", async () => {
    mkdirSync(tempFor(dest));
    writeFileSync(join(tempFor(dest), "theirs.txt"), "kept");
    const source = Readable.from([payload]);

    await assert.rejects(() => writeFileAtomic(dest, source, { hash }), {
      code: "EEXIST",
    });

    assert.ok(source.destroyed);
    assert.ok(!existsSync(dest));
    assert.deepEqual(readdirSync(tempFor(dest)), ["theirs.txt"]);
  });
});
