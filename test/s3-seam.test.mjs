import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { s3Seam } from "./helpers/s3-seam.mjs";

// Keeps helpers/s3-seam.mjs's surface equal to the `s3.mjs` exports production
// code actually imports — the automation CLAUDE.md's working rule #1 asks for
// in place of a prose rule that would go stale. Two directions, both real: a
// method a mocked graph could bind but the seam omits is an `undefined` import
// in whichever test mocks it next; a method nothing imports any more is dead
// surface the seam should shed.
//
// Here rather than beside the helper because `npm test`'s `test/*.test.mjs`
// glob is deliberately shallow — that shallowness is what lets helpers/ hold
// non-test .mjs (test/README.md) — so a test under helpers/ would never run.
//
// Only the *names* are checked. That each name is really an export of s3.mjs is
// already enforced, by the `Pick<typeof import(…), …>` in the helper: a wrong
// name there fails `npm run typecheck`.

const srcDir = fileURLToPath(new URL("../src", import.meta.url));

/** A named import, or (`tag` set) a JSDoc `@import` type tag. */
const IMPORT = /(@?)import\s+\{([^}]*)\}\s+from\s+"([^"]+)"/g;
/** Any mention of the module, however it is imported — static or dynamic. */
const ANY_SPECIFIER = /(?:from\s+|import\(\s*)"([^"]+)"/g;
/** True for `./s3.mjs`, `../lib/s3.mjs` — not `fake-s3.mjs`. */
const isSeam = (/** @type {string} */ specifier) =>
  /(?:^|\/)s3\.mjs$/.test(specifier);

/** @returns {Promise<{ file: string, text: string }[]>} every production module */
const productionModules = async () => {
  const entries = await readdir(srcDir, {
    recursive: true,
    withFileTypes: true,
  });
  const files = entries
    .filter(
      (entry) =>
        entry.isFile() &&
        entry.name.endsWith(".mjs") &&
        !entry.name.endsWith(".test.mjs"),
    )
    .map((entry) => join(entry.parentPath, entry.name));
  return await Promise.all(
    files.map(async (file) => ({ file, text: await readFile(file, "utf8") })),
  );
};

describe("the s3.mjs seam stencil", () => {
  it("covers exactly the exports production code imports", async () => {
    const modules = await productionModules();
    /** @type {Set<string>} */
    const imported = new Set();
    for (const { text } of modules) {
      for (const [, tag, names, specifier] of text.matchAll(IMPORT)) {
        // `@import { Transfer } from "./s3.mjs"` names a *type*, which no fake
        // supplies — the runtime surface is the value imports only.
        if (tag === "@" || !isSeam(specifier ?? "")) {
          continue;
        }
        for (const name of (names ?? "").split(",")) {
          if (name.trim()) {
            imported.add(name.trim());
          }
        }
      }
    }

    assert.deepEqual(
      Object.keys(s3Seam()).sort(),
      [...imported].sort(),
      "s3Seam's surface has drifted from what production imports from s3.mjs",
    );
  });

  it("reads every way production reaches the seam", async () => {
    // The check above only understands named-brace imports, so a namespace,
    // default or dynamic import of s3.mjs would slip past it silently and the
    // coverage test would go blind without failing. Counting every mention of
    // the module against the ones it managed to read closes that.
    const modules = await productionModules();
    for (const { file, text } of modules) {
      const mentions = [...text.matchAll(ANY_SPECIFIER)].filter(([, s]) =>
        isSeam(s ?? ""),
      );
      const read = [...text.matchAll(IMPORT)].filter(([, , , s]) =>
        isSeam(s ?? ""),
      );
      assert.equal(
        read.length,
        mentions.length,
        `${file}: s3.mjs is imported by name everywhere else — teach test/s3-seam.test.mjs to read this form`,
      );
    }
  });
});
