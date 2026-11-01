/**
 * The docs-site URLs s3cab has frozen, and a live check that each still
 * answers. Every URL s3cab prints is on https://s3cab.plantegral.com, and a
 * shipped binary or a `setup`-written exclude.txt keeps it for good (CLAUDE.md,
 * "Every URL we print"). The hosting lives in the platform repo's Terraform
 * (ADR-0114), so a change there can take a page off the air unseen from here.
 *
 * Run, it fetches each frozen URL from the live site and fails unless every
 * one answers 200 with no redirect and `/guide/nope` answers 404.
 *
 * Two faces, hence the `import.meta.main` guard: `docs-urls.test.mjs` imports
 * the list and the source scan (in `npm test`, no network), and the
 * `docs-urls` workflow runs this file.
 *
 * Usage:
 *   node scripts/docs-urls.mjs     # exit 1 if any URL answers wrong
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const ORIGIN = "https://s3cab.plantegral.com";

/**
 * Every URL a release may have printed: the home page, the guide index, and
 * one page per `guide/<topic>.md`. Built from `guide/` rather than kept by
 * hand; it covers every release only because no guide page is ever renamed.
 * @param {string} root - The repo checkout
 * @returns {string[]}
 */
export function frozenUrls(root) {
  const topics = readdirSync(join(root, "guide"))
    .filter((file) => file.endsWith(".md"))
    .map((file) => (file === "README.md" ? "" : file.slice(0, -3)))
    .sort();
  return [`${ORIGIN}/`, ...topics.map((topic) => `${ORIGIN}/guide/${topic}`)];
}

// A `${…}`, `#anchor` or `?query` stays in the match, so the URL can't pass
// for the frozen page it starts with.
const SITE_URL = /https:\/\/s3cab\.plantegral\.com[\w\-./${}#?=&]*/g;

/**
 * Every docs-site URL spelled in a shipped `src/` module, as written; the bare
 * origin reads as `/`, the URL it fetches.
 * @param {string} root - The repo checkout
 * @returns {{ file: string, url: string }[]}
 */
export function printedUrls(root) {
  return readdirSync(join(root, "src"), { recursive: true, encoding: "utf8" })
    .filter((file) => file.endsWith(".mjs") && !file.endsWith(".test.mjs"))
    .flatMap((file) =>
      [...readFileSync(join(root, "src", file), "utf8").matchAll(SITE_URL)].map(
        ([match]) => {
          const url = match.replace(/\.+$/, "");
          return {
            file: `src/${file.replaceAll("\\", "/")}`,
            url: url === ORIGIN ? `${ORIGIN}/` : url,
          };
        },
      ),
    );
}

if (import.meta.main) {
  // A page that 404s proves the site itself is answering, not a catch-all
  // that would return 200 for every frozen URL whatever happened to the pages.
  const checks = [
    ...frozenUrls(join(import.meta.dirname, "..")).map((url) => ({
      url,
      want: 200,
    })),
    { url: `${ORIGIN}/guide/nope`, want: 404 },
  ];
  let failed = 0;
  for (const { url, want } of checks) {
    let got;
    try {
      // Under the job's timeout, so a hung URL still gets its FAIL line.
      const response = await fetch(url, {
        redirect: "manual",
        signal: AbortSignal.timeout(15_000),
      });
      const location = response.headers.get("location");
      got = `${response.status}${location ? ` redirect to ${location}` : ""}`;
      if (response.status === want) {
        console.log(`ok    ${url} ${got}`);
        continue;
      }
    } catch (error) {
      // fetch says only "fetch failed"; the reason is its `cause`, whose
      // message is empty when every address failed, but whose `code` isn't.
      // A timeout has no cause, and its own `code` is DOMException's 23.
      const failure = /** @type {Error} */ (error);
      const cause = /** @type {NodeJS.ErrnoException | undefined} */ (
        failure.cause
      );
      got = `no answer (${cause ? (cause.code ?? cause.message) : failure.message})`;
    }
    failed++;
    console.log(`FAIL  ${url} wanted ${want}, got ${got}`);
  }
  console.log(`\n${checks.length - failed} of ${checks.length} as expected`);
  process.exitCode = failed ? 1 : 0;
}
