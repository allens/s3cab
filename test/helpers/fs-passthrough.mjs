import * as fs from "node:fs";

/**
 * Everything `node:fs` really exports, to spread into `mock.module("node:fs")`
 * beside the functions a test replaces: mocking a specifier replaces it for
 * every module that imports it, not just the one under test. Bar `constants`,
 * which is non-configurable, so importing the mock throws "Cannot redefine
 * property: constants", even for a copy of it. So a mocked `node:fs` has no
 * `constants`: a module under test that imports it fails to link ("does not
 * provide an export named 'constants'"). `node:fs/promises` has no such trap:
 * spread it whole.
 */
export const fsPassthrough = Object.fromEntries(
  Object.entries(fs).filter(([name]) => name !== "constants"),
);
