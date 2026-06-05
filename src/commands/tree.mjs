import { Temporal } from "@js-temporal/polyfill";
import assert from "node:assert";
import { existsSync, readdirSync, realpathSync } from "node:fs";
import { join, posix, resolve, sep } from "node:path";
import { stderr } from "node:process";
import { secondsSince } from "../format.mjs";
import { readLines } from "../read-lines.mjs";
import { formatSnapshotLine } from "../snapshot-file.mjs";

/**
 * Recursively list files in a directory.
 * @param {string} dir - Directory to list files from
 * @returns {Array<string>} Array of file paths
 */
export function tree(dir = ".", writeStream = null) {
  const start = Temporal.Now.instant();

  dir = realpathSync.native(dir);

  console.warn("Finding files in", `'${dir}'`);

  // Create exclude predicatetr
  let walkCallbackFn = null;
  let excludes = [];
  const excludeFilePath = join(dir, ".s3cab", "exclude.txt");
  if (existsSync(excludeFilePath)) {
    console.warn("Using exclude file", `'${excludeFilePath}'`);

    walkCallbackFn = createWalkCallbackFn(
      dir,
      readLines(excludeFilePath),
      writeStream ?? {
        write: (line) => {
          excludes.push(line);
        },
      },
    );
  }

  const files = Array.from(walkFiles(dir, walkCallbackFn), (path, index) => {
    if (index % 500 === 0) {
      stderr.write(`\rFound ${index} files...`);
    }
    return path;
  });

  stderr.write(secondsSince(start) + "\n");

  excludes.forEach((line) => stderr.write(line));

  assert(files.length === new Set(files).size, "File list contains duplicates");

  return files;
}

/**
 * Create a predicate function to exclude files based on patterns.
 * @param {string} baseDir - Base directory
 * @param {string[]} patterns - Exclude patterns
 * @returns {(dirent: import("fs").Dirent) => string} walk callback function
 */
function createWalkCallbackFn(baseDir, patterns, snapshotWriteStream = null) {
  const matchers = patterns.map((pattern) =>
    createMatcher(join(baseDir, pattern)),
  );

  return (dirent) => {
    const path = resolve(dirent.parentPath, dirent.name);
    const fileType = getFileType(dirent);

    if (dirent.isFile() || dirent.isDirectory()) {
      let testString = path.split(sep).join(posix.sep);

      if (dirent.isDirectory()) {
        testString += posix.sep;
      }

      const index = matchers.findIndex((matcher) => matcher.test(testString));

      if (index >= 0) {
        snapshotWriteStream?.write(
          formatSnapshotLine("#EXCLUDED", fileType, patterns.at(index), path),
        );
        return null;
      }
    } else {
      snapshotWriteStream?.write(
        formatSnapshotLine(
          "#EXCLUDED",
          fileType,
          "Unsupported file type",
          path,
        ),
      );
    }

    return path;
  };
}

/**
 * Get the file type of a dirent.
 * @param {import("fs").Dirent} dirent - Directory entry
 * @returns {string} File type
 */
function getFileType(dirent) {
  if (dirent.isFile()) {
    return "File";
  } else if (dirent.isDirectory()) {
    return "Directory";
  } else if (dirent.isSymbolicLink()) {
    return "SymbolicLink";
  } else if (dirent.isBlockDevice()) {
    return "BlockDevice";
  } else if (dirent.isCharacterDevice()) {
    return "CharacterDevice";
  } else if (dirent.isFIFO()) {
    return "FIFO";
  } else if (dirent.isSocket()) {
    return "Socket";
  }
  return "Unknown File Type";
}

/**
 * Create a RegExp matcher from a pattern.
 * @param {string} pattern - Pattern string
 * @returns {RegExp} RegExp matcher
 */
function createMatcher(pattern) {
  // @ts-ignore - RegExp.escape exists in Node 24+
  const regexPattern = RegExp.escape(
    posix.normalize(pattern.split(sep).join(posix.sep)),
  )
    // **/ matches zero or more segments
    .replace(/\\\*\\\*\\\//g, "(.*\\/)?")
    // * matches one or more chars in one segment
    .replace(/\\\*/g, "[^/]+")
    // ? matches one char
    .replace(/\\\?/g, "[^/]");

  return new RegExp(
    `^${regexPattern}$`,
    process.platform === "win32" ? "i" : "",
  );
}

/**
 * Recursively walk through a directory and yield file paths.
 * @param {string} dir - Directory to walk through
 * @param  {(dirent: import("fs").Dirent) => string} [callbackFn] - Callback function to process files
 * @yields {string} File paths
 * @returns {Generator<string>} Generator of file paths
 */
function* walkFiles(dir, callbackFn = null) {
  for (const dirent of readdirSync(dir, { withFileTypes: true })) {
    const { parentPath, name } = dirent;

    const path = callbackFn ? callbackFn(dirent) : join(parentPath, name);

    if (!path) {
      continue;
    }

    if (dirent.isDirectory()) {
      if (name === ".s3cab") {
        continue;
      }
      yield* walkFiles(path, callbackFn);
    } else {
      yield path;
    }
  }
}
