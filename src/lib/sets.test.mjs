import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtempDisposable } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  formatSets,
  listSets,
  readSet,
  resolveSet,
  sanitizeNamePart,
  validateBucketName,
  validateSetName,
  writeSet,
} from "./sets.mjs";
import { ValidationError } from "./error.mjs";
import { useTempHome } from "../../test/helpers/temp-home.mjs";

// Tests for the backup-set store (docs/specs/backup.md). The store derives every
// path from s3cabDir() at call time and keeps no module state, so each test
// just points S3CAB_HOME at a temp dir (useTempHome) — no fresh-import dance
// needed, unlike auth.mjs.

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

describe("sanitizeNamePart", () => {
  it("lowercases and maps runs of other characters to one hyphen", () => {
    assert.equal(sanitizeNamePart("Jane Doe"), "jane-doe");
    assert.equal(sanitizeNamePart("OFFICE-PC"), "office-pc");
    assert.equal(sanitizeNamePart("a__b!!c"), "a-b-c");
  });

  it("trims leading/trailing hyphens (and what unicode maps to)", () => {
    assert.equal(sanitizeNamePart("-photos-"), "photos");
    assert.equal(sanitizeNamePart("über_user"), "ber-user");
  });
});

describe("validateSetName", () => {
  it("accepts canonical names", () => {
    validateSetName("photos");
    validateSetName("my-photos2");
  });

  it("rejects a non-conforming name with the rule and a suggestion", () => {
    // A ValidationError (so the CLI exits 2 without dumping usage) carrying the
    // rule + suggestion — both checked in one evaluation.
    assert.throws(
      () => validateSetName("My Photos"),
      (e) =>
        e instanceof ValidationError &&
        /lowercase letters, digits, and hyphens[\s\S]*Try: my-photos/.test(
          e.message,
        ),
    );
  });

  it("rejects a name that is not its own canonical form", () => {
    assert.throws(() => validateSetName("-photos"), /Try: photos/);
    assert.throws(() => validateSetName(""), /Invalid set name/);
  });
});

describe("validateBucketName", () => {
  it("accepts a plain bucket name", () => {
    validateBucketName("my-backup-bucket");
    validateBucketName("My.Bucket-123"); // provider rules vary; only shape is checked
  });

  it("rejects an s3:// URL with URL guidance", () => {
    assert.throws(
      () => validateBucketName("s3://my-backup-bucket"),
      /not a URL[\s\S]*s3:\/\/my-backup-bucket/,
    );
  });

  it("rejects a path or prefix", () => {
    assert.throws(() => validateBucketName("bucket/prefix"), /not a path/);
    assert.throws(() => validateBucketName("bucket\\sub"), /not a path/);
  });

  it("rejects an empty name and surrounding whitespace with distinct guidance", () => {
    // Empty name is a ValidationError (exit 2); both type and message in one check.
    assert.throws(
      () => validateBucketName(""),
      (e) =>
        e instanceof ValidationError && /No bucket name given/.test(e.message),
    );
    assert.throws(() => validateBucketName(" bucket "), /whitespace/);
  });
});

describe("set store", () => {
  it("writeSet creates the directory and dirs.txt", async () => {
    await using dir = await mkTmpDir();
    const home = useTempHome(dir.path);

    const set = writeSet("photos", {
      dirs: ["C:\\Photos", "D:\\Pics"],
      bucket: "my-bucket",
    });

    assert.equal(set.name, "photos");
    assert.deepEqual(set.dirs, ["C:\\Photos", "D:\\Pics"]);
    assert.equal(set.bucket, "my-bucket");

    const dirsTxt = readFileSync(
      join(home, ".s3cab", "sets", "photos", "dirs.txt"),
      "utf8",
    );
    assert.equal(dirsTxt, "C:\\Photos\nD:\\Pics\n");
  });

  it("writeSet re-running updates only what is passed", async () => {
    await using dir = await mkTmpDir();
    useTempHome(dir.path);
    writeSet("photos", { dirs: ["C:\\Photos"], bucket: "first-bucket" });

    const updated = writeSet("photos", { bucket: "my-bucket" });

    assert.equal(updated.bucket, "my-bucket");
    assert.deepEqual(updated.dirs, ["C:\\Photos"]); // dirs untouched
  });

  it("env updates preserve hand-written lines (the files are the API)", async () => {
    await using dir = await mkTmpDir();
    useTempHome(dir.path);
    // Create the set (its env file holds the bound bucket), then hand-edit it and
    // re-bind — the hand-written lines must survive the update.
    const { envPath } = writeSet("photos", {
      dirs: ["C:\\Photos"],
      bucket: "old-bucket",
    });
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
    const { envPath } = writeSet("photos", {
      dirs: ["C:\\Photos"],
      bucket: "old",
    });

    // A hand-made duplicate: parseEnv resolves to the LAST line, so an update
    // touching only the first occurrence would leave the old value live.
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

  // Resolution is a membership test against the real set directories, so an
  // arbitrary string (`.`, `../evil`) is just a miss like any other — reported
  // as "Unknown backup set", never as a low-level path/traversal error, and the
  // bad name is never joined into a path. With no sets at all, it points at
  // `setup` instead.
  it("reports an unknown set (not a guard error) for an arbitrary string", async () => {
    await using dir = await mkTmpDir();
    useTempHome(dir.path);
    writeSet("photos", { dirs: ["C:\\Photos"], bucket: "b" });

    assert.throws(() => readSet("../evil"), {
      message:
        /Unknown backup set: \.\.\/evil[\s\S]*Available sets:[\s\S]*photos/,
    });
    assert.throws(() => readSet("."), /Unknown backup set: \./);
  });

  it("points a `.` lookup at setup when no sets exist", async () => {
    await using dir = await mkTmpDir();
    useTempHome(dir.path);

    assert.throws(() => readSet("."), /No backup sets yet/);
  });

  it("listSets returns sorted names, and [] before any setup", async () => {
    await using dir = await mkTmpDir();
    useTempHome(dir.path);

    assert.deepEqual(listSets(), []);

    writeSet("photos", { dirs: ["C:\\Photos"], bucket: "b" });
    writeSet("docs", { dirs: ["C:\\Docs"], bucket: "b" });

    assert.deepEqual(listSets(), ["docs", "photos"]);
  });
});

describe("resolveSet", () => {
  it("defaults to the only set when exactly one exists", async () => {
    await using dir = await mkTmpDir();
    useTempHome(dir.path);
    writeSet("photos", { dirs: ["C:\\Photos"], bucket: "b" });

    assert.equal(resolveSet().name, "photos");
    assert.equal(resolveSet("photos").name, "photos");
  });

  it("errors with setup guidance when no sets exist", async () => {
    await using dir = await mkTmpDir();
    useTempHome(dir.path);

    assert.throws(() => resolveSet(), /No backup sets yet/);
  });

  it("errors listing the sets when several exist and none is named", async () => {
    await using dir = await mkTmpDir();
    useTempHome(dir.path);
    writeSet("photos", { dirs: ["C:\\Photos"], bucket: "b" });
    writeSet("docs", { dirs: ["C:\\Docs"], bucket: "b" });

    assert.throws(() => resolveSet(), /name one:[\s\S]*docs[\s\S]*photos/);
  });
});

describe("readSet bucket guarantee", () => {
  it("rejects a corrupt set whose env is missing S3CAB_BUCKET", async () => {
    await using dir = await mkTmpDir();
    const home = useTempHome(dir.path);
    // A hand-made / pre-redesign directory: dirs.txt but no bound bucket. Not a
    // supported "local-only" set (ADR-0026), so readSet refuses it — the single
    // point that guarantees every BackupSet has a bucket. (writeSet can't make
    // one, since it returns readSet, so the directory is seeded by hand here.)
    const setDir = join(home, ".s3cab", "sets", "photos");
    mkdirSync(setDir, { recursive: true });
    writeFileSync(join(setDir, "dirs.txt"), "C:\\Photos\n");

    assert.throws(() => readSet("photos"), /no bucket[\s\S]*S3CAB_BUCKET/);
  });
});

describe("formatSets", () => {
  it("renders the listing shown in docs/specs/backup.md", () => {
    const text = formatSets([
      {
        name: "photos",
        bucket: "my-backup-bucket",
        dirs: ["C:\\Users\\me\\Photos", "D:\\Pics"],
      },
      {
        name: "docs",
        bucket: "docs-bucket",
        dirs: ["C:\\Users\\me\\Documents"],
      },
    ]);

    assert.equal(
      text,
      [
        "photos   → s3://my-backup-bucket   (2 directories)",
        "         C:\\Users\\me\\Photos",
        "         D:\\Pics",
        "docs     → s3://docs-bucket   (1 directory)",
        "         C:\\Users\\me\\Documents",
      ].join("\n"),
    );
  });
});
