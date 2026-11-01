import assert from "node:assert/strict";
import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { it } from "node:test";
import { createMarkdownRenderer } from "vitepress";
import config from "./config.mjs";

/** @import { DefaultTheme } from "vitepress" */

const root = fileURLToPath(new URL("../../", import.meta.url));

/**
 * A page rendered the way a page build renders it: `relativePath` is its place
 * on the site, `realPath` its file in the repo.
 * @param {string} src
 * @param {string} relativePath
 * @param {string} file - Relative to `base`
 * @param {string} [base] - The checkout the file is in
 */
async function render(src, relativePath, file, base = root) {
  const md = await createMarkdownRenderer("site", config.markdown);
  return md.render(src, {
    relativePath,
    realPath: `${base}${file}`,
    cleanUrls: true,
  });
}

/**
 * Runs `fn` with `resolved` standing in for the config VitePress keeps on
 * globalThis while it runs.
 * @param {object} resolved
 * @param {() => Promise<void>} fn
 */
async function duringVitePress(resolved, fn) {
  Object.assign(globalThis, { VITEPRESS_CONFIG: resolved });
  try {
    await fn();
  } finally {
    Reflect.deleteProperty(globalThis, "VITEPRESS_CONFIG");
  }
}

it("keeps the space a wrapped line ends with between two links", async () => {
  assert.match(
    await render(
      "[a](https://a.example)\n[b](https://b.example)",
      "guide/find.md",
      "guide/find.md",
    ),
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

it("resolves a page's file against VitePress's srcDir, wherever this config is", async () => {
  const checkout = join(root, "elsewhere") + sep;
  await duringVitePress({ srcDir: checkout }, async () => {
    const html = await render(
      "[a](../guide/find.md)",
      "pattern-playground.md",
      "site/pattern-playground.md",
      checkout,
    );
    assert.match(html, /href="\.\/guide\/find"/);
  });
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

const WINDOWS = "```console windows\n> s3cab list\n```\n";
const POSIX = "```console posix\n> s3cab list\n```\n";

/** @param {string} src */
const renderGuide = (src) => render(src, "guide/find.md", "guide/find.md");

it("makes a windows fence and the posix one after it one switch, highlighted as the language", async () => {
  const html = await renderGuide(WINDOWS + POSIX);
  assert.equal(html.match(/class="os-switch"/g)?.length, 1);
  assert.equal(html.match(/role="tab"/g)?.length, 2);
  assert.equal(html.match(/role="tabpanel"/g)?.length, 2);
  assert.match(html, /aria-controls="os-1-posix"/);
  assert.match(html, /id="os-1-posix"/);
  assert.match(html, /class="language-console/);
  assert.doesNotMatch(html, /language-console (windows|posix)/);
});

it("makes two examples with no prose between them two switches", async () => {
  const html = await renderGuide(WINDOWS + POSIX + WINDOWS + POSIX);
  assert.equal(html.match(/class="os-switch"/g)?.length, 2);
  assert.match(html, /id="os-2-windows"/);
});

it("fails a variant without its partner, which would vanish for the other OS", async () => {
  for (const src of [
    WINDOWS,
    POSIX + WINDOWS,
    WINDOWS + "\nprose\n\n" + POSIX,
  ]) {
    await assert.rejects(renderGuide(src), /guide\/find\.md:1: an OS example/);
  }
});

it("indexes a generated page's content, and any other page's file", async () => {
  const { search } = /** @type {DefaultTheme.Config} */ (config.themeConfig);
  const searchedPage =
    /** @type {NonNullable<DefaultTheme.LocalSearchOptions["_render"]>} */ (
      /** @type {{ options: DefaultTheme.LocalSearchOptions }} */ (search)
        .options._render
    );
  const md = await createMarkdownRenderer("site", config.markdown);
  const routes = [
    { path: "site/commands/backup.md", content: "# s3cab backup" },
  ];
  await duringVitePress({ srcDir: root, dynamicRoutes: routes }, async () => {
    /** @param {string} relativePath */
    const env = (relativePath) => ({
      path: `${root}${relativePath}`,
      relativePath,
      cleanUrls: true,
    });
    assert.match(
      await searchedPage("", env("site/commands/backup.md"), md),
      /s3cab backup/,
    );
    assert.match(
      await searchedPage("# Backing up", env("guide/backup.md"), md),
      /Backing up/,
    );
  });
});
