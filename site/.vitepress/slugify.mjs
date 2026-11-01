/**
 * GitHub's heading anchor: lower-case, drop punctuation and symbols, one `-`
 * per space — no collapsing, so `` `--x` — y `` keeps its `--x--y`.
 * @param {string} text
 */
export const slugify = (text) =>
  text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, "")
    .replace(/ /g, "-");
