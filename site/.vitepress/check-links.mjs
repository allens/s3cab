// The built site's anchor check, run from the config's `buildEnd`. VitePress
// already fails the build on a link to a page that doesn't exist; this adds the
// half it skips — the `#fragment` — which is what breaks when a heading is
// reworded or GitHub and the site disagree on how to spell an anchor.

import { readFileSync, readdirSync } from "node:fs";
import { join, posix } from "node:path";

/**
 * Every built page by its served URL (`guide/exclude.html` → `/guide/exclude`,
 * `guide/index.html` → `/guide/`), with the ids it defines and the internal
 * links it makes.
 * @param {string} outDir
 */
function readPages(outDir) {
  /** @type {Map<string, string>} */
  const pages = new Map();
  /** @param {string} dir */
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(path);
      } else if (entry.name.endsWith(".html")) {
        const file = posix.relative(outDir, path.replaceAll("\\", "/"));
        pages.set(
          "/" + file.replace(/(index)?\.html$/, ""),
          readFileSync(path, "utf8"),
        );
      }
    }
  };
  walk(outDir.replaceAll("\\", "/"));
  return pages;
}

/**
 * Throws, naming each one, if any internal link points at a page or anchor the
 * build didn't produce.
 * @param {string} outDir
 */
export function checkLinks(outDir) {
  const pages = readPages(outDir);
  const ids = new Map(
    [...pages].map(([url, html]) => [
      url,
      new Set([...html.matchAll(/ id="([^"]+)"/g)].map(([, id]) => id)),
    ]),
  );
  const broken = [];
  for (const [url, html] of pages) {
    for (const [, href = ""] of html.matchAll(/<a [^>]*href="([^"]*)"/g)) {
      if (/^[a-z][a-z+.-]*:/i.test(href)) {
        continue;
      }
      const at = href.indexOf("#");
      const path = at < 0 ? href : href.slice(0, at);
      const fragment = at < 0 ? "" : decodeURIComponent(href.slice(at + 1));
      const base = url.endsWith("/") ? url : posix.dirname(url) + "/";
      const target = !path
        ? url
        : path.startsWith("/")
          ? path
          : posix.normalize(posix.join(base, path));
      const targetIds = ids.get(target);
      if (!targetIds || (fragment && !targetIds.has(fragment))) {
        broken.push(`  ${url}  →  ${href}`);
      }
    }
  }
  if (broken.length) {
    throw new Error(
      `${broken.length} broken link(s) in the built site:\n${[...new Set(broken)].join("\n")}`,
    );
  }
}
