import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

// One repo invariant: no two ADRs share a number.
//
// "Take the next number" (docs/adr/README.md) cannot hold on its own, because
// the number is only free at the moment you pick it — two branches open the same
// week both read the same highest number and both are right until the second one
// merges. It happened twice in one branch: #290 took 0079 from what became
// ADR-0080, and #288 then took 0080 from what became ADR-0081. Both were found by
// hand, after merging, with the citations already spread across a dozen files.
//
// Caught here rather than by a `docs:check` script and a workflow step, because
// the test job is already required by `ci gate` and already runs on every push —
// so this costs one file and no new machinery (CLAUDE.md's over-engineering
// rule). It sits in `test/` as a cross-cutting check with no module to co-locate
// beside (ADR-0049).

const ADR_DIR = join(import.meta.dirname, "..", "docs", "adr");

/**
 * `0081-online-only-files-skipped.md` → `0081`. Non-ADR files (README) yield null.
 * @param {string} name
 * @returns {string | null}
 */
const numberOf = (name) => name.match(/^(\d{4})-.*\.md$/)?.[1] ?? null;

describe("ADR numbering", () => {
  it("gives every ADR a number no other ADR has", () => {
    /** @type {Map<string, string[]>} */
    const byNumber = new Map();
    for (const name of readdirSync(ADR_DIR)) {
      const number = numberOf(name);
      if (!number) {
        continue;
      }
      byNumber.set(number, [...(byNumber.get(number) ?? []), name]);
    }

    const collisions = [...byNumber.entries()].filter(
      ([, files]) => files.length > 1,
    );
    assert.deepEqual(
      collisions,
      [],
      collisions.length
        ? `Two ADRs claim the same number:\n` +
            collisions
              .map(([number, files]) => `  ${number}: ${files.join(", ")}`)
              .join("\n") +
            `\n\nThe one that merged second yields. Renumber it to the next free ` +
            `number, and move its citations — they are spread across src/ ` +
            `comments, CONTEXT.md, guide/ and proposals/, and some files cite ` +
            `both ADRs, so check each rather than sweeping the repo.`
        : "",
    );

    // A guard on the guard: if the pattern ever stops matching (a rename, a new
    // naming scheme), every file yields null and the check above passes on an
    // empty map while testing nothing.
    assert.ok(
      byNumber.size > 50,
      `Only ${byNumber.size} ADRs matched NNNN-slug.md — the filename pattern is stale, not the numbering`,
    );
  });
});
