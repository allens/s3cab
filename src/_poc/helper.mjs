// Test scaffolding for the experimental S3/SSO/profile POC. Currently unused by
// any active test (only a commented-out caller remains in upload.test.mjs, beside
// this file). Lives under src/_poc/ — rather than test/ — so Node's test runner
// doesn't pick it up as a phantom test (it globs every *.mjs under test/).
// Its $HOME fixtures are in test/_poc/home/ (resolved cwd-relative below).
import { unlinkSync, writeFileSync } from "node:fs";
import path, { join } from "node:path";

export function mockHomedir() {
  if (process.platform === "win32") {
    process.env.USERPROFILE = path.win32.resolve("test\\_poc\\home");
    process.env.HOME = process.env.USERPROFILE;
  } else {
    process.env.HOME = path.posix.resolve("test/_poc/home");
  }
  return process.env.HOME;
}

/** @param {unknown} [profileData] */
export function mockHomedir2(profileData) {
  if (process.platform === "win32") {
    process.env.USERPROFILE = path.win32.resolve("test\\_poc\\home");
    process.env.HOME = process.env.USERPROFILE;
  } else {
    process.env.HOME = path.posix.resolve("test/_poc/home");
  }

  /** @type {string | undefined} */
  let profilePath;
  if (profileData) {
    profilePath = join(process.env.HOME, ".s3cab", "profile.json");
    writeFileSync(profilePath, JSON.stringify(profileData));
  }

  return {
    restore: () => {
      if (profilePath) {
        // delete profilePath
        unlinkSync(profilePath);
      }
    },
  };
}
