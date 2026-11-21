import assert from "node:assert/strict";
import * as realFs from "node:fs";
import { mkdtempDisposable } from "node:fs/promises";
import { basename, join } from "node:path";
import { describe, it, mock } from "node:test";
import { fsPassthrough } from "../../test/helpers/fs-passthrough.mjs";

/** @import { Dirent } from "node:fs" */

// Entries the walk lists but can't inspect: a link that can't be read (the
// Personal Vault, see `recordUninspectable`) and an entry of unknown
// type whose fallback `lstat` fails. Its own file, and a dotted aspect name
// (ADR-0049), because both failures are made by mocking `node:fs` before
// `walk.mjs` is loaded.

const VAULT = "Personal Vault";
const DENIED = "denied";

/** @type {string} */
let injectInto = "";

/**
 * @param {string} name
 * @param {string} parentPath
 * @param {boolean} link - A link, or an entry `readdir` couldn't classify
 * @returns {Dirent<Buffer>}
 */
const entry = (name, parentPath, link) =>
  /** @type {Dirent<Buffer>} */ (
    /** @type {unknown} */ ({
      name: Buffer.from(name),
      parentPath,
      isFile: () => false,
      isDirectory: () => false,
      isSymbolicLink: () => link,
      isBlockDevice: () => false,
      isCharacterDevice: () => false,
      isFIFO: () => false,
      isSocket: () => false,
    })
  );

/**
 * @param {string} code
 * @param {string} message
 */
const fsError = (code, message) =>
  Object.assign(new Error(`${code}: ${message}`), { code });

mock.module("node:fs", {
  exports: {
    ...fsPassthrough,
    /**
     * The walk's listings; any other, such as `realPath`'s plain one, is the
     * real one.
     * @param {string} dir
     * @param {{ withFileTypes?: boolean }} [options]
     * @returns {Dirent<Buffer>[] | string[]}
     */
    readdirSync: (dir, options) => {
      if (!options?.withFileTypes) {
        return realFs.readdirSync(dir);
      }
      const entries = realFs.readdirSync(dir, {
        withFileTypes: true,
        encoding: "buffer",
      });
      return dir === injectInto
        ? [...entries, entry(VAULT, dir, true), entry(DENIED, dir, false)]
        : entries;
    },
    /** @param {string} path */
    readlinkSync: (path) => {
      if (basename(path) === VAULT) {
        throw fsError("EINVAL", `invalid argument, readlink '${path}'`);
      }
      return realFs.readlinkSync(path);
    },
    /** @param {string} path */
    lstatSync: (path) => {
      if (basename(path) === DENIED) {
        throw fsError("EACCES", `permission denied, lstat '${path}'`);
      }
      return realFs.lstatSync(path);
    },
  },
});

const { walkDirs } = await import("./walk.mjs");

/** @param {string[]} patterns */
const walk = async (patterns) => {
  await using dir = await mkdtempDisposable(join("test", ".tmp"));
  const root = realFs.realpathSync.native(dir.path);
  injectInto = root;
  const { excluded, errors } = walkDirs([root], patterns);
  return { root, excluded, errors };
};

describe("walk over entries it can't inspect", () => {
  it("records each as an error when no pattern leaves it out", async () => {
    const { root, excluded, errors } = await walk([]);

    assert.deepEqual(excluded, []);
    assert.deepEqual(errors, [
      {
        path: join(root, VAULT),
        reason: `EINVAL: invalid argument, readlink '${join(root, VAULT)}'`,
      },
      {
        path: join(root, DENIED),
        reason: `EACCES: permission denied, lstat '${join(root, DENIED)}'`,
      },
    ]);
  });

  it("leaves each out with a pattern that matches it as a file", async () => {
    const { root, excluded, errors } = await walk([VAULT, DENIED]);

    assert.deepEqual(errors, []);
    assert.deepEqual(excluded, [
      { pattern: VAULT, path: join(root, VAULT), isDir: false },
      { pattern: DENIED, path: join(root, DENIED), isDir: false },
    ]);
  });

  it("doesn't match a folder pattern, since its type is unknown", async () => {
    const { excluded, errors } = await walk([`${VAULT}/`, `${DENIED}/`]);

    assert.deepEqual(excluded, []);
    assert.equal(errors.length, 2);
  });
});
