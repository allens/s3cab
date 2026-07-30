// The vocabulary of the *referenced-object enumeration* — the shape
// `referencedObjects` (remote.mjs) produces, the classifier that decides which
// read failures become findings, and the two things every consumer of a
// bucket-wide scan needs: the set-qualified list of snapshots that would not
// read, and the one message the commands report it with.
//
// **Why this is not in remote.mjs, which produces the shape**
// ([ADR-0074](../../docs/adr/0074-referenced-enumeration-vocabulary-module.md)):
// remote.mjs reaches `@aws-sdk/client-s3`, and `cleanup.mjs`/`delete.mjs`/
// `unrestorable.mjs` are pure planners with no runtime imports at all. Putting
// the vocabulary with its producer would drag the SDK into three pure modules
// and their tests to flatten an array. So this module imports **nothing** and
// every consumer — producer included — depends on it.

/**
 * One referenced path within a set: the `sizes` its snapshot rows record and the
 * `snapshots` that reference the content under this path. Recorded per path (not
 * per hash) so the problem model is file-centric — a hash under many paths yields
 * many entries — and so a recorded-size mismatch is attributed to the exact
 * file(s) whose size disagrees with storage. `sizes` is a Set because content
 * fixes size — so a healthy path records exactly one — but a *torn* snapshot file can
 * record the same path at two sizes across snapshots; keeping both lets that hide
 * nowhere (each is checked against the one stored object).
 * @typedef {Object} PathReference
 * @property {Set<number>} sizes - The distinct sizes the snapshot rows record for this path (normally one)
 * @property {Set<string>} snapshots - Names of the snapshots that reference it under this path
 */

/**
 * One object referenced by a set's snapshots: the `paths` it was stored under,
 * each with its recorded size and referencing snapshots. Content-addressed dedup
 * means one hash can back many paths; verify reports against the *paths*, so all
 * of them are retained (cheap — usually one path per content).
 * @typedef {Object} ReferencedObject
 * @property {Map<string, PathReference>} paths - Each path referencing this content
 */

/**
 * The result of enumerating a set's referenced objects (built by `referencedObjects`
 * in remote.mjs): the `referenced` map, how many snapshots were read successfully
 * (`snapshotsChecked`), and the `unreadable` snapshots — those that failed to
 * decompress/parse, a finding in their own right (their references went unchecked).
 * @typedef {Object} ReferencedResult
 * @property {Map<string, ReferencedObject>} referenced
 * @property {number} snapshotsChecked
 * @property {{ snapshot: string, reason: string }[]} unreadable
 */

/**
 * Whether an error reading a remote snapshot means the *snapshot itself* is
 * damaged (a finding — verify records it and carries on) rather than an
 * operational S3 failure (network/auth/throttle — an ordinary error that aborts
 * the run, docs/design/backup.md). Damage is a zstd decompression failure
 * (`code` like `ZSTD_error_*`) or a snapshot-parse assertion (`AssertionError`
 * from `parseSnapshotStream`); anything else — an SDK/credential/network error —
 * is *not* corruption and is rethrown, so an outage never masquerades as data
 * loss. Unknown → not corruption → abort (the safe direction).
 * @param {unknown} error
 * @returns {boolean}
 */
export function isCorruptSnapshotError(error) {
  if (!Error.isError(error)) {
    return false;
  }
  const code = /** @type {NodeJS.ErrnoException} */ (error).code;
  return (
    error.name === "AssertionError" ||
    (typeof code === "string" && code.startsWith("ZSTD_"))
  );
}

/**
 * The bucket's unreadable snapshots, each qualified by the set it belongs to —
 * `set/snapshot`, the name a whole-bucket scan has to use because a snapshot name
 * alone is only unique within its set. Written the same way as its place in the
 * bucket (`snapshots/<set>/<name>.tsv.zst`), so a name printed here pastes
 * straight after `s3://<bucket>/snapshots/` (CONTEXT.md, **Snapshot**).
 *
 * `referencedObjects` reports these **per set**, but every consumer of a
 * whole-bucket scan wants them flat: `cleanup` and `delete` refuse on a non-empty
 * list, `forget` caveats its preview with one. The per-set `reason` is dropped —
 * these three commands say *which* snapshots and send the user to `verify` for
 * *why*, and `verify` reads the per-set list where the reason is still carried.
 * @param {Map<string, ReferencedResult>} referencedBySet - The bucket's per-set enumeration (`referencedObjects`)
 * @returns {string[]} `set/snapshot` names, in scan order
 */
export const unreadableSnapshots = (referencedBySet) =>
  [...referencedBySet].flatMap(([set, result]) =>
    result.unreadable.map(({ snapshot }) => `${set}/${snapshot}`),
  );

/**
 * The one message `cleanup`, `delete` and `forget` report unreadable snapshots
 * with (ADR-0030): what it stops the user doing, the plain reason, every name,
 * and the exact command that diagnoses it. Returns *text* rather than an `Error`
 * because half its callers push it into a summary they are already building and
 * half throw it — the shared part is the wording, not the throwing.
 *
 * Every name is listed, never elided: a count is no use to someone deciding
 * which snapshot to look at, and this is a data-loss report. There is no count
 * *in the prose* either — the list is the count — which leaves this function as
 * the **only** place number agreement is needed. Each caller's `consequence` is
 * therefore worded number-neutrally ("an unknown reference could be…", not "one
 * could be…"), so one snapshot and forty read correctly from the same clause.
 * @param {Object} message
 * @param {string[]} message.names - The `set/snapshot` names (`unreadableSnapshots`)
 * @param {string} message.bucket - The repository bucket, so the fix pastes as-is
 * @param {string} message.consequence - What follows from not knowing their references, in the caller's terms. **Must read for one snapshot or many.**
 * @param {string} [message.lead] - The blocked goal (`Can't delete safely`); omitted where the command carries on regardless
 * @returns {string}
 */
export const unreadableMessage = ({ names, bucket, consequence, lead }) => {
  const one = names.length === 1;
  const subject = one ? "this snapshot" : "these snapshots";
  return [
    `${lead ? `${lead} — ${subject}` : subject.charAt(0).toUpperCase() + subject.slice(1)} ` +
      `can't be read, so ${consequence}:`,
    ...names.map((name) => `  ${name}`),
    `Check ${one ? "it" : "them"} with:`,
    `  s3cab verify ${bucket}`,
  ].join("\n");
};
