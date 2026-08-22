import { posix, sep } from "node:path";

import { globSource } from "./path-match.mjs";

/**
 * Compile one exclude glob into a matcher `RegExp`, anchored to the whole
 * string. The pattern is **absolute** — the walk joins each set root with the
 * root-relative pattern before compiling, so `*` and `**` can't escape the root.
 *
 * The token grammar is `globSource`'s (guide/exclude.md); what this adds is the
 * anchoring — `^…$`, so an exclude pattern always describes a whole path, which
 * is where `find` deliberately parts company (ADR-0088). Users may write either
 * separator (`/` everywhere; `\` also works on Windows, where `join` has already
 * normalized it to the platform separator); everything is converted to `/`
 * before matching. Matching is case-insensitive on win32, case-sensitive
 * elsewhere — the platform is the right question here, unlike in `find`, because
 * these patterns only ever meet paths from this machine's own walk.
 * @param {string} pattern - Absolute exclude glob
 * @returns {RegExp} Matcher anchored with `^…$`, tested against a `/`-separated path
 */
export function compileExclude(pattern) {
  const normalized = posix.normalize(pattern.split(sep).join(posix.sep));
  return new RegExp(
    `^${globSource(normalized)}$`,
    process.platform === "win32" ? "i" : "",
  );
}
