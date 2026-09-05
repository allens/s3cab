import { fromNodeProviderChain } from "@aws-sdk/credential-providers";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { mkdtempDisposable } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  accessDeniedError,
  badSignatureError,
  clockSkewError,
  credentialsUsed,
  expiredCredentialsError,
  invalidCredentialsError,
  isAccessDenied,
  isBadSignature,
  isClockSkew,
  isCredentialProviderError,
  isExpiredCredentials,
  isInvalidCredentials,
  isRefusedWithoutReason,
  listProfiles,
  noCredentialsError,
  refusedWithoutReasonError,
} from "./auth.mjs";

/** An error carrying the AWS-style `name` the SDK sets from the service code. */
const named = (
  /** @type {string} */ name,
  message = "The provided token has expired.",
) => Object.assign(new Error(message), { name });

describe("isExpiredCredentials", () => {
  it("recognizes ExpiredToken, ExpiredTokenException, and TokenRefreshRequired", () => {
    assert.equal(isExpiredCredentials(named("ExpiredToken")), true);
    assert.equal(isExpiredCredentials(named("ExpiredTokenException")), true);
    assert.equal(isExpiredCredentials(named("TokenRefreshRequired")), true);
  });

  it("ignores unrelated errors and non-errors", () => {
    assert.equal(isExpiredCredentials(named("AccessDenied")), false);
    assert.equal(isExpiredCredentials(new Error("plain")), false);
    assert.equal(isExpiredCredentials("ExpiredToken"), false);
    assert.equal(isExpiredCredentials(undefined), false);
  });
});

describe("expiredCredentialsError", () => {
  it("carries an actionable, goal-framed message and keeps the cause", () => {
    const cause = named("ExpiredToken");
    const error = expiredCredentialsError(cause);
    assert.equal(error.cause, cause); // original kept for the debug path
    // Goal-framed headline, no AWS code/jargon up front (ADR-0030).
    assert.match(error.message, /^Your AWS credentials have expired\./);
    // The exact, copy-pasteable refresh command.
    assert.match(error.message, /aws sso login/);
    // Request time has no chain message to quote — headline straight to remedy.
    assert.doesNotMatch(error.message, /s3cab found your standard AWS setup/);
  });

  it("scopes to the set, quotes the chain, and names the profile at resolve time", () => {
    // The resolve-time context noCredentialsError hands over (ADR-0075).
    const cause = new Error("Token is expired. To refresh this SSO session…");
    const error = expiredCredentialsError(cause, {
      set: { name: "photos" },
      profile: "work",
      reason: "Token is expired. To refresh this SSO session…",
    });
    assert.equal(error.cause, cause);
    assert.match(
      error.message,
      /^Your AWS credentials for set 'photos' have expired\./,
    );
    // The chain's own words, so the user sees what s3cab saw.
    assert.match(
      error.message,
      /but its session is no longer valid:\s+Token is expired\./,
    );
    // Naming the profile makes the first bullet the whole command.
    assert.match(error.message, /aws sso login --profile work/);
  });
});

describe("isAccessDenied / isInvalidCredentials / isBadSignature / isClockSkew", () => {
  it("each recognizes only its own code, and ignores non-errors", () => {
    assert.equal(isAccessDenied(named("AccessDenied")), true);
    assert.equal(isAccessDenied(named("InvalidToken")), false);

    assert.equal(isInvalidCredentials(named("InvalidToken")), true);
    assert.equal(isInvalidCredentials(named("InvalidAccessKeyId")), true);
    assert.equal(isInvalidCredentials(named("InvalidSecurity")), true);
    assert.equal(isInvalidCredentials(named("ExpiredToken")), false);

    assert.equal(isBadSignature(named("SignatureDoesNotMatch")), true);
    assert.equal(isBadSignature(named("AccessDenied")), false);

    assert.equal(isClockSkew(named("RequestTimeTooSkewed")), true);
    assert.equal(isClockSkew(named("AccessDenied")), false);

    for (const predicate of [
      isAccessDenied,
      isInvalidCredentials,
      isBadSignature,
      isClockSkew,
    ]) {
      assert.equal(predicate("AccessDenied"), false);
      assert.equal(predicate(undefined), false);
    }
  });
});

describe("accessDeniedError", () => {
  const cause = named("AccessDenied", "Access Denied");

  it("names the bucket and points at 's3cab aws <bucket>' on AWS", () => {
    const error = accessDeniedError(cause, { bucket: "my-backups" });
    assert.equal(error.cause, cause);
    // Goal-framed: a permissions problem, not a credentials one.
    assert.match(
      error.message,
      /don't have permission to use the bucket "my-backups"/,
    );
    assert.match(error.message, /permissions problem, not a credentials one/);
    // The exact, copy-pasteable AWS remedy, naming the bucket.
    assert.match(error.message, /s3cab aws my-backups/);
  });

  it("embeds the raw AWS error, which is where the identity is named", () => {
    // AWS spells the calling identity into its own AccessDenied text ("User:
    // arn:aws:sts::…/SomeRole/… is not authorized to perform: s3:GetObject").
    // That is the line separating "my policy is wrong" from "I'm signed in as
    // the wrong role", so it has to reach the terminal.
    const denial = named(
      "AccessDenied",
      "User: arn:aws:sts::1234:assumed-role/SecurityAudit/me is not authorized",
    );
    const error = accessDeniedError(denial, { bucket: "my-backups" });
    assert.match(error.message, /The server reported:/);
    assert.match(error.message, /assumed-role\/SecurityAudit\/me/);
  });

  it("states the identity used and how to change it", () => {
    const error = accessDeniedError(cause, { bucket: "my-backups" });
    assert.match(error.message, /s3cab signed in with/);
    assert.match(error.message, /s3cab provider --profile <name>/);
  });

  it("points at the provider's permissions (not 's3cab aws') off AWS", () => {
    const error = accessDeniedError(cause, {
      bucket: "my-backups",
      endpoint: "https://example.r2.cloudflarestorage.com",
    });
    assert.doesNotMatch(error.message, /s3cab aws/);
    assert.match(error.message, /provider's bucket and token permissions/);
    assert.match(error.message, /my-backups/);
    // AWS profiles are an AWS concept — the switch-identity advice is AWS-only.
    assert.doesNotMatch(error.message, /--profile <name>/);
  });
});

describe("credentialsUsed", () => {
  /** @type {NodeJS.ProcessEnv} */
  let savedEnv;
  beforeEach(() => {
    savedEnv = { ...process.env };
    for (const name of ["AWS_PROFILE", "AWS_ACCESS_KEY_ID", "S3CAB_RA"]) {
      delete process.env[name]; // restored by afterEach
    }
  });
  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in savedEnv)) {
        delete process.env[key];
      }
    }
    Object.assign(process.env, savedEnv);
  });

  it("names the silent fall-through to `default` when no profile is set", () => {
    // The whole point: an unset AWS_PROFILE is invisible, and backing up as the
    // wrong role then looks identical to holding no permission.
    assert.match(
      credentialsUsed(),
      /default AWS credentials \(no AWS_PROFILE is set\)/,
    );
  });

  it("names the profile and where it came from", () => {
    process.env.AWS_PROFILE = "backup";
    const line = credentialsUsed();
    assert.match(line, /AWS profile 'backup'/);
    assert.match(line, /\(from your environment\)/);
  });

  it("reports Roles Anywhere ahead of a profile, as resolveCredentials does", () => {
    process.env.S3CAB_RA = "1";
    process.env.AWS_PROFILE = "backup";
    const line = credentialsUsed();
    assert.match(line, /Roles Anywhere \(keyless\)/);
    assert.doesNotMatch(line, /backup/);
  });

  it("traces an access key to where it came from, and never prints it", () => {
    // A shell export and a set's env file are indistinguishable once merged into
    // process.env, so the sentence must not claim the set saved a key the shell
    // supplied — that would be the same silent mystery this line exists to
    // dispel. Set here directly, so the honest answer is "your environment".
    process.env.AWS_ACCESS_KEY_ID = "AKIAEXAMPLEKEY";
    const line = credentialsUsed();
    assert.match(line, /access key from your environment/);
    assert.doesNotMatch(line, /this set/);
    assert.doesNotMatch(line, /AKIAEXAMPLEKEY/);
  });
});

describe("isRefusedWithoutReason", () => {
  /** The shape the SDK builds when a *bodiless* response is a rejection. */
  const refusal = (
    /** @type {number} */ status,
    /** @type {object} */ extra = {},
  ) =>
    Object.assign(new Error("UnknownError"), {
      name: "Unknown",
      $metadata: { httpStatusCode: status, requestId: "ABC123" },
      ...extra,
    });

  it("recognizes a 403 that arrived with no error code", () => {
    assert.equal(isRefusedWithoutReason(refusal(403)), true);
  });

  it("leaves a coded 403 alone — ADR-0037's no mushy middle", () => {
    // An unenumerated but *genuine* code still deserializes into `Code`, and
    // must keep falling through to the raw dump rather than being half-dressed.
    assert.equal(
      isRefusedWithoutReason(refusal(403, { Code: "AccountProblem" })),
      false,
    );
  });

  it("ignores other statuses and non-errors", () => {
    assert.equal(isRefusedWithoutReason(refusal(404)), false);
    assert.equal(isRefusedWithoutReason(new Error("plain")), false);
    assert.equal(isRefusedWithoutReason("UnknownError"), false);
    assert.equal(isRefusedWithoutReason(undefined), false);
  });
});

describe("refusedWithoutReasonError", () => {
  const cause = Object.assign(new Error("UnknownError"), {
    name: "Unknown",
    $metadata: { httpStatusCode: 403, requestId: "715V96E92GDSE291" },
  });

  it("admits it cannot name the cause, and leads with the identity used", () => {
    const error = refusedWithoutReasonError(cause, { bucket: "my-backups" });
    assert.equal(error.cause, cause); // original kept for the debug path
    assert.match(error.message, /didn't say why/);
    assert.match(error.message, /can't tell you which cause it\s+was/);
    assert.match(error.message, /s3cab signed in with/);
    // The request id earns its parenthetical: it is what AWS support asks for.
    assert.match(error.message, /715V96E92GDSE291/);
    // Both candidate remedies, identity first — neither claimed as *the* cause.
    assert.match(error.message, /s3cab provider --profile <name>/);
    assert.match(error.message, /s3cab aws my-backups/);
  });

  it("drops the AWS-only advice off-provider", () => {
    const error = refusedWithoutReasonError(cause, {
      bucket: "my-backups",
      endpoint: "https://example.r2.cloudflarestorage.com",
    });
    assert.doesNotMatch(error.message, /s3cab aws/);
    assert.doesNotMatch(error.message, /--profile <name>/);
    assert.match(error.message, /provider's bucket and token permissions/);
  });
});

describe("invalidCredentialsError / badSignatureError / clockSkewError", () => {
  it("each leads with its plain-language headline and embeds the raw code-first error", () => {
    const cases = [
      {
        make: invalidCredentialsError,
        cause: named(
          "InvalidToken",
          "The provided token is malformed or otherwise invalid.",
        ),
        headline: /^Your credentials were rejected as invalid\./,
        raw: /InvalidToken: The provided token is malformed/,
      },
      {
        make: badSignatureError,
        cause: named(
          "SignatureDoesNotMatch",
          "The request signature we calculated does not match.",
        ),
        headline: /signature mismatch/,
        raw: /SignatureDoesNotMatch: The request signature/,
      },
      {
        make: clockSkewError,
        cause: named(
          "RequestTimeTooSkewed",
          "The difference between the request time and the current time is too large.",
        ),
        headline: /clock is too far out of sync/,
        raw: /RequestTimeTooSkewed: The difference between/,
      },
    ];
    for (const { make, cause, headline, raw } of cases) {
      const error = make(cause);
      assert.equal(error.cause, cause); // original kept for the debug path
      assert.match(error.message, headline);
      // The raw AWS error, code-first for googling, under a label.
      assert.match(error.message, /The server reported:/);
      assert.match(error.message, raw);
      // Defers the per-source depth to the help topic.
      assert.match(error.message, /s3cab help provider/);
    }
  });
});

describe("noCredentialsError (set-scoped guidance)", () => {
  const cause = new Error("Could not load credentials from any providers");
  const set = { name: "photos", envPath: "/tmp/.s3cab/sets/photos/env" };

  it("names the set and offers the pick-one menu when nothing is configured", () => {
    const error = noCredentialsError(cause, { set });
    assert.equal(error.cause, cause); // kept for the debug path
    assert.match(error.message, /^No credentials found for set 'photos'\./);
    // The "looked in" frame: the set's env file and the ambient chain's reason.
    assert.match(
      error.message,
      /the set's own settings:.*sets[\\/]photos[\\/]env/,
    );
    assert.match(
      error.message,
      /Could not load credentials from any providers/,
    );
    // The pick-one fix, set-scoped.
    assert.match(error.message, /s3cab provider --profile <name> photos/);
    assert.match(error.message, /s3cab provider --keys photos/);
    // Nothing pinpointed → no diagnosis line about a profile.
    assert.doesNotMatch(error.message, /isn't in your AWS config/);
  });

  it("points at provider --keys when a custom endpoint has no keys", () => {
    // A non-AWS set (endpoint, no keys) must not be sent to profile advice that
    // assumes the AWS CLI — the fix is `provider --keys` (ADR-0047).
    const error = noCredentialsError(cause, {
      set,
      endpoint: "https://acct.r2.cloudflarestorage.com",
    });
    assert.match(
      error.message,
      /points at a custom S3 endpoint\s+\(https:\/\/acct\.r2\.cloudflarestorage\.com\)/,
    );
    assert.match(error.message, /s3cab provider --keys photos/);
    assert.doesNotMatch(error.message, /--profile <name>/);
  });

  it("names the missing profile and how to create it when it isn't in ~/.aws", () => {
    // AWS_PROFILE=s3cab-test, but ~/.aws only has other profiles — the "aha".
    const error = noCredentialsError(cause, {
      set,
      profile: "s3cab-test",
      knownProfiles: ["default", "work"],
    });
    assert.match(
      error.message,
      /uses AWS profile 's3cab-test', but it isn't in your AWS\s+config/,
    );
    // The exact, copy-pasteable fix, naming the profile, plus the set-scoped hatch.
    assert.match(error.message, /aws configure --profile s3cab-test/);
    assert.match(error.message, /s3cab provider --profile <name> photos/);
  });

  it("advises SSO sign-in / key check when the profile exists but yields nothing", () => {
    const error = noCredentialsError(cause, {
      set,
      profile: "s3cab-test",
      knownProfiles: ["default", "s3cab-test"],
    });
    assert.match(
      error.message,
      /uses AWS profile 's3cab-test', but it produced no/,
    );
    assert.match(error.message, /aws sso login --profile s3cab-test/);
    assert.match(error.message, /check the profile's access keys/);
  });

  it("treats an unreadable ~/.aws (undefined) as present, not missing", () => {
    // listProfiles() returns undefined when it can't read the config — don't
    // claim the profile is absent; fall to the "produced no credentials" branch.
    const error = noCredentialsError(cause, { set, profile: "s3cab-test" });
    assert.match(error.message, /produced no credentials/);
    assert.doesNotMatch(error.message, /isn't in your AWS config/);
  });

  it("points at 's3cab aws --roles-anywhere' when the RA identity is missing/broken", () => {
    // The identity case (ADR-0057): the set is in Roles Anywhere mode but this
    // machine's certificate identity is absent/incomplete — steer to setting it
    // up, and name the identity (not ~/.aws) as the second place s3cab looked.
    const raCause = new Error(
      "No usable Roles Anywhere certificate identity at ~/.s3cab/roles-anywhere.",
    );
    const error = noCredentialsError(raCause, {
      set,
      rolesAnywhere: "identity",
    });
    assert.match(error.message, /^No credentials found for set 'photos'\./);
    assert.match(error.message, /uses Roles Anywhere \(keyless\)/);
    // Step 2 names the machine identity, not the AWS chain.
    assert.match(error.message, /your machine's Roles Anywhere identity/);
    assert.doesNotMatch(error.message, /standard AWS setup/);
    // The exact, copy-pasteable setup + ARN-capture commands.
    assert.match(error.message, /s3cab aws <bucket> --roles-anywhere/);
    assert.match(error.message, /--save --from-stack s3cab-<bucket>/);
  });

  it("spells the Roles Anywhere recipe for the set's bucket when it is known", () => {
    const error = noCredentialsError(new Error("no identity"), {
      set,
      rolesAnywhere: "identity",
      bucket: "s3cab-photos",
    });
    assert.match(error.message, /s3cab aws s3cab-photos --roles-anywhere/);
    // The stack stem de-dupes the `s3cab-` prefix (ADR-0056's naming rule).
    assert.match(error.message, /--from-stack s3cab-photos\b/);
    assert.doesNotMatch(error.message, /s3cab-s3cab-/);
  });

  it("quotes the endpoint's refusal and steers to re-capturing the stack when a session is refused", () => {
    // The session case (ADR-0075): the identity is whole, the request was signed,
    // and AWS said no — the live 403 for a profile ARN the region doesn't know.
    const refusal = new Error(
      'Roles Anywhere CreateSession failed (HTTP 403): {"message":"Invalid or empty profile provided."}',
    );
    const error = noCredentialsError(refusal, {
      set,
      rolesAnywhere: "session",
      bucket: "my-bucket",
    });
    assert.equal(error.cause, refusal);
    assert.match(error.message, /^No credentials found for set 'photos'\./);
    assert.match(error.message, /AWS would not exchange it for a session/);
    // Step 2 is the endpoint, quoting its own words.
    assert.match(error.message, /AWS Roles Anywhere/);
    assert.match(error.message, /Invalid or empty profile provided/);
    assert.doesNotMatch(error.message, /standard AWS setup/);
    // The fix leads with the region check + re-capture, for the set's bucket.
    assert.match(error.message, /AWS_REGION in .*roles-anywhere[\\/]env/);
    assert.match(error.message, /--save --from-stack s3cab-my-bucket/);
    // …and falls back to standing the identity up afresh.
    assert.match(error.message, /s3cab aws my-bucket --roles-anywhere/);
  });

  it("never reads 'expired' in a Roles Anywhere refusal as an expired SSO sign-in", () => {
    // AWS says "expired" about the certificate or the trust anchor; the expiry
    // hand-off would answer with `aws sso login`, which has nothing to do with it.
    const refusal = new Error(
      "Roles Anywhere CreateSession failed (HTTP 403): certificate has expired",
    );
    for (const rolesAnywhere of /** @type {const} */ ([
      "identity",
      "session",
    ])) {
      const error = noCredentialsError(refusal, { set, rolesAnywhere });
      assert.match(error.message, /^No credentials found for set 'photos'\./);
      assert.doesNotMatch(error.message, /aws sso login/);
      assert.doesNotMatch(error.message, /have expired\./);
    }
  });

  it("diagnoses an expired sign-in instead of offering the pick-one menu", () => {
    // The steady-state error once auth works: the chain found an SSO session and
    // it had run out. "No credentials found" + `s3cab provider …` would send the
    // user to reconfigure a set that is fine (ADR-0075) — both must be gone.
    for (const expiry of [
      // @aws-sdk/token-providers (the cached token itself is stale)…
      "Token is expired. To refresh this SSO session run 'aws sso login' with the corresponding profile.",
      // …and @aws-sdk/credential-provider-sso (the token is live, the session isn't).
      "The SSO session associated with this profile has expired. To refresh this SSO session run aws sso login with the corresponding profile.",
    ]) {
      const error = noCredentialsError(new Error(expiry), { set });
      assert.match(
        error.message,
        /^Your AWS credentials for set 'photos' have expired\./,
      );
      assert.match(error.message, /aws sso login/);
      assert.match(error.message, new RegExp(expiry.slice(0, 20)));
      assert.doesNotMatch(error.message, /No credentials found/);
      assert.doesNotMatch(error.message, /s3cab provider/);
      assert.doesNotMatch(error.message, /s3cab looked in/);
    }
  });

  it("diagnoses an expired sign-in with no set loaded, too", () => {
    // setup/reattach run on ambient credentials, which expire the same way — the
    // headline just can't name a set.
    const error = noCredentialsError(new Error("Token is expired. …"));
    assert.match(error.message, /^Your AWS credentials have expired\./);
    assert.doesNotMatch(error.message, /for set '/);
    assert.doesNotMatch(error.message, /No AWS credentials found/);
  });

  it("keeps the generic frame for a chain failure that isn't expiry", () => {
    // The line ADR-0075 draws: only expiry is classified from the message; every
    // other chain failure keeps the "looked in" frame and its tailored fix.
    const error = noCredentialsError(cause, { set });
    assert.match(error.message, /^No credentials found for set 'photos'\./);
    assert.doesNotMatch(error.message, /have expired/);
  });

  it("uses the ambient template when no set is loaded (setup / upload --bucket)", () => {
    // setup/reattach (the set doesn't exist yet) and upload --bucket resolve no
    // set, so the error can't name one — it reports the ambient failure and
    // steers to ambient creds (a profile or exported AWS_*), not `provider`
    // (which needs a set to write to).
    const error = noCredentialsError(cause); // no set
    assert.equal(error.cause, cause);
    assert.match(error.message, /^No AWS credentials found\./);
    assert.match(error.message, /runs on your ambient AWS credentials/);
    assert.match(
      error.message,
      /Could not load credentials from any providers/,
    );
    assert.doesNotMatch(error.message, /for set '/); // not set-scoped
    assert.doesNotMatch(error.message, /--bucket/); // no longer --bucket-specific
    assert.match(error.message, /s3cab help provider/);
  });
});

// Reading AWS shared-config profile names (used by `provider`/`setup` to catch a
// typo'd --profile). No mocking: point the SDK's AWS_CONFIG_FILE /
// AWS_SHARED_CREDENTIALS_FILE overrides at fixture files in a temp dir, so the
// real parser runs against real bytes.
describe("listProfiles", () => {
  const mkTmpDir = async () => mkdtempDisposable(join("test", ".tmp"));

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

  it("merges config + credentials and strips the '[profile X]' prefix, sorted", async () => {
    await using dir = await mkTmpDir();
    const cfg = join(dir.path, "config");
    const creds = join(dir.path, "credentials");
    writeFileSync(
      cfg,
      "[profile work]\nregion = eu-west-1\n[default]\nregion = us-east-1\n",
    );
    writeFileSync(creds, "[personal]\naws_access_key_id = AKIA...\n");
    process.env.AWS_CONFIG_FILE = cfg;
    process.env.AWS_SHARED_CREDENTIALS_FILE = creds;

    assert.deepEqual(await listProfiles(), ["default", "personal", "work"]);
  });

  it("returns [] when the config files don't exist", async () => {
    await using dir = await mkTmpDir();
    process.env.AWS_CONFIG_FILE = join(dir.path, "no-config");
    process.env.AWS_SHARED_CREDENTIALS_FILE = join(dir.path, "no-creds");

    assert.deepEqual(await listProfiles(), []);
  });
});

// The guard the entry point's `unhandledRejection` handler decides on: swallow a
// background credential refresh that failed, re-throw anything else. Matching a
// foreign error by `name` can rot silently when the SDK is upgraded, so the first
// test asks the *real* chain for a real rejection rather than a hand-built stand-in
// — the same no-mocking approach `listProfiles` above takes, and the reason this
// block sits down here with that machinery.
describe("isCredentialProviderError", () => {
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

  it("recognizes what the AWS chain itself rejects with", async () => {
    await using dir = await mkdtempDisposable(join("test", ".tmp"));
    // Strip every ambient AWS_* (a dev box or CI may carry keys, a profile, or
    // OIDC vars) so the chain has nothing to find, and keep it off the network:
    // the instance-metadata link would otherwise time out for seconds.
    for (const key of Object.keys(process.env)) {
      if (key.startsWith("AWS_")) {
        delete process.env[key];
      }
    }
    process.env.AWS_CONFIG_FILE = join(dir.path, "no-config");
    process.env.AWS_SHARED_CREDENTIALS_FILE = join(dir.path, "no-creds");
    process.env.AWS_EC2_METADATA_DISABLED = "true";

    const rejection = await fromNodeProviderChain()({}).then(
      () => undefined,
      (error) => error,
    );
    assert.ok(rejection, "the chain must fail with nothing to resolve");
    assert.equal(isCredentialProviderError(rejection), true);
  });

  it("re-throws our own bugs: a plain rejection is not the SDK's", () => {
    assert.equal(isCredentialProviderError(new Error("boom")), false);
    assert.equal(
      isCredentialProviderError(new TypeError("x is not a fn")),
      false,
    );
    assert.equal(isCredentialProviderError(named("AccessDenied")), false);
    assert.equal(isCredentialProviderError("CredentialsProviderError"), false);
    assert.equal(isCredentialProviderError(undefined), false);
  });
});
