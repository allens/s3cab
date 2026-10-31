// Each heading in guide/errors.md is still a message s3cab builds.
//
// A heading is an error's first line with `…` where the message interpolates
// a value. The literal pieces between the `…`s have to appear, in order, in one
// string the source builds, so a message reworded or removed in src/ fails
// here until its entry changes with it.
//
// "One string the source builds" is a string literal, a template, or a `+`
// chain of them, read from the parsed source rather than by running anything:
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
      "Literal, TemplateLiteral, BinaryExpression"(
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
        plugins: { index: { rules: { collect } } },
        rules: { "index/collect": "error" },
      },
      file,
    );
    assert.deepEqual(
      problems.filter(({ fatal }) => fatal),
      [],
      `${file} didn't parse`,
    );
  }
  return [...found];
}

const STRINGS = sourceStrings();

/**
 * Whether some string the source builds holds the heading's literal pieces, in
 * order.
 * @param {string} heading
 */
function built(heading) {
  const pieces = heading
    .split("…")
    .map((piece) => piece.trim())
    .filter(Boolean);
  return STRINGS.some((text) => {
    let at = 0;
    for (const piece of pieces) {
      const found = text.indexOf(piece, at);
      if (found < 0) {
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
});
