import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtempDisposable } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import { useTempHome } from "../../test/helpers/temp-home.mjs";

// The succession-vs-co-existence warning: `reattach` is the one place s3cab can
// voice the *discouraged* half of ADR-0024's "discouraged-but-tolerated", and
// the only place the marker's prior OWNER is still readable (the command
// overwrites it on the way out). Separate from reattach.test.mjs, which is
// offline validation with a static import — these need the remote seam mocked,
// so the module is imported dynamically below. The runner needs
// `--experimental-test-module-mocks`.

/** @type {string} the OWNER the mocked marker reports */
let owner = "desktop-pc";
/** @type {string[]} snapshot names the mocked pull lands in the set directory */
let remoteSnapshots = [];
/** @type {string} the set directory the pull writes into */
let snapshotsDir = "";

mock.module("../lib/set-marker.mjs", {
  exports: {
    readRemoteInfo: async () => ({
      owner,
      created: "2026-01-01T00:00:00.000Z",
    }),
    readSetConfig: async () => ({ dirs: ["D:\\Photos"], exclude: undefined }),
    writeRemoteInfo: async () => {},
    listRemoteSets: async () => [],
  },
});
mock.module("../lib/remote.mjs", {
  exports: {
    // Lands real files, because the warning reads the directory back through
    // `listSnapshotNames` rather than trusting a returned count.
    downloadRemoteSnapshots: async (
      /** @type {string} */ _bucket,
      /** @type {string} */ _set,
      /** @type {string} */ dir,
    ) => {
      snapshotsDir = dir;
      mkdirSync(dir, { recursive: true });
      for (const name of remoteSnapshots) {
        writeFileSync(join(dir, `${name}.tsv.zst`), "");
      }
      return remoteSnapshots.length;
    },
  },
});
const { reattach } = await import("./reattach.mjs");

const mkTmpDir = async () => mkdtempDisposable(join("test", ".tmp"));

/** @type {NodeJS.ProcessEnv} */
let savedEnv;
/** @type {string[]} every line the command wrote to stderr */
let warnings = [];
/** @type {typeof console.warn} */
let realWarn;
beforeEach(() => {
  savedEnv = { ...process.env };
  owner = "desktop-pc";
  remoteSnapshots = [];
  snapshotsDir = "";
  warnings = [];
  realWarn = console.warn;
  console.warn = (/** @type {unknown[]} */ ...args) =>
    warnings.push(args.join(" "));
});
afterEach(() => {
  console.warn = realWarn;
  for (const key of Object.keys(process.env)) {
    if (!(key in savedEnv)) {
      delete process.env[key];
    }
  }
  Object.assign(process.env, savedEnv);
});

/** All stderr as one blob — the warnings are a sequence, not a contract on order. */
const said = () => warnings.join("\n");

describe("reattach names the machine it is taking over from", () => {
  it("warns that the prior machine keeps backing up, naming it and the last backup", async () => {
    await using dir = await mkTmpDir();
    useTempHome(dir.path);
    remoteSnapshots = ["2026-08-01T0900", "2026-08-18T1432"];

    await reattach("photos", [], { bucket: "my-bucket" });

    assert.match(said(), /Reattaching doesn't stop 'desktop-pc'/);
    assert.match(
      said(),
      /last backed up 2026-08-18T1432/,
      "the newest, not the oldest",
    );
    assert.match(said(), /meant for succession/);
  });

  it("names the machine in the directory-list nudge, which used to say 'the machine'", async () => {
    await using dir = await mkTmpDir();
    useTempHome(dir.path);

    await reattach("photos", [], { bucket: "my-bucket" });

    assert.match(said(), /The directory list came from 'desktop-pc'/);
  });

  it("says nothing about co-existence when reattaching to this machine's own set", async () => {
    // The documented flow for re-adopting your own set — delete it locally,
    // reattach. There is no other machine, so the warning would be noise.
    await using dir = await mkTmpDir();
    useTempHome(dir.path);
    owner = hostname();
    remoteSnapshots = ["2026-08-18T1432"];

    await reattach("photos", [], { bucket: "my-bucket" });

    assert.doesNotMatch(said(), /Reattaching doesn't stop/);
    assert.match(
      said(),
      /The directory list came from/,
      "the other nudge still fires",
    );
  });

  it("drops the machine's name rather than printing an empty one, on a partial marker", async () => {
    // `readRemoteInfo` reports OWNER as "" for a hand-edited or half-written
    // marker (set-marker.mjs) — a set that names nobody must not be described as
    // belonging to ''.
    await using dir = await mkTmpDir();
    useTempHome(dir.path);
    owner = "";

    await reattach("photos", [], { bucket: "my-bucket" });

    assert.doesNotMatch(said(), /''/);
    assert.match(said(), /came from the machine that claimed 'photos'/);
    assert.doesNotMatch(said(), /Reattaching doesn't stop/);
  });

  it("omits the last-backup clause for a set with no snapshots yet", async () => {
    await using dir = await mkTmpDir();
    useTempHome(dir.path);
    remoteSnapshots = [];

    await reattach("photos", [], { bucket: "my-bucket" });

    assert.match(said(), /Reattaching doesn't stop 'desktop-pc'/);
    assert.doesNotMatch(said(), /last backed up/);
    assert.equal(snapshotsDir.length > 0, true, "the pull really ran");
  });
});
