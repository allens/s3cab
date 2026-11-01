// Each heading in guide/errors.md is still a message s3cab builds.
//
// A heading is an error's first line with `…` where the message interpolates
// a value. The literal pieces between the `…`s have to appear, in order, on the
// first line of one string the source builds, the first piece at its start
// unless the heading opens with `…`. So a message reworded, removed or pushed
// down a line in src/ fails here until its entry changes with it.
//
// "One string the source builds" is a string literal, a template, or a whole
// `+` chain of them, read from the parsed source rather than by running anything:
// most of these messages are thrown from inside a command, with no export to
// call. Whatever isn't literal text (a `${…}`, a variable) is a hole a piece
// can't span, and a `? :` between two strings counts as both messages, so a
// heading can follow either branch.
//
// Cross-cutting, with no module to sit beside, so it lives in test/ (ADR-0049).

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { Linter } from "eslint";

/** @import { Rule } from "eslint" */

const HOLE = "\0";

/**
 * Every text `node` can evaluate to, with a hole for each part that isn't
 * literal.
 * @param {Rule.Node} node
 * @returns {string[]}
 */
function texts(node) {
  /** @param {string[]} heads @param {string[]} tails */
  const product = (heads, tails) =>
    heads.flatMap((head) => tails.map((tail) => head + tail));
  /** @param {unknown} child */
  const of = (child) => texts(/** @type {Rule.Node} */ (child));
  switch (node.type) {
    case "Literal":
      return [typeof node.value === "string" ? node.value : HOLE];
    case "TemplateLiteral":
      return node.quasis.reduce(
        (built, quasi, i) => {
          const expression = node.expressions[i];
          const text = product(built, [quasi.value.cooked ?? ""]);
          return expression ? product(text, of(expression)) : text;
        },
        [""],
      );
    case "BinaryExpression":
      return node.operator === "+"
        ? product(of(node.left), of(node.right))
        : [HOLE];
    case "ConditionalExpression":
      return [...of(node.consequent), ...of(node.alternate)];
    default:
      return [HOLE];
  }
}

/** Every string the non-test source under src/ builds. */
function sourceStrings() {
  /** @type {Set<string>} */
  const found = new Set();
  /** @type {Rule.RuleModule} */
  const collect = {
    create: () => ({
      // Not a part of a `+` chain: the whole chain is collected, and a later
      // operand on its own would let a heading match the message's second
      // line as if it were the first.
      ":not(BinaryExpression[operator='+']) > :matches(Literal, TemplateLiteral, BinaryExpression)"(
        /** @type {Rule.Node} */ node,
      ) {
        for (const text of texts(node)) {
          found.add(text);
        }
      },
    }),
  };
  const linter = new Linter();
  const files = readdirSync("src", { recursive: true, encoding: "utf8" })
    .filter((file) => file.endsWith(".mjs") && !file.endsWith(".test.mjs"))
    .map((file) => join("src", file));
  for (const file of files) {
    const problems = linter.verify(
      readFileSync(file, "utf8"),
      {
        languageOptions: { ecmaVersion: "latest", sourceType: "module" },
        // src/'s own eslint-disable comments name rules not run here.
        linterOptions: { reportUnusedDisableDirectives: "off" },
        plugins: { index: { rules: { collect } } },
        rules: { "index/collect": "error" },
      },
      file,
    );
    // Not only the fatal ones: "No matching configuration found" is a warning,
    // and would skip the file without a word. The rule itself reports nothing.
    assert.deepEqual(problems, [], `${file} wasn't read`);
  }
  return [...found];
}

const STRINGS = sourceStrings();

/**
 * Whether some string the source builds opens with the heading: its literal
 * pieces in order on the first line, the first at the start unless the heading
 * opens with `…`.
 * @param {string} heading
 */
function built(heading) {
  const pieces = heading
    .split("…")
    .map((piece) => piece.trim())
    .filter(Boolean);
  const anchored = !heading.startsWith("…");
  return STRINGS.some((text) => {
    const [line = ""] = text.split("\n");
    let at = 0;
    for (const [i, piece] of pieces.entries()) {
      const found = line.indexOf(piece, at);
      if (found < 0 || (i === 0 && anchored && found > 0)) {
        return false;
      }
      at = found + piece.length;
    }
    return true;
  });
}

const HEADINGS = [
  ...readFileSync("guide/errors.md", "utf8").matchAll(/^### (.+)$/gm),
].map(([, heading = ""]) => heading);

describe("guide/errors.md", () => {
  it("every heading is a message s3cab builds", () => {
    const missing = HEADINGS.filter((heading) => !built(heading));

    assert.deepEqual(
      missing,
      [],
      `headings no message in src/ builds:\n  ${missing.join("\n  ")}`,
    );
  });

  it("finds the headings and messages it is meant to be checking", () => {
    // Without this the check above passes just as well on empty lists.
    assert.ok(HEADINGS.length > 50, `only ${HEADINGS.length} headings`);
    assert.ok(HEADINGS.includes("Snapshot '…' not found for set '…'."));
    assert.ok(STRINGS.length > 1_000, `only ${STRINGS.length} strings`);
  });

  it("matches a message across holes and branches, and not a rewording", () => {
    assert.ok(built("Your AWS credentials … have expired."));
    assert.ok(built("Snapshot '…' is not backed up for set '…'."));
    assert.ok(built("Snapshots … are not backed up for set '…'."));
    assert.equal(built("No backup for set '…'."), false);
    assert.equal(built("Snapshot '…' isn't backed up for set '…'."), false);
  });

  it("matches only a message's first line, from its start", () => {
    assert.ok(built("Snapshot '…' not found for set '…'."));
    // The same message's second line, and its first without its opening.
    assert.equal(built("Available snapshots (newest first):"), false);
    assert.equal(built("not found for set '…'."), false);
  });
});
