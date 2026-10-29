import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { mkdtempDisposable } from "node:fs/promises";
import { join } from "node:path";
import { beforeEach, describe, it, mock } from "node:test";
import { s3Seam } from "../../test/helpers/s3-seam.mjs";

// The marker's reader, the set listing and the holder check, with the s3.mjs
// seam mocked (docs/design/testing.md: "mock at s3.mjs, not the AWS SDK"). The
// marker's real S3 behaviour (the conditional claim) is exercised against a real
// bucket in test/integration/set-marker.test.mjs. Same load-bearing ordering
// rule as objects.test.mjs: register the mock first, import set-marker.mjs
// dynamically — no static import of it.

/** @type {Record<string, string | undefined>} */
let remoteText = {};
mock.module("./s3.mjs", {
  exports: s3Seam({
    getText: async (/** @type {string} */ uri) => remoteText[uri],
    listObjects: async function* () {
      for (const uri of Object.keys(remoteText)) {
        yield { Key: uri.slice("s3://b/".length) };
      }
    },
  }),
});
const { assertHeld, listRemoteSets, parseInfo, readSetConfig } =
  await import("./set-marker.mjs");

const mkTmpDir = async () => mkdtempDisposable(join("test", ".tmp"));

beforeEach(() => {
  remoteText = {};
});

describe("parseInfo", () => {
  it("reads KEY=value lines, splitting at the first '=' and skipping unknown keys", () => {
    assert.deepEqual(
      parseInfo("OWNER=a=b@pc\nNOTE=hi\nCLAIMED=c\nCREATED=d\n"),
      { owner: "a=b@pc", claimed: "c", created: "d" },
    );
  });

  it("keeps a '#' in a value, where a dotenv reader would cut it short", () => {
    assert.equal(parseInfo("OWNER=dev#2@pc\n").owner, "dev#2@pc");
  });

  it("skips a line with no '=', such as the empty one after the final LF", () => {
    assert.deepEqual(parseInfo("OWNER=me@pc\njunk\n\nCLAIMED=c\nCREATED=d\n"), {
      owner: "me@pc",
      claimed: "c",
      created: "d",
    });
  });

  it("strips one trailing CR, so a file saved with CRLF reads the same", () => {
    assert.deepEqual(parseInfo("OWNER=me@pc\r\nCLAIMED=c\r\nCREATED=d\r\n"), {
      owner: "me@pc",
      claimed: "c",
      created: "d",
    });
  });
});

describe("listRemoteSets", () => {
  it("finds every set under snapshots/, one with only a marker included", async () => {
    remoteText = {
      "s3://b/snapshots/photos/20260612T0915.tsv.gz": "",
      "s3://b/snapshots/photos.info": "",
      "s3://b/snapshots/docs.info": "",
      "s3://b/snapshots/Not A Set/x": "",
    };

    assert.deepEqual(await listRemoteSets("b"), ["docs", "photos"]);
  });
});

describe("assertHeld", () => {
  const MINE = "OWNER=me@pc\nCLAIMED=2026-01-01T00:00:00.000Z\nCREATED=x\n";
  const INFO = "s3://b/snapshots/photos.info";

  it("passes while the bucket's marker carries this machine's OWNER and CLAIMED", async () => {
    await using dir = await mkTmpDir();
    const claimPath = join(dir.path, "claim");
    writeFileSync(claimPath, MINE);
    // CREATED is no part of the pair: a takeover keeps it.
    remoteText[INFO] = MINE.replace("CREATED=x", "CREATED=y");

    await assertHeld("b", "photos", claimPath);
  });

  it("refuses a set this machine never claimed, naming its holder", async () => {
    await using dir = await mkTmpDir();
    remoteText[INFO] = "OWNER=bob@laptop\nCLAIMED=c\nCREATED=x\n";

    await assert.rejects(
      () => assertHeld("b", "photos", join(dir.path, "claim")),
      /held by bob@laptop, not this machine[\s\S]*s3cab takeover photos/,
    );
  });

  it("refuses once another machine has taken the set over, and deletes the stale pair", async () => {
    await using dir = await mkTmpDir();
    const claimPath = join(dir.path, "claim");
    writeFileSync(claimPath, MINE);
    remoteText[INFO] = "OWNER=bob@laptop\nCLAIMED=later\nCREATED=x\n";

    await assert.rejects(
      () => assertHeld("b", "photos", claimPath),
      /taken over by bob@laptop/,
    );
    assert.equal(existsSync(claimPath), false);
  });

  it("refuses the same OWNER with another CLAIMED: a second claim from one machine", async () => {
    await using dir = await mkTmpDir();
    const claimPath = join(dir.path, "claim");
    writeFileSync(claimPath, MINE);
    remoteText[INFO] = MINE.replace("2026-01-01", "2026-02-02");

    await assert.rejects(() => assertHeld("b", "photos", claimPath));
  });
});

describe("readSetConfig", () => {
  it("reads s3cab's folder, dropping comment and blank lines in dirs.txt", async () => {
    // The remote dirs.txt mirrors the local one, so a commented-out directory
    // must not come back as a literal `# …` path for `takeover` to walk.
    remoteText = {
      "s3://b/.s3cab/sets/photos/dirs.txt":
        "# C:\\Retired\n\nC:\\Photos\n  # indented note\n",
    };

    assert.deepEqual(await readSetConfig("b", "photos"), {
      dirs: ["C:\\Photos"],
      exclude: undefined,
    });
  });
});
