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
import { isBuiltin } from "node:module";
import { isAbsolute, join, posix, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitepress";
import { writeChallengeBucket } from "./challenge-bucket.mjs";
import { checkLinks } from "./check-links.mjs";
import { commandSidebar } from "./command-pages.mjs";
import { slugify } from "./slugify.mjs";

/** @import { DefaultTheme } from "vitepress" */
/** @import MarkdownIt from "markdown-it" */

const repo = "https://github.com/allens/s3cab";
const site = "https://s3cab.plantegral.com";

const srcLib = fileURLToPath(new URL("../../src/lib/", import.meta.url));
const nodeShim = fileURLToPath(new URL("node-shim.mjs", import.meta.url));

/**
 * Where a site page's markdown lives in the repo: `index.md` includes the
 * README; `guide/<topic>.md` is rendered from `guide/`; any other page is the
 * site's own, in `site/`.
 * @param {string} relativePath
 */
const sourceOf = (relativePath) =>
  relativePath === "index.md"
    ? "README.md"
    : relativePath.startsWith("guide/")
      ? relativePath.replace(/^guide\/index\.md$/, "guide/README.md")
      : `site/${relativePath}`;

/**
 * A link as the site should serve it: one to the site's own domain becomes a
 * path on it, so the build checks it and a preview stays on the preview.
 * Otherwise, resolved against the page's real place in the repo, it becomes
 * relative to the page's place on the site if it lands on a guide page, `/` for
 * the README, and a GitHub link for any other repo file.
 * @param {string} href
 * @param {string} relativePath - The site page the link is on
 */
function siteHref(href, relativePath) {
  if (href.startsWith(`${site}/`)) {
    return href.slice(site.length);
  }
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
    return posix.relative(posix.dirname(relativePath), target) + hash;
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
 * The tab label for each OS tag a fence can carry after its language.
 * @type {Record<string, string>}
 */
const OS_LABELS = { windows: "Windows", posix: "macOS / Linux" };

/**
 * Adjacent fences tagged with an OS after their language (`console windows`,
 * then `console posix`) become one example with a tab per OS. GitHub shows the
 * fences one after the other, so the pages read fine there. Which
 * tab shows is the `data-os` on `<html>`, set by `osChoice` below and by
 * theme/os-switch.mjs; without it every variant shows, under its label.
 * @param {MarkdownIt} md
 */
function osVariants(md) {
  md.core.ruler.push("s3cab-os-variants", (state) => {
    /** @param {string} content */
    const html = (content) =>
      Object.assign(new state.Token("html_block", "", 0), { content });
    /** @type {typeof state.tokens} */
    const tokens = [];
    /** @type {[string, (typeof state.tokens)[number]][]} */
    let group = [];
    const flush = () => {
      if (!group.length) {
        return;
      }
      const tabs = group.map(
        ([os]) =>
          `<button type="button" role="tab" data-os="${os}">${OS_LABELS[os]}</button>`,
      );
      tokens.push(
        html(
          `<div class="os-switch"><div class="os-tabs" role="tablist" aria-label="Operating system">${tabs.join("")}</div>\n`,
        ),
      );
      for (const [os, fence] of group) {
        tokens.push(
          html(
            `<div class="os-variant" data-os="${os}"><p class="os-label">${OS_LABELS[os]}</p>\n`,
          ),
          fence,
          html("</div>\n"),
        );
      }
      tokens.push(html("</div>\n"));
      group = [];
    };
    for (const token of state.tokens) {
      const [, lang, os] =
        (token.type === "fence" &&
          /^(\S+) +(windows|posix)$/.exec(token.info.trim())) ||
        [];
      if (lang && os) {
        token.info = lang;
        group.push([os, token]);
      } else {
        flush();
        tokens.push(token);
      }
    }
    flush();
    state.tokens = tokens;
  });
}

/**
 * Sets `data-os` before the page paints, so the chosen variant shows from the
 * first frame: the stored choice, else the visitor's platform. The key is
 * theme/os-switch.mjs's `KEY`.
 */
const osChoice = `{let os;try{os=localStorage.getItem("s3cab-os")}catch{}document.documentElement.dataset.os=os==="windows"||os==="posix"?os:/^win/i.test(navigator.userAgentData?.platform??navigator.platform)?"windows":"posix"}`;

/**
 * The page local search indexes. VitePress reads it from the page's file under
 * site/, and a guide page has none — /guide/<topic> is a dynamic route — so
 * without this no guide page is searchable. Runs only in Node: VitePress drops
 * `_`-prefixed options before themeConfig goes to the browser. `docs:dev`
 * doesn't re-index a guide page you edit; restart it to see search change.
 * @type {NonNullable<DefaultTheme.LocalSearchOptions["_render"]>}
 */
const searchedPage = (src, env, md) =>
  md.renderAsync(
    env.relativePath.startsWith("guide/")
      ? readFileSync(
          new URL(`../../${sourceOf(env.relativePath)}`, import.meta.url),
          "utf8",
        )
      : src,
    env,
  );

/**
 * The sidebar, read from guide/README.md's own `## Section` headings and the
 * bold link that opens each bullet under them, so the guide index stays the
 * one list. A section with no such bullet — the by-situation list, whose
 * bullets lead with the situation and link a section of a page — is prose for
 * the index page, not a sidebar group.
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
    ...sections.filter((section) => section.items.length > 0),
  ];
}

export default defineConfig({
  title: "s3cab",
  description:
    "Open, tool-independent S3 content-addressable backup — your data is never locked in.",
  lang: "en-GB",
  cleanUrls: true,
  // The theme makes every image a block with a 1rem margin, so the README's
  // badges, a row on GitHub, would stack one per line on the home page, or
  // wrap at phone width with a gap between the rows.
  head: [
    [
      "style",
      {},
      ".vp-doc img[src^='https://img.shields.io/'] { display: inline; vertical-align: middle; margin: 0; }",
    ],
    ["script", {}, osChoice],
  ],
  // Not `lastUpdated`: VitePress dates a page by its wrapper (site/index.md,
  // guide/[topic].md), not the README or guide file it renders.
  markdown: {
    anchor: { slugify },
    // The docs' terminal transcripts use a `> ` prompt and Windows paths, which
    // the shell grammar colours as escapes (`C:\Users` → `\U`); shown plain.
    languageAlias: { console: "text" },
    config: (md) => {
      repoLinks(md);
      osVariants(md);
      // A line break renders as a newline, which Vue's template compiler
      // (`whitespace: "condense"`) drops between two elements, so a line ending
      // in a link or code span would run into the next one's: `code`link, and
      // the badges touching. A space it keeps. Not `whitespace: "preserve"`:
      // that recompiles the theme's own components too, and shifts some.
      md.renderer.rules.softbreak = () => " ";
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
  // The pattern playground bundles s3cab's own matcher for the browser, so
  // within src/lib/ `path` and `util`, with or without `node:`, resolve to
  // node-shim.mjs. Any other builtin is an error: Vite would only warn and swap
  // in an empty module, and the page would break when it ran.
  vite: {
    plugins: [
      {
        name: "s3cab-node-shim",
        enforce: "pre",
        resolveId(id, importer) {
          const within = relative(srcLib, importer ?? "/");
          if (!isBuiltin(id) || within.startsWith("..") || isAbsolute(within)) {
            return null;
          }
          if (["path", "util"].includes(id.replace(/^node:/, ""))) {
            return nodeShim;
          }
          this.error(
            `src/lib/${within} imports ${id}, which the pattern playground ` +
              `can't run in a browser`,
          );
        },
      },
    ],
    // style.mjs reads `process.stderr.isTTY` to decide whether to bold a
    // suggested command; a page has no stderr, so it reads as no terminal.
    define: { "process.stderr": "{}" },
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
    // Serialized into the browser bundle, so it can't close over `repo` or
    // `sourceOf` above — it repeats their mapping on its own. A guide page's
    // filePath is the route template, `guide/[topic].md`; its topic is a param.
    // A command page is generated, so its source is the registry. Any other
    // page is its own source, under site/.
    editLink: {
      pattern: ({ filePath, params }) => {
        const topic = params?.topic === "index" ? "README" : params?.topic;
        return (
          "https://github.com/allens/s3cab/edit/main/" +
          (filePath === "index.md"
            ? "README.md"
            : filePath.startsWith("guide/")
              ? `guide/${topic}.md`
              : filePath.startsWith("commands/")
                ? "src/commands.mjs"
                : `site/${filePath}`)
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
