// The docs site at https://s3cab.plantegral.com (proposals/docs-site.md). It
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
import { posix } from "node:path";
import { defineConfig } from "vitepress";
import { checkLinks } from "./check-links.mjs";

/** @import { DefaultTheme } from "vitepress" */
/** @import MarkdownIt from "markdown-it" */

const repo = "https://github.com/allens/s3cab";

/**
 * GitHub's heading anchor: lower-case, drop punctuation and symbols, one `-`
 * per space — no collapsing, so `` `--x` — y `` keeps its `--x--y`.
 * @param {string} text
 */
const slugify = (text) =>
  text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, "")
    .replace(/ /g, "-");

/**
 * Where a site page's markdown lives in the repo: `index.md` includes the
 * README; `guide/<topic>.md` is rendered from `guide/`.
 * @param {string} relativePath
 */
const sourceOf = (relativePath) =>
  relativePath === "index.md"
    ? "README.md"
    : relativePath.replace(/^guide\/index\.md$/, "guide/README.md");

/**
 * A link as the site should serve it: resolved against the page's real place
 * in the repo, it stays as written if it lands on a site page, becomes `/` for
 * the README, and becomes a GitHub link for any other repo file.
 * @param {string} href
 * @param {string} relativePath - The site page the link is on
 */
function siteHref(href, relativePath) {
  if (/^([a-z][a-z+.-]*:|#|\/)/i.test(href)) {
    return href;
  }
  const at = href.indexOf("#");
  const path = at < 0 ? href : href.slice(0, at);
  const hash = at < 0 ? "" : href.slice(at);
  const target = posix.normalize(
    posix.join(posix.dirname(sourceOf(relativePath)), path),
  );
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
    const page = state.env.relativePath ?? "";
    for (const token of state.tokens) {
      for (const child of token.children ?? []) {
        const href = child.type === "link_open" && child.attrGet("href");
        if (href) {
          child.attrSet("href", siteHref(href, page));
        }
      }
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
  // Not `lastUpdated`: VitePress dates a page by its wrapper (site/index.md,
  // guide/[topic].md), not the README or guide file it renders.
  markdown: {
    anchor: { slugify },
    // The docs' terminal transcripts use a `> ` prompt and Windows paths, which
    // the shell grammar colours as escapes (`C:\Users` → `\U`); shown plain.
    languageAlias: { console: "text" },
    config: repoLinks,
  },
  buildEnd: ({ outDir }) => checkLinks(outDir),
  themeConfig: {
    nav: [
      { text: "Guides", link: "/guide/" },
      { text: "Format spec", link: "/guide/format" },
    ],
    sidebar: guideSidebar(),
    search: { provider: "local" },
    outline: { level: [2, 3] },
    // Serialized into the browser bundle, so it can't close over `repo` or
    // `sourceOf` above — it repeats their mapping on its own. A guide page's
    // filePath is the route template, `guide/[topic].md`; its topic is a param.
    editLink: {
      pattern: ({ filePath, params }) => {
        const topic = params?.topic === "index" ? "README" : params?.topic;
        return (
          "https://github.com/allens/s3cab/edit/main/" +
          (filePath === "index.md" ? "README.md" : `guide/${topic}.md`)
        );
      },
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
