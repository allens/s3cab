export const uploadFileCommand = {
  name: "upload-file",
  args: {
    "<bucket>": "The S3 bucket to upload to",
    "<file>": "File to upload to S3Cab repository",
  },
  options: {
    ifModifiedFrom: {
      type: "string",
      short: "m",
      description: "Only upload if file is modified since this snapshot",
    },
    throwIfNoEntry: {
      type: "boolean",
      description: "Throw an error if the file does not exist",
      default: false,
    },
  },
  exec: async (options, [bucket, file]) => {
    console.log("Not implemented: uploadFile", bucket, file, options);
  },
};

/**
 * Upload a file to an S3 bucket.
 * @param {string} bucket
 * @param {string} file
 * @param {object} [options]
 * @param {string} [options.ifModifiedFrom]
 * @param {boolean} [options.throwIfNoEntry]
 * @returns {Promise<[string, import("../prop.mjs").FileProperties]>}
 */
