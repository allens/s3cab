import { S3 } from "@aws-sdk/client-s3";
import assert from "node:assert";
import crypto from "node:crypto";
import { createReadStream } from "node:fs";
import {
  readFile,
  realpath,
  stat,
  unlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { before, beforeEach, describe, it, mock } from "node:test";

const BUCKET = "s3cab-test";

// TODO fixme
// mockHomedir();

describe("upload-file", async () => {
  let uploadFileCommand;

  let emptyFile, file1, file2;

  let putFile = mock.fn();

  before(async () => {
    const mtime = new Date("2021-01-01T00:00:00Z");

    emptyFile = await realpath("./test/fixtures/dir1/zero-size");
    file1 = await realpath("./test/fixtures/dir1/hello-world.txt");
    file2 = await realpath("./test/fixtures/dir1/goodbye-world.txt");

    await utimes(emptyFile, new Date(), mtime);
    await utimes(file1, new Date(), mtime);

    mock.module("./s3.mjs", {
      namedExports: {
        putFile,
      },
    });

    ({ uploadFileCommand } = await import("./upload.mjs"));
  });

  beforeEach(() => {
    putFile.mock.resetCalls();
  });

  it.skip("succeeds with valid bucket and file", async () => {
    const response = await uploadFileCommand.run({}, [file1, BUCKET]);

    assert.deepStrictEqual(response, [
      file1,
      {
        digest:
          "c0535e4be2b79ffd93291305436bf889314e4a3faec05ecffcbb7df31ad9e51a",
        mtime: new Date("2021-01-01T00:00:00Z"),
        size: 12,
      },
    ]);
  });

  it.skip("skips if not modified", async () => {
    // const hasMock = t.mock.method(Set.prototype, "has");

    const ifModifiedFrom = join(tmpdir(), "if-modified-from");

    await writeFile(
      ifModifiedFrom,
      JSON.stringify({
        [file1]: {
          mtime: new Date("2021-01-01T00:00:00Z"),
          size: 12,
          digest:
            "c0535e4be2b79ffd93291305436bf889314e4a3faec05ecffcbb7df31ad9e51a",
        },
      }),
    );

    const options = {
      ifModifiedFrom,
    };

    await uploadFileCommand.run(options, [file1, BUCKET]);
    await uploadFileCommand.run(options, [file2, BUCKET]);

    await unlink(ifModifiedFrom);

    assert.strictEqual(putFile.mock.calls.length, 1);
  });

  it.skip("uploads if size modified", async (t) => {
    // create a random file
    const someFile = join(tmpdir(), "some-file");
    await writeFile(someFile, "some content");
    let { size, mtime } = await stat(someFile);
    const digest = crypto.hash("sha256", await readFile(someFile));

    // add it to the snapshot
    const ifModifiedFrom = join(tmpdir(), "if-modified-from" + t.name);
    await writeFile(
      ifModifiedFrom,
      JSON.stringify({ [someFile]: { size, mtime, digest } }),
    );

    // upload the file
    await new S3().putObject({
      Bucket: BUCKET,
      Key: `objects/${digest}`,
      Body: createReadStream(someFile),
    });

    await uploadFileCommand.run({ ifModifiedFrom }, [someFile, BUCKET]);

    assert.strictEqual(putFile.mock.calls.length, 0);

    await utimes(someFile, new Date(), new Date("2021-01-01T00:00:00Z"));

    await uploadFileCommand.run({ ifModifiedFrom }, [someFile, BUCKET]);

    assert.strictEqual(putFile.mock.calls.length, 1);

    await unlink(someFile);
    await unlink(ifModifiedFrom);
  });

  it.skip("warns and returns undefined if file does not exist", async (t) => {
    const warnMock = t.mock.method(console, "warn");

    const response = await uploadFileCommand.run({}, ["missing-file", BUCKET]);

    assert.strictEqual(response, undefined);
    assert.strictEqual(
      warnMock.mock.calls[0].arguments[0],
      "Upload file missing-file does not exist",
    );
  });

  it.skip("throws if not a file", async () => {
    const fn = () => uploadFileCommand.run({}, [tmpdir(), BUCKET]);

    await assert.rejects(fn, {
      message: "Not a file: " + tmpdir(),
    });
  });

  it.skip("handles empty file", async () => {
    const response = await uploadFileCommand.run({}, [emptyFile, BUCKET]);

    assert.deepStrictEqual(response, [
      emptyFile,
      {
        digest:
          "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        mtime: new Date("2021-01-01T00:00:00Z"),
        size: 0,
      },
    ]);
  });
});
