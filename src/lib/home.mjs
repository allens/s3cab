import { homedir } from "node:os";
import { join } from "node:path";

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
