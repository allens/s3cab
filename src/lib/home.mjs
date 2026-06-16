import { homedir } from "node:os";
import { basename, join } from "node:path";

/**
 * The directory where s3cab keeps all its local state — sets, snapshots, env
 * files, and the per-bucket objects cache. Defaults to `~/.s3cab`, but an explicit
 * **`S3CAB_HOME`** overrides it.
 *
 * The override exists so a process can relocate s3cab's home *without* moving the
 * whole OS `HOME`. That matters most for tests: the integration suites need to
 * isolate s3cab's state but must leave `HOME` alone so the AWS SDK can still resolve
 * real credentials from `~/.aws` (see test/helpers/temp-home.mjs). It is also a
 * genuine user-facing knob — point s3cab's state elsewhere if you want.
 *
 * Read at call time, so a caller may set `S3CAB_HOME` before invoking s3cab code.
 * @returns {string}
 */
export const s3cabDir = () =>
  process.env.S3CAB_HOME ?? join(homedir(), ".s3cab");

/**
 * Guard a caller-supplied name before it is interpolated into a path under
 * `s3cabDir()`: it must be a single path segment, else it is a traversal vector
 * — e.g. a hostile set env's `S3CAB_BUCKET = "a/../../../etc/passwd"` could make
 * a loader read an arbitrary file outside `~/.s3cab`. `basename` uses the same
 * platform path semantics as the `join` at the call site, so it catches exactly
 * the separators that could traverse here; a clean single-segment name is its
 * own basename (dots are fine). Returns the name so it can wrap a `join` arg.
 * @param {string} name
 * @param {string} kind noun for the error message, e.g. "set name", "bucket name"
 * @returns {string} the validated name
 */
export const assertPathSegment = (name, kind) => {
  if (basename(name) !== name) {
    throw new Error(`Invalid ${kind} (contains a path separator): ${name}`);
  }
  return name;
};
