import { unlinkSync, writeFileSync } from "node:fs";
import path, { join } from "node:path";

export function mockHomedir() {
  if (process.platform === "win32") {
    process.env.USERPROFILE = path.win32.resolve("test\\home");
    process.env.HOME = process.env.USERPROFILE;
  } else {
    process.env.HOME = path.posix.resolve("test/home");
  }
  return process.env.HOME;
}

export function mockHomedir2(profileData) {
  if (process.platform === "win32") {
    process.env.USERPROFILE = path.win32.resolve("test\\home");
    process.env.HOME = process.env.USERPROFILE;
  } else {
    process.env.HOME = path.posix.resolve("test/home");
  }

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
