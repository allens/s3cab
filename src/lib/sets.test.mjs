import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtempDisposable } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  formatSets,
  listSets,
  namespacePart,
  readSet,
  resolveSet,
  sanitizeNamePart,
  setEnvPath,
  validateSetName,
  writeSet,
} from "./sets.mjs";

// Tests for the backup-set store (specs/backup.md). The store derives every
// path from homedir() at call time and keeps no module state, so each test
// just points homedir() at a temp dir (USERPROFILE on Windows, HOME on POSIX
// — set both) — no fresh-import dance needed, unlike auth.mjs.

const mkTmpDir = async () => mkdtempDisposable(join("test", ".tmp"));

/** @type {NodeJS.ProcessEnv} */
let savedEnv;
beforeEach(() => {
  savedEnv = { ...process.env };
});
afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in savedEnv)) delete process.env[key];
  }
  Object.assign(process.env, savedEnv);
});

/**
 * Point homedir() at a temp home under the disposable root.
 * @param {string} root
 */
function useTempHome(root) {
  const home = join(root, "home");
  mkdirSync(home, { recursive: true });
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  return home;
}

describe("sanitizeNamePart", () => {
  it("lowercases and maps runs of other characters to one hyphen", () => {
    assert.equal(sanitizeNamePart("Allen Shiels"), "allen-shiels");
    assert.equal(sanitizeNamePart("ALLEN-PC"), "allen-pc");
    assert.equal(sanitizeNamePart("a__b!!c"), "a-b-c");
  });

  it("trims leading/trailing hyphens (and what unicode maps to)", () => {
    assert.equal(sanitizeNamePart("-photos-"), "photos");
    assert.equal(sanitizeNamePart("über_user"), "ber-user");
  });
});

describe("namespacePart", () => {
  it("is the sanitized form when the charset can express the name", () => {
    assert.equal(namespacePart("Allen Shiels"), "allen-shiels");
  });

  it("falls back to a short stable hash when sanitization empties the name", () => {
    const part = namespacePart("田中");

    assert.match(part, /^[0-9a-f]{6}$/);
    assert.equal(namespacePart("田中"), part); // stable across calls
    assert.notEqual(namespacePart("佐藤"), part); // distinct identities stay distinct
  });
});

describe("validateSetName", () => {
  it("accepts canonical names", () => {
    validateSetName("photos");
    validateSetName("my-photos2");
  });

  it("rejects a non-conforming name with the rule and a suggestion", () => {
    assert.throws(
      () => validateSetName("My Photos"),
      /lowercase letters, digits, and hyphens[\s\S]*Try: my-photos/,
    );
  });

  it("rejects a name that is not its own canonical form", () => {
    assert.throws(() => validateSetName("-photos"), /Try: photos/);
    assert.throws(() => validateSetName(""), /Invalid set name/);
  });
});

describe("set store", () => {
  it("writeSet creates the folder, dirs.txt, and pins the namespace", async () => {
    await using dir = await mkTmpDir();
    const home = useTempHome(dir.path);

    const set = writeSet("photos", { dirs: ["C:\\Photos", "D:\\Pics"] });

    assert.equal(set.name, "photos");
    assert.deepEqual(set.dirs, ["C:\\Photos", "D:\\Pics"]);
    assert.equal(set.bucket, undefined);
    assert.match(String(set.namespace), /^[a-z0-9-]+@[a-z0-9-]+\/photos$/);

    const dirsTxt = readFileSync(
      join(home, ".s3cab", "sets", "photos", "dirs.txt"),
      "utf8",
    );
    assert.equal(dirsTxt, "C:\\Photos\nD:\\Pics\n");
  });

  it("writeSet binds a bucket and re-running updates only what is passed", async () => {
    await using dir = await mkTmpDir();
    useTempHome(dir.path);
    writeSet("photos", { dirs: ["C:\\Photos"] });

    const updated = writeSet("photos", { bucket: "my-bucket" });

    assert.equal(updated.bucket, "my-bucket");
    assert.deepEqual(updated.dirs, ["C:\\Photos"]); // dirs untouched
  });

  it("writeSet never recomputes the pinned namespace", async () => {
    await using dir = await mkTmpDir();
    useTempHome(dir.path);
    writeSet("photos", { dirs: ["C:\\Photos"] });

    // The user@machine pin must survive updates verbatim — hand-edit it to
    // something this machine could not produce, then update the set.
    const envPath = setEnvPath("photos");
    writeFileSync(
      envPath,
      readFileSync(envPath, "utf8").replace(
        /^S3CAB_NAMESPACE=.*$/m,
        "S3CAB_NAMESPACE=other@elsewhere/photos",
      ),
    );

    const updated = writeSet("photos", { bucket: "b" });

    assert.equal(updated.namespace, "other@elsewhere/photos");
  });

  it("env updates preserve hand-written lines (the files are the API)", async () => {
    await using dir = await mkTmpDir();
    useTempHome(dir.path);
    writeSet("photos", { dirs: ["C:\\Photos"] });

    const envPath = setEnvPath("photos");
    writeFileSync(
      envPath,
      readFileSync(envPath, "utf8") + "# my note\nAWS_REGION=eu-west-1\n",
    );

    writeSet("photos", { bucket: "my-bucket" });

    const env = readFileSync(envPath, "utf8");
    assert.match(env, /^# my note$/m);
    assert.match(env, /^AWS_REGION=eu-west-1$/m);
    assert.match(env, /^S3CAB_BUCKET=my-bucket$/m);
  });

  it("env updates rewrite every duplicate of a key (parseEnv is last-wins)", async () => {
    await using dir = await mkTmpDir();
    useTempHome(dir.path);
    writeSet("photos", { dirs: ["C:\\Photos"], bucket: "old" });

    // A hand-made duplicate: parseEnv resolves to the LAST line, so an update
    // touching only the first occurrence would leave the old value live.
    const envPath = setEnvPath("photos");
    writeFileSync(
      envPath,
      readFileSync(envPath, "utf8") + "S3CAB_BUCKET=old-duplicate\n",
    );

    const updated = writeSet("photos", { bucket: "new" });

    assert.equal(updated.bucket, "new");
  });

  it("readSet throws for an unknown set", async () => {
    await using dir = await mkTmpDir();
    useTempHome(dir.path);

    assert.throws(() => readSet("nope"), /Unknown backup set: nope/);
  });

  it("rejects a set name containing a path separator", async () => {
    await using dir = await mkTmpDir();
    useTempHome(dir.path);

    assert.throws(() => readSet("../evil"), /Invalid set name/);
  });

  it("listSets returns sorted names, and [] before any setup", async () => {
    await using dir = await mkTmpDir();
    useTempHome(dir.path);

    assert.deepEqual(listSets(), []);

    writeSet("photos", { dirs: ["C:\\Photos"] });
    writeSet("docs", { dirs: ["C:\\Docs"] });

    assert.deepEqual(listSets(), ["docs", "photos"]);
  });
});

describe("resolveSet", () => {
  it("defaults to the only set when exactly one exists", async () => {
    await using dir = await mkTmpDir();
    useTempHome(dir.path);
    writeSet("photos", { dirs: ["C:\\Photos"] });

    assert.equal(resolveSet().name, "photos");
    assert.equal(resolveSet("photos").name, "photos");
  });

  it("errors with setup guidance when no sets exist", async () => {
    await using dir = await mkTmpDir();
    useTempHome(dir.path);

    assert.throws(() => resolveSet(), /No backup sets configured/);
  });

  it("errors listing the sets when several exist and none is named", async () => {
    await using dir = await mkTmpDir();
    useTempHome(dir.path);
    writeSet("photos", { dirs: ["C:\\Photos"], bucket: "b" });
    writeSet("docs", { dirs: ["C:\\Docs"] });

    assert.throws(() => resolveSet(), /name one:[\s\S]*docs[\s\S]*photos/);
  });
});

describe("formatSets", () => {
  it("renders the listing shown in specs/backup.md", () => {
    const text = formatSets([
      {
        name: "photos",
        bucket: "my-backup-bucket",
        dirs: ["C:\\Users\\me\\Photos", "D:\\Pics"],
      },
      { name: "docs", dirs: ["C:\\Users\\me\\Documents"] },
    ]);

    assert.equal(
      text,
      [
        "photos   → s3://my-backup-bucket   (2 folders)",
        "         C:\\Users\\me\\Photos",
        "         D:\\Pics",
        "docs     (no bucket — local only)   (1 folder)",
        "         C:\\Users\\me\\Documents",
      ].join("\n"),
    );
  });
});
