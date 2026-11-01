import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { it } from "node:test";
import { createMarkdownRenderer } from "vitepress";
import config from "./config.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));

/**
 * A page rendered the way a page build renders it: `relativePath` is its place
 * on the site, `realPath` its file in the repo.
 * @param {string} src
 * @param {string} relativePath
 * @param {string} file - Relative to the repo
 */
async function render(src, relativePath, file) {
  const md = await createMarkdownRenderer("site", config.markdown);
  return md.render(src, {
    relativePath,
    realPath: `${root}${file}`,
    cleanUrls: true,
  });
}

it("keeps the space a wrapped line ends with between two links", async () => {
  const md = await createMarkdownRenderer("site", config.markdown);
  assert.match(
    md.render("[a](https://a.example)\n[b](https://b.example)"),
    /<\/a> <a /,
  );
});

it("resolves the README's links from README.md, though it is served at /", async () => {
  const html = await render(
    "[a](guide/backup.md) [b](LICENSE)",
    "index.md",
    "README.md",
  );
  assert.match(html, /href="\.\/guide\/backup"/);
  assert.match(
    html,
    /href="https:\/\/github\.com\/allens\/s3cab\/blob\/main\/LICENSE"/,
  );
});

it("resolves a site/ page's link into guide/ from where the page is served", async () => {
  const html = await render(
    "[a](../guide/find.md#what-a-pattern-matches)",
    "pattern-playground.md",
    "site/pattern-playground.md",
  );
  assert.match(html, /href="\.\/guide\/find#what-a-pattern-matches"/);
});

it("opens the home page, and only the home page, with the recording", async () => {
  assert.match(
    await render("# s3cab", "index.md", "README.md"),
    /<HomeRecording \/>/,
  );
  assert.doesNotMatch(
    await render("# Guides", "guide/index.md", "guide/README.md"),
    /HomeRecording/,
  );
});
