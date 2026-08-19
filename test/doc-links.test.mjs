import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { describe, it } from "node:test";

// One repo invariant: every relative link resolves to a file that exists.
//
// The docs lean hard on cross-links — CLAUDE.md's "where knowledge lives" map,
// every ADR citing its neighbours, and the JSDoc header on most modules naming
// the decision that governs it. None of that survives a rename on its own. A
// first sweep (2026-08-19) found seven dead ones: two ADRs renamed under
// citations that were never updated, a design doc citing ADR-0024's old
// filename, a proposal renamed away from under `verify.mjs`, ADR-0078 linked
// from `src/` as `../../docs/…` by two files that sit one level up from that —
// in one of which the *next* link along got the depth right — and the vendored
// over-engineering skill reaching for the ADR index two levels too shallow.
// Nothing announced any of it.
//
// Caught here rather than by a `docs:check` script and a workflow step, for the
// reason adr-numbering.test.mjs gives: the test job is already required by
// `ci gate` and already runs on every push, so this costs one file and no new
// machinery (CLAUDE.md's over-engineering rule). It sits in `test/` as a
// cross-cutting check with no module to co-locate beside (ADR-0049).
//
// Scope is deliberately narrow: **existence, not correctness**. An anchor
// (`#section`) is stripped rather than resolved, and a link that points at the
// wrong live file is a review matter, not something a path check can see.

const ROOT = join(import.meta.dirname, "..");

// `.claude/worktrees/` holds whole checkouts of this repo — walking it would
// re-walk the project once per live worktree — but `.claude/skills/` is vendored
// source that ships with it, so the skip is that one directory, not the tree.
// `test/.tmp…` goes too: those are the suite's own scratch dirs, holding
// fixtures rather than documents and created and destroyed *while* this walk
// runs — one vanishing between the readdir and the scandir is an ENOENT crash,
// not a finding.
const SKIP = new Set([".git", "node_modules", "coverage", "dist", "worktrees"]);
const skip = (/** @type {string} */ name) =>
  SKIP.has(name) || name.startsWith(".tmp");

/** Every Markdown and JS file under `dir`, recursively. */
function documents(
  /** @type {string} */ dir,
  /** @type {string[]} */ found = [],
) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (skip(entry.name)) {
      continue;
    }
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      documents(path, found);
    } else if (entry.name.endsWith(".md") || entry.name.endsWith(".mjs")) {
      found.push(path);
    }
  }
  return found;
}

// The target of a Markdown inline link: whatever sits between the brackets and
// the closing paren. Absolute URLs and bare anchors are somebody else's problem
// — the first can't be checked offline, the second names a heading, not a file.
const LINK = /\]\(([^)\s]+)\)/g;
const external = (/** @type {string} */ target) =>
  /^(https?:|mailto:|#)/.test(target);

// In a `.mjs` file the links live in comments — mostly the JSDoc header naming
// the decision that governs the module. Code below can spell the same shape
// without meaning it, and does: the over-engineering skill's import matcher is a
// regex whose character class closes immediately before its capture group, which
// reads as a link to any checker naive enough to look. So JS is read as comments.
const COMMENTS = /\/\*[\s\S]*?\*\/|\/\/[^\n]*/g;
const prose = (/** @type {string} */ file, /** @type {string} */ text) =>
  file.endsWith(".mjs") ? (text.match(COMMENTS) ?? []).join("\n") : text;

describe("documentation links", () => {
  it("every relative link points at a file that exists", () => {
    /** @type {string[]} */
    const broken = [];
    for (const file of documents(ROOT)) {
      const text = prose(file, readFileSync(file, "utf8"));
      for (const [, target = ""] of text.matchAll(LINK)) {
        if (external(target)) {
          continue;
        }
        const path = resolve(dirname(file), target.split("#")[0] ?? "");
        if (!existsSync(path)) {
          broken.push(`${relative(ROOT, file)} → ${target}`);
        }
      }
    }

    assert.deepEqual(
      broken,
      [],
      `dead links (the target no longer exists at that path):\n  ${broken.join("\n  ")}`,
    );
  });

  it("reads the documents it is meant to be reading", () => {
    // Without this the suite above passes just as well on an empty list — a
    // mis-set root or an over-eager skip would silently check nothing.
    const files = documents(ROOT).map((file) => relative(ROOT, file));
    assert.ok(files.includes("CLAUDE.md"), "walks the repo root");
    assert.ok(files.includes(join("docs", "adr", "README.md")), "walks docs/");
    assert.ok(files.includes(join("src", "render.mjs")), "walks src/");
    assert.ok(
      files.every((file) => !file.startsWith(`.claude${sep}worktrees`)),
      "never descends into a sibling worktree's checkout",
    );
  });
});
