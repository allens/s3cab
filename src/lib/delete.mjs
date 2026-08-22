// The pure core of the `delete` command (ADR-0089): turning its operands —
// positional hashes and/or a `--from-file` listing — into the exact set of
// hashes to destroy. No S3, no filesystem: the command owns the file read, the
// preflight, the confirmation policy and the record write, so the operand
// grammar is unit-testable by asserting on returned data.
//
// The grammar is the safety story's second half. `find` moved the fuzzy step
// into a read-only command; what arrives here must already be exact, so
// anything that is not a SHA-256 — a path, a snapshot name, old muscle memory
// — is a loud per-line error, never a guess (an irreversible bucket-wide
// delete must not take a fuzzy operand). The one lenient direction is `find`'s
// own output contract (ADR-0088): `#` comments and blank lines are garnish
// the parse skips, so a reviewed, edited-down `find` file feeds `--from-file`
// unchanged.

/**
 * The SHA-256 of zero bytes — the object backing every empty file in the
 * repository. `delete` refuses it outright: deleting it is never what anyone
 * means (ADR-0089).
 */
export const EMPTY_FILE_HASH =
  "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

/** Uppercase spellings are unambiguous, so they are accepted and folded. */
const HASH = /^[0-9a-fA-F]{64}$/;

/**
 * Collect the hashes a `delete` run was given — positional operands plus the
 * lines of a `--from-file` listing. Operands must each *be* a hash; file lines
 * skip `#` comments and blanks, then take the first whitespace-separated field
 * (`find`'s bare-hash lines, or any file with hashes in column one). Anything
 * left that doesn't look like a SHA-256 lands in `rejected` verbatim, for the
 * command's loud error. Hashes are folded to lowercase and de-duplicated (a
 * hash listed twice is one object), keeping first-seen order.
 * @param {string[]} operands - The positional arguments
 * @param {string} [fileText] - The `--from-file` file's content, if given
 * @returns {{ hashes: string[], rejected: string[] }}
 */
export function collectHashes(operands, fileText) {
  /** @type {Set<string>} */
  const hashes = new Set();
  /** @type {string[]} */
  const rejected = [];
  /** @param {string} candidate */
  const take = (candidate) => {
    if (HASH.test(candidate)) {
      hashes.add(candidate.toLowerCase());
    } else {
      rejected.push(candidate);
    }
  };

  for (const operand of operands) {
    take(operand);
  }
  if (fileText !== undefined) {
    for (const line of fileText.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) {
        continue;
      }
      take(/** @type {string} */ (trimmed.split(/\s+/)[0]));
    }
  }
  return { hashes: [...hashes], rejected };
}
