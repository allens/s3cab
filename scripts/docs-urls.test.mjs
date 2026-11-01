import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtempDisposable } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { ORIGIN, frozenUrls, printedUrls } from "./docs-urls.mjs";

const ROOT = join(import.meta.dirname, "..");

// help.mjs builds each command's guide link from its registry `guide` field,
// and help.test.mjs proves each of those has a page in guide/, so that one
// interpolated URL passes here. Any other is reported: nothing here can tell
// what it prints.
const GUIDE_TEMPLATE = `${ORIGIN}/guide/\${guide}`;

/** Each URL `root`'s `src/` prints that isn't frozen, as `file: url`. */
const unfrozen = (/** @type {string} */ root) => {
  const frozen = new Set(frozenUrls(root));
  return printedUrls(root)
    .filter(({ url }) => url !== GUIDE_TEMPLATE && !frozen.has(url))
    .map(({ file, url }) => `${file}: ${url}`);
};

describe("frozenUrls", () => {
  it("is the home page, the guide index and one URL per guide page", () => {
    const urls = frozenUrls(ROOT);

    assert.equal(urls[0], `${ORIGIN}/`);
    assert.ok(urls.includes(`${ORIGIN}/guide/`), "guide/README.md is /guide/");
    assert.ok(urls.includes(`${ORIGIN}/guide/exclude`));
    assert.ok(!urls.some((url) => url.endsWith(".md")));
  });

  it("includes the site pages the shipped markdown links", () => {
    const urls = frozenUrls(ROOT);

    assert.ok(urls.includes(`${ORIGIN}/commands/restore`), "README.md's");
    assert.ok(urls.includes(`${ORIGIN}/pattern-playground`), "guide/'s");
  });

  it("takes each linked page once, without its anchor, query or full stop", async () => {
    await using dir = await mkdtempDisposable(join(tmpdir(), "s3cab-urls-"));
    mkdirSync(join(dir.path, "guide"));
    writeFileSync(
      join(dir.path, "README.md"),
      `[x](${ORIGIN}/commands/foo). See ${ORIGIN}/commands/foo#flags, ` +
        `and ${ORIGIN}.\n`,
    );
    writeFileSync(
      join(dir.path, "guide", "exclude.md"),
      `Try ${ORIGIN}/tools/bar?x=1.\n`,
    );

    assert.deepEqual(frozenUrls(dir.path), [
      `${ORIGIN}/`,
      `${ORIGIN}/guide/exclude`,
      `${ORIGIN}/commands/foo`,
      `${ORIGIN}/tools/bar`,
    ]);
  });
});

describe("printed URLs", () => {
  it("every docs-site URL src/ prints is a frozen URL", () => {
    // A printed URL outside the set is one the live check never fetches, and
    // once a release ships it, one nobody can correct.
    assert.deepEqual(unfrozen(ROOT), []);
  });

  it("reads the URLs it is meant to be reading", () => {
    // Without this the check above passes on an empty scan too.
    const printed = printedUrls(ROOT);
    assert.ok(
      printed.some(({ file }) => file === "src/lib/sets.mjs"),
      "scans nested modules",
    );
    assert.ok(
      printed.some(({ url }) => url === `${ORIGIN}/`),
      "bare origin",
    );
    assert.ok(printed.some(({ url }) => url === GUIDE_TEMPLATE));
  });

  it("reports a printed URL that isn't frozen, an anchor, and an unknown interpolation", async () => {
    await using dir = await mkdtempDisposable(join(tmpdir(), "s3cab-urls-"));
    mkdirSync(join(dir.path, "guide"));
    writeFileSync(join(dir.path, "guide", "exclude.md"), "");
    writeFileSync(join(dir.path, "README.md"), "");
    mkdirSync(join(dir.path, "src", "lib"), { recursive: true });
    writeFileSync(
      join(dir.path, "src", "lib", "x.mjs"),
      `"See ${ORIGIN}/guide/exclude." + \`${ORIGIN}/guide/\${topic}\`;\n` +
        `// ${ORIGIN}/guide/exlcude\n` +
        `"${ORIGIN}/guide/exclude#patterns"\n`,
    );
    // Tests ship nothing, so a URL in one is never printed.
    writeFileSync(
      join(dir.path, "src", "x.test.mjs"),
      `"${ORIGIN}/guide/nope"`,
    );

    assert.deepEqual(unfrozen(dir.path), [
      `src/lib/x.mjs: ${ORIGIN}/guide/\${topic}`,
      `src/lib/x.mjs: ${ORIGIN}/guide/exlcude`,
      `src/lib/x.mjs: ${ORIGIN}/guide/exclude#patterns`,
    ]);
  });
});
