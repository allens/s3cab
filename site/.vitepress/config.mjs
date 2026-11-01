// The docs site at https://s3cab.plantegral.com (ADR-0114). It
// renders README.md and guide/*.md in place rather than copying them, so this
// config's job is to make pages written for GitHub read the same here:
//
// - heading anchors are spelled the way GitHub spells them, so a link like
//   `aws.md#non-aws-providers` works on both;
// - a relative link that leaves the site (LICENSE, docs/adr/, .s3cab/…) points
//   at the file on GitHub, the way it resolves there.
//
// The build fails on a dead internal link — VitePress checks the page,
// check-links.mjs the `#anchor` — which is the link check.
//
// VitePress is pinned to an exact 2.0 alpha on purpose. The 1.x line (last
// release 2025-08) is stuck on Vite 5, whose dev-server advisories have no fix
// there; 2.0 is where VitePress is developed and audits clean. Exact, so every
// alpha bump arrives as a reviewed Dependabot PR rather than on a fresh install.

import { readFileSync } from "node:fs";
import { join, posix, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitepress";
import { writeChallengeBucket } from "./challenge-bucket.mjs";
import { checkLinks } from "./check-links.mjs";
import { commandSidebar } from "./command-pages.mjs";
import { slugify } from "./slugify.mjs";
import commandRoute from "../commands/[name].paths.mjs";

/** @import { DefaultTheme } from "vitepress" */
/** @import MarkdownIt from "markdown-it" */

const repo = "https://github.com/allens/s3cab";
const site = "https://s3cab.plantegral.com";
const root = fileURLToPath(new URL("../../", import.meta.url));

/**
 * A link as the site should serve it: one to the site's own domain becomes a
 * path on it, so the build checks it and a preview stays on the preview.
 * Otherwise, resolved against the page's file in the repo, it stays as written
 * if it lands on a guide page, becomes `/` or `/guide/` for a README, and
 * becomes a GitHub link for any other repo file.
 * @param {string} href
 * @param {string} file - The page's file, relative to the repo
 */
function siteHref(href, file) {
  if (href.startsWith(`${site}/`)) {
    return href.slice(site.length);
  }
  if (/^([a-z][a-z+.-]*:|#|\/)/i.test(href)) {
    return href;
  }
  const at = href.indexOf("#");
  const path = at < 0 ? href : href.slice(0, at);
  const hash = at < 0 ? "" : href.slice(at);
  const target = posix.normalize(posix.join(posix.dirname(file), path));
  if (target === "README.md") {
    return `/${hash}`;
  }
  if (target === "guide/" || target === "guide/README.md") {
    return `/guide/${hash}`;
  }
  if (/^guide\/[^/]+\.md$/.test(target)) {
    return href;
  }
  return `${repo}/${target.endsWith("/") ? "tree" : "blob"}/main/${target}${hash}`;
}

/** @param {MarkdownIt} md */
function repoLinks(md) {
  md.core.ruler.push("s3cab-repo-links", (state) => {
    const file = relative(root, state.env.realPath ?? state.env.path ?? "")
      .split("\\")
      .join("/");
    for (const token of state.tokens) {
      for (const child of token.children ?? []) {
        const href = child.type === "link_open" && child.attrGet("href");
        if (href) {
          child.attrSet("href", siteHref(href, file));
        }
      }
    }
  });
}

/**
 * The page local search indexes. VitePress reads it from the page's file, and a
 * command page has none — /commands/<name> is generated — so without this no
 * command page is searchable. Runs only in Node: VitePress drops `_`-prefixed
 * options before themeConfig goes to the browser.
 * @type {NonNullable<DefaultTheme.LocalSearchOptions["_render"]>}
 */
const searchedPage = (src, env, md) => {
  const name = /^site\/commands\/(.+)\.md$/.exec(env.relativePath)?.[1];
  const page = commandRoute.paths().find((route) => route.params.name === name);
  return md.renderAsync(page?.content ?? src, env);
};

/**
 * Opens the home page with the terminal recording. The home page is README.md,
 * which GitHub renders too, so the recording can't be written into it.
 * @param {MarkdownIt} md
 */
function homeRecording(md) {
  md.core.ruler.push("s3cab-home-recording", (state) => {
    if (state.env.relativePath === "index.md") {
      const token = new state.Token("html_block", "", 0);
      token.content = "<HomeRecording />\n";
      state.tokens.unshift(token);
    }
  });
}

/**
 * The sidebar, read from guide/README.md's own `## Section` headings and the
 * bold link that opens each bullet under them, so the guide index stays the
 * one list.
 * @returns {DefaultTheme.SidebarItem[]}
 */
function guideSidebar() {
  const index = readFileSync(
    new URL("../../guide/README.md", import.meta.url),
    "utf8",
  );
  /** @type {{ text: string, items: DefaultTheme.SidebarItem[] }[]} */
  const sections = [];
  for (const line of index.split("\n")) {
    const heading = /^## (.+)/.exec(line);
    if (heading?.[1]) {
      sections.push({ text: heading[1], items: [] });
      continue;
    }
    const entry = /^- \*\*\[(.+?)\]\(([\w-]+)\.md\)\*\*/.exec(line);
    if (entry) {
      sections.at(-1)?.items.push({
        text: entry[1],
        link: `/guide/${entry[2]}`,
      });
    }
  }
  return [
    {
      text: "Start here",
      items: [
        { text: "What s3cab is", link: "/" },
        { text: "All guides", link: "/guide/" },
        { text: "Command reference", link: "/commands/" },
      ],
    },
    ...sections,
  ];
}

export default defineConfig({
  title: "s3cab",
  description:
    "Open, tool-independent S3 content-addressable backup — your data is never locked in.",
  lang: "en-GB",
  cleanUrls: true,
  // The pages are the repo's own files where they live: README.md is the home
  // page, guide/*.md the guide, and site/ holds the pages only the site has.
  srcDir: "..",
  // `foo/**` also matches the file `foo`, so this one pattern drops every other
  // top-level file and folder.
  srcExclude: ["!(README.md|guide|site)/**"],
  rewrites: {
    "README.md": "index.md",
    "guide/README.md": "guide/index.md",
    "site/:page*": ":page*",
  },
  // VitePress looks for it in srcDir, which would make it a top-level public/.
  vite: { publicDir: "site/public" },
  markdown: {
    anchor: { slugify },
    // The docs' terminal transcripts use a `> ` prompt and Windows paths, which
    // the shell grammar colours as escapes (`C:\Users` → `\U`); shown plain.
    languageAlias: { console: "text" },
    config: (md) => {
      repoLinks(md);
      homeRecording(md);
    },
  },
  // The challenge's bucket is written once the pages are, too late for
  // VitePress's own check, so links into it are left to check-links.mjs, run
  // after it.
  ignoreDeadLinks: [/^\/challenge\/bucket\//],
  buildEnd: async ({ outDir }) => {
    await writeChallengeBucket(join(outDir, "challenge", "bucket"));
    checkLinks(outDir);
  },
  themeConfig: {
    nav: [
      { text: "Guides", link: "/guide/" },
      { text: "Commands", link: "/commands/" },
      { text: "Format spec", link: "/guide/format" },
    ],
    sidebar: { "/commands/": commandSidebar(), "/": guideSidebar() },
    search: {
      provider: "local",
      options: {
        _render: searchedPage,
        // A pasted error line is long, so with the default title boost (4) its
        // words matched across a long section, such as the format spec's
        // "Reading", outranked the guide/errors.md heading that spells it. At
        // 8 nearly every heading ranks first for its own pasted line, and
        // searches for a word or two rank as before.
        miniSearch: {
          searchOptions: { boost: { title: 8, text: 2, titles: 1 } },
        },
      },
    },
    outline: { level: [2, 3] },
    // Serialized into the browser bundle, so it can't close over `repo`. A
    // command page is generated, so its source is the registry.
    editLink: {
      pattern: ({ filePath }) =>
        "https://github.com/allens/s3cab/edit/main/" +
        (filePath.startsWith("site/commands/") ? "src/commands.mjs" : filePath),
      text: "Edit this page on GitHub",
    },
    socialLinks: [{ icon: "github", link: repo }],
    notFound: {
      title: "This page was never backed up",
      quote:
        "Unlike your files. Whatever was here has gone, or was never here at all.",
      linkText: "Back to safety",
    },
    footer: {
      message: "Released under GPL-3.0-or-later.",
      copyright: "© Allen Shiels",
    },
  },
});
