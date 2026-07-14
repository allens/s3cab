import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { mkdtempDisposable } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { remoteSnapshotsPrefix } from "../../src/lib/remote.mjs";
import {
  createSession,
  machineIdentityDir,
  readSigningIdentity,
} from "../../src/lib/roles-anywhere.mjs";
import { deleteObject } from "../../src/lib/s3.mjs";
import { readSnapshot } from "../../src/lib/snapshot-file.mjs";
import { backup } from "../../src/commands/backup.mjs";
import { restore } from "../../src/commands/restore.mjs";
import { setup } from "../../src/commands/setup.mjs";
import { useTempHome } from "../helpers/temp-home.mjs";
import { bucket, cleanupSetMarker } from "../helpers/integration.mjs";

// The Roles Anywhere runtime path against the LIVE `CreateSession` endpoint
// (ADR-0057, docs/design/roles-anywhere.md) — mocks can't exercise the SigV4-X509
// exchange, so this is the only thing that proves the signer end-to-end. Two
// levels: the raw `createSession` returns short-lived STS credentials, and a full
// backup → restore round trip runs with the set in RA mode (the set claim, upload,
// and download all authenticate through the certificate).
//
// It needs the standard test bucket (the harness gate) PLUS a machine RA identity
// with a *deployed* trust anchor — trivial to stand up via Phase A-2:
//   s3cab aws <bucket> --roles-anywhere            # generate certs + template
//   aws cloudformation deploy … --stack-name s3cab-<bucket>
//   s3cab aws --roles-anywhere --save --from-stack s3cab-<bucket>
// then point this suite at that s3cab home:
//   export S3CAB_TEST_RA_HOME="$HOME/.s3cab"        # holds roles-anywhere/
// Absent that (identity not stood up), the RA cases skip with this reason rather
// than hard-fail — the deployed trust anchor is an extra prerequisite beyond the
// bucket the folder-level gate guarantees.

const RA_HOME = process.env.S3CAB_TEST_RA_HOME;
const raReady =
  Boolean(RA_HOME) &&
  existsSync(join(String(RA_HOME), "roles-anywhere", "client.key")) &&
  existsSync(join(String(RA_HOME), "roles-anywhere", "env"));
const skip = raReady
  ? false
  : "no Roles Anywhere identity — set S3CAB_TEST_RA_HOME to an s3cab home with a deployed trust anchor (s3cab aws <bucket> --roles-anywhere --save)";

const mkTmpDir = async () => mkdtempDisposable(join("test", ".tmp"));

/**
 * Point S3CAB_HOME at a throwaway dir, then copy the operator's real RA identity
 * (certs + saved ARNs) into it — so the machine-level identity is present under the
 * isolated home the rest of the suite uses.
 * @param {string} root
 */
function useTempHomeWithRaIdentity(root) {
  useTempHome(root);
  cpSync(join(String(RA_HOME), "roles-anywhere"), machineIdentityDir(), {
    recursive: true,
  });
}

/** @type {NodeJS.ProcessEnv} */
let savedEnv;
beforeEach(() => {
  savedEnv = { ...process.env };
});
afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in savedEnv)) {
      delete process.env[key];
    }
  }
  Object.assign(process.env, savedEnv);
});

const sha256 = (/** @type {string} */ path) =>
  createHash("sha256").update(readFileSync(path)).digest("hex");

describe("Roles Anywhere runtime (real CreateSession)", () => {
  it(
    "createSession returns short-lived STS credentials from the live endpoint",
    { skip },
    async () => {
      await using dir = await mkTmpDir();
      useTempHomeWithRaIdentity(dir.path);

      const identity = readSigningIdentity();
      assert.ok(identity, "the copied RA identity must be complete");
      const creds = await createSession(identity);

      // The four fields the SDK needs, and a session token that expires in the
      // future (short-lived, not a permanent key).
      assert.match(creds.accessKeyId, /\S/);
      assert.match(creds.secretAccessKey, /\S/);
      assert.match(creds.sessionToken, /\S/);
      assert.ok(
        new Date(creds.expiration).getTime() > Date.now(),
        `expiration ${creds.expiration} should be in the future`,
      );
    },
  );

  it(
    "backs up and restores a set that signs in through Roles Anywhere",
    { skip },
    async () => {
      await using dir = await mkTmpDir();
      useTempHomeWithRaIdentity(dir.path);
      const setName = `ra${Date.now()}`; // lowercase + digits: a valid set name

      const srcDir = join(dir.path, "Photos");
      mkdirSync(srcDir, { recursive: true });
      const beach = join(srcDir, "beach.jpg");
      writeFileSync(beach, `beach ${setName}`);

      // The claim itself authenticates through the certificate (RA mode), proving
      // the signer end-to-end before a single object is uploaded.
      const set = await setup(setName, [srcDir], {
        bucket,
        "roles-anywhere": true,
      });
      assert.ok(set);
      const { snapshot } = await backup(setName);

      const { entries } = await readSnapshot(set.snapshotsDir, snapshot);
      const hashes = [...new Set([...entries.values()].map((p) => p.hash))];

      try {
        rmSync(srcDir, { recursive: true, force: true });
        const restored = await restore(setName);
        assert.equal(restored.snapshot, snapshot);
        assert.equal(restored.restored.length, entries.size);
        for (const [path, props] of entries) {
          assert.equal(sha256(path), props.hash, `content of ${path}`);
        }
      } finally {
        for (const hash of hashes) {
          await deleteObject(`s3://${bucket}/objects/${hash}`);
        }
        await deleteObject(
          `s3://${bucket}/${remoteSnapshotsPrefix(setName)}${snapshot}.tsv.zst`,
        );
        await cleanupSetMarker(setName);
      }
    },
  );
});
