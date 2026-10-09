import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtempDisposable } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { checkLinks } from "./check-links.mjs";

describe("checkLinks", () => {
  /**
   * A built site of two pages, `/` and `/guide/exclude`.
   * @param {string} indexLinks - The `<a>` tags on the home page
   */
  const buildSite = async (indexLinks) => {
    const dir = await mkdtempDisposable(join(tmpdir(), "s3cab-site-"));
    mkdirSync(join(dir.path, "guide"));
    writeFileSync(
      join(dir.path, "index.html"),
      `<h1 id="top">s3cab</h1>${indexLinks}`,
    );
    writeFileSync(
      join(dir.path, "guide", "exclude.html"),
      `<h2 id="patterns">Patterns</h2><a href="../#top">home</a>`,
    );
    return dir;
  };

  it("passes links to pages and anchors that exist", async () => {
    await using dir = await buildSite(
      `<a href="/guide/exclude#patterns">x</a>` +
        `<a href="guide/exclude">x</a>` +
        `<a href="#top">x</a>` +
        `<a href="https://example.com/#nowhere">x</a>`,
    );

    checkLinks(dir.path);
  });

  // On Windows a native outDir is backslashed; a forward-slashed one is the
  // same directory and must map pages to the same URLs.
  it("reads the site whichever way its directory is spelled", async () => {
    await using dir = await buildSite(
      `<a href="/guide/exclude#patterns">x</a>`,
    );

    checkLinks(dir.path);
    checkLinks(dir.path.replaceAll("\\", "/"));
  });

  it("names a link to a page that doesn't exist", async () => {
    await using dir = await buildSite(`<a href="/guide/missing">x</a>`);

    assert.throws(() => checkLinks(dir.path), {
      message: /1 broken link.*\n {2}\/ {2}→ {2}\/guide\/missing$/,
    });
  });

  it("names a link to an anchor its page doesn't define", async () => {
    await using dir = await buildSite(`<a href="/guide/exclude#gone">x</a>`);

    assert.throws(() => checkLinks(dir.path), {
      message: /1 broken link.*\n {2}\/ {2}→ {2}\/guide\/exclude#gone$/,
    });
  });
});
