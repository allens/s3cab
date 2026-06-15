import { mkdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Point s3cab's home at a temp dir for the duration of a test, by setting
 * **`S3CAB_HOME`** (see src/lib/home.mjs) — *not* by redirecting the OS `HOME`.
 *
 * This is the deliberate difference from the old per-file copies: leaving `HOME`
 * alone means `~/.aws` stays visible, so the gated real-bucket suites can resolve
 * credentials from a local profile / SSO session. Tests that never touch S3 are
 * just as isolated either way. Restore the environment in an `afterEach` (every
 * test file snapshots/restores `process.env`).
 *
 * @param {string} root - a disposable directory; s3cab's home lives at `<root>/home`
 * @returns {string} the home path (its `.s3cab` is what `S3CAB_HOME` points at)
 */
export function useTempHome(root) {
  const home = join(root, "home");
  mkdirSync(home, { recursive: true });
  process.env.S3CAB_HOME = join(home, ".s3cab");
  return home;
}
