import { requireArg } from "../lib/error.mjs";
import { findInSnapshots } from "../lib/find.mjs";
import { NO_SETS_MESSAGE, listSets, readSet } from "../lib/sets.mjs";

/** @import { FindResult } from "../lib/find.mjs" */

/**
 * Search local snapshot history for backed-up files, and report the objects
 * that back them ([ADR-0088](../../docs/adr/0088-find-matches-like-posix-find.md)).
 * It answers "which snapshot has my file, and what did it hash to", which the
 * tool could not answer at all, and it ships on its own. It is also the first
 * half of a settled-but-unbuilt rework in which `delete` takes **hashes**
 * (proposals/hash-operand-delete.md): an irreversible bucket-wide delete must not
 * take a fuzzy operand, so the fuzzy step becomes this read-only command where a
 * mistake costs nothing. Nothing here depends on that landing.
 *
 * **Local only, and free.** No `--remote`: `reattach` pulls a set's entire
 * snapshot history down precisely so the browse commands stay local
 * ([ADR-0027](../../docs/adr/0027-compare-local-only-adoption-syncs-manifests.md)),
 * and this one joins `compare`/`list`/`restore` there. It costs zero S3 calls.
 *
 * **Every attached set, narrowed by `--set`.** Searching one set by default
 * would be the wrong default for the question — "where is this file" does not
 * come with a set in mind, and the answer that matters most is the one you
 * didn't think to look for. No `--bucket`: a set is bound to one bucket at
 * creation ([ADR-0026](../../docs/adr/0026-bucket-required-at-setup.md)), so the
 * report names each set's bucket rather than taking one as an operand.
 *
 * Patterns are the bulk operand and so are positional, with the addressing on a
 * flag ([ADR-0062](../../docs/adr/0062-bulk-operands-positional-addressing-by-flag.md)).
 * @param {string[]} patterns - Find patterns (`compileFindPattern` defines them)
 * @param {object} [options]
 * @param {string} [options.set] - Search only this set
 * @param {boolean} [options.all] - List every snapshot instead of collapsing runs into ranges
 * @returns {Promise<FindResult>}
 */
export async function find(patterns, options = {}) {
  requireArg(patterns.length, "pattern");

  // A named set is resolved (and rejected) by `readSet`, which lists the real
  // ones on a miss; with none named the answer spans every attached set.
  const names = options.set === undefined ? listSets() : [options.set];
  if (names.length === 0) {
    throw new Error(NO_SETS_MESSAGE);
  }

  return await findInSnapshots(
    names.map((name) => readSet(name)),
    patterns,
    { all: options.all },
  );
}
