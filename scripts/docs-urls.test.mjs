import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtempDisposable } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { commands } from "../src/commands.mjs";
import { ORIGIN, frozenUrls, printedUrls } from "./docs-urls.mjs";

const ROOT = join(import.meta.dirname, "..");

// help.mjs builds each command's guide link from its registry `guide` field, so
// that one interpolated URL is checked as the URLs it expands to. Any other
// interpolation is reported: nothing here can tell what it prints.
const GUIDE_TEMPLATE = `${ORIGIN}/guide/\${guide}`;
const guides = Object.values(commands).flatMap(({ guide }) =>
  guide ? [`${ORIGIN}/guide/${guide}`] : [],
);

/** Each URL `root`'s `src/` prints that isn't frozen, as `file: url`. */
const unfrozen = (/** @type {string} */ root) => {
  const frozen = new Set(frozenUrls(root));
  return printedUrls(root).flatMap(({ file, url }) =>
    (url === GUIDE_TEMPLATE ? guides : [url])
      .filter((printed) => !frozen.has(printed))
      .map((printed) => `${file}: ${printed}`),
  );
};

describe("frozenUrls", () => {
  it("is the home page, the guide index and one URL per guide page", () => {
    const urls = frozenUrls(ROOT);

    assert.equal(urls[0], `${ORIGIN}/`);
    assert.ok(urls.includes(`${ORIGIN}/guide/`), "guide/README.md is /guide/");
    assert.ok(urls.includes(`${ORIGIN}/guide/exclude`));
    assert.ok(!urls.some((url) => url.endsWith(".md")));
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
    assert.ok(guides.length > 0, "the registry links guides");
  });

  it("reports a printed URL that isn't frozen, and an unknown interpolation", async () => {
    await using dir = await mkdtempDisposable(join(tmpdir(), "s3cab-urls-"));
    mkdirSync(join(dir.path, "guide"));
    writeFileSync(join(dir.path, "guide", "exclude.md"), "");
    mkdirSync(join(dir.path, "src", "lib"), { recursive: true });
    writeFileSync(
      join(dir.path, "src", "lib", "x.mjs"),
      `"See ${ORIGIN}/guide/exclude." + \`${ORIGIN}/guide/\${topic}\`;\n` +
        `// ${ORIGIN}/guide/exlcude\n`,
    );
    // Tests ship nothing, so a URL in one is never printed.
    writeFileSync(
      join(dir.path, "src", "x.test.mjs"),
      `"${ORIGIN}/guide/nope"`,
    );

    assert.deepEqual(unfrozen(dir.path), [
      `src/lib/x.mjs: ${ORIGIN}/guide/\${topic}`,
      `src/lib/x.mjs: ${ORIGIN}/guide/exlcude`,
    ]);
  });
});
