import { homedir } from "node:os";
import { basename, join, sep } from "node:path";

/**
 * The directory where s3cab keeps all its local state — sets, snapshots, and env
 * files. Defaults to `~/.s3cab`, but an explicit **`S3CAB_HOME`** overrides it.
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
 * Abbreviate a leading home directory to `~` for display. Matches on a separator
 * boundary (`~/.s3cab`, not the whole home path alone), so a sibling whose name
 * merely starts with the home path (`/home/alex` under `/home/al`) isn't mangled
 * to `~ex/…`. The single home-path abbreviator, shared by every human-facing path
 * (render.mjs's compare header, provider's scope lines, auth.mjs's credential error).
 * @param {string} path
 * @returns {string}
 */
export const tildeify = (path) => {
  const home = homedir();
  if (path === home) {
    return "~";
  }
  return path.startsWith(home + sep) ? `~${path.slice(home.length)}` : path;
};

/**
 * Guard a caller-supplied name before it is interpolated into a path under
 * `s3cabDir()`: it must be a single path segment, else it is a traversal vector
 * — e.g. a hostile set env's `S3CAB_BUCKET = "a/../../../etc/passwd"` could make
 * a loader read an arbitrary file outside `~/.s3cab`. `basename` uses the same
 * platform path semantics as the `join` at the call site, so it catches exactly
 * the separators that could traverse here. Two ways a value escapes its intended
 * directory, both rejected:
 *   - a path separator (caught by `basename(name) !== name`);
 *   - the relative segments `.` / `..` (which `join(dir, "..")` resolves *out* of
 *     `dir` without containing a separator), or `""` (not a segment at all).
 * Periods *within* a segment are fine (`my.bucket.v2`); only the bare `.`/`..`
 * segments are rejected. Returns the name so it can wrap a `join` arg.
 * @param {string} name
 * @param {string} kind noun for the error message, e.g. "set name", "bucket name"
 * @returns {string} the validated name
 */
export const assertPathSegment = (name, kind) => {
  if (name === "" || name === "." || name === ".." || basename(name) !== name) {
    throw new Error(`Invalid ${kind} (not a single path segment): ${name}`);
  }
  return name;
};
