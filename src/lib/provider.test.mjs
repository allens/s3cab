import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readProviderConfig } from "./provider.mjs";

// Pure tests for the read half of the provider-config seam: a parsed env bag
// in, the five connection knobs out. The write half (gatherProviderConfig) is
// covered through its commands (provider.test.mjs, setup.test.mjs).

describe("readProviderConfig", () => {
  it("reads nothing from an empty bag (an ambient-only set)", () => {
    assert.deepEqual(readProviderConfig({}), {
      profile: undefined,
      endpoint: undefined,
      region: undefined,
      keyId: undefined,
      rolesAnywhere: false,
    });
  });

  it("maps all five knobs from their env keys", () => {
    const config = readProviderConfig({
      AWS_PROFILE: "work",
      AWS_ENDPOINT_URL_S3: "https://acct.r2.cloudflarestorage.com",
      AWS_REGION: "auto",
      AWS_ACCESS_KEY_ID: "AKIAIOSFODNN7EXAMPLE",
      S3CAB_RA: "1",
    });
    assert.deepEqual(config, {
      profile: "work",
      endpoint: "https://acct.r2.cloudflarestorage.com",
      region: "auto",
      keyId: "AKIAIOSFODNN7EXAMPLE",
      rolesAnywhere: true,
    });
  });

  it("reads the endpoint through customEndpoint (the _S3 ?? plain fallback)", () => {
    const config = readProviderConfig({
      AWS_ENDPOINT_URL: "https://s3.example",
    });
    assert.equal(config.endpoint, "https://s3.example");
  });

  it("treats a non-'1' S3CAB_RA as not Roles Anywhere (isRolesAnywhereMode's one rule)", () => {
    assert.equal(readProviderConfig({ S3CAB_RA: "0" }).rolesAnywhere, false);
  });

  it("never carries the secret", () => {
    const config = readProviderConfig({
      AWS_ACCESS_KEY_ID: "AKIAIOSFODNN7EXAMPLE",
      AWS_SECRET_ACCESS_KEY: "hunter2",
    });
    assert.doesNotMatch(JSON.stringify(config), /hunter2/);
  });
});
