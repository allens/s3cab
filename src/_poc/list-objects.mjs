import { writeFile } from "node:fs/promises";
import { listObjects as s3ListObjects } from "./s3.mjs";

export const listCommand = {
  name: "list-objects",
  args: { "<bucket>": "Bucket name" },
  options: {
    file: { short: "f", type: "string" },
  },
  exec: async (options, [bucket]) => list(bucket, options),
};

/**
 * List objects in a bucket.
 * @param {string} bucket - The bucket name.
 * @param {object} [options]
 * @param {string} [options.file] - Write the object list to a file.
 * @returns {Promise<string | string[]>} The object list or a message.
 */
export async function list(bucket, options = {}) {
  const keys = await Array.fromAsync(
    s3ListObjects(`s3://${bucket}/${OBJECTS_PREFIX}`),
  );

  const objectList = keys.map(({ Key }) => Key.slice(OBJECTS_PREFIX_LENGTH));

  if (options.file) {
    await writeFile(options.file, JSON.stringify(objectList));
    return `Wrote ${objectList.length} objects to ${options.file}`;
  } else {
    return objectList;
  }
}

const OBJECTS_PREFIX = "objects/";
const OBJECTS_PREFIX_LENGTH = OBJECTS_PREFIX.length;
