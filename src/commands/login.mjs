import {
  GetRoleCredentialsCommand,
  ListAccountRolesCommand,
  ListAccountsCommand,
  SSOClient,
} from "@aws-sdk/client-sso";
import {
  CreateTokenCommand,
  RegisterClientCommand,
  SSOOIDCClient,
  StartDeviceAuthorizationCommand,
} from "@aws-sdk/client-sso-oidc";
import { setTimeout as sleep } from "node:timers/promises";
import { loginCachePath, writeLoginCache } from "../auth.mjs";

// AWS SSO / IAM Identity Center login via the OIDC device-authorization flow.
// This is the auth counterpart to the S3 operations in `src/s3.mjs`; it imports
// the SSO/OIDC SDKs (a different surface from the S3 client) rather than going
// through that S3-only boundary. The session it obtains is persisted to s3cab's
// app-managed cache (`src/auth.mjs`, `~/.s3cab/auth.json`) so later commands can
// mint temporary role credentials without re-logging-in — never to `~/.aws`.
// The model is specified in specs/auth.md.

// TODO: defaults are still hardcoded; `setup` should record per-repo start URL /
// region, and account/role selection is "first found" pending interactive choice.
const DEFAULT_START_URL = "https://thehousecat.awsapps.com/start";
const DEFAULT_REGION = "eu-west-1";

const DEVICE_CODE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";

/**
 * Convert an SSO token lifetime (seconds from now) to an absolute ISO-8601
 * instant, so the cache stores an expiry the resolver can compare against.
 * @param {number} [expiresInSeconds]
 * @returns {string}
 */
const expiryFromNow = (expiresInSeconds = 0) =>
  new Date(Date.now() + expiresInSeconds * 1000).toISOString();

/**
 * Poll the SSO OIDC token endpoint until the user approves the device
 * authorization in their browser (or it expires). The device grant is
 * deliberately a polling flow: until approval lands, `CreateToken` raises
 * `AuthorizationPendingException` (keep waiting) or `SlowDownException` (wait
 * longer). Any other error is terminal. This is why a single post-prompt call is
 * wrong — it races the approval and surfaces as an opaque failure.
 *
 * @param {SSOOIDCClient} client
 * @param {{ clientId?: string, clientSecret?: string, deviceCode?: string }} params
 * @param {{ interval: number, expiresIn: number }} timing - Server-provided poll
 *   interval and device-code lifetime, both in seconds.
 * @returns {Promise<import("@aws-sdk/client-sso-oidc").CreateTokenCommandOutput>}
 */
async function pollForDeviceToken(client, params, { interval, expiresIn }) {
  const deadline = Date.now() + expiresIn * 1000;
  let delayMs = Math.max(interval, 1) * 1000;

  for (;;) {
    try {
      return await client.send(
        new CreateTokenCommand({ ...params, grantType: DEVICE_CODE_GRANT }),
      );
    } catch (error) {
      const name = /** @type {Error} */ (error).name;
      if (name === "SlowDownException") {
        delayMs += 5000; // the spec's prescribed back-off step
      } else if (name === "AccessDeniedException") {
        throw new Error("Authorization was denied in the browser", {
          cause: error,
        });
      } else if (name === "ExpiredTokenException") {
        throw new Error(
          "The authorization request expired before it was approved — run `s3cab login` again",
          { cause: error },
        );
      } else if (name !== "AuthorizationPendingException") {
        throw error;
      }
      if (Date.now() >= deadline) {
        throw new Error("Timed out waiting for browser authorization", {
          cause: error,
        });
      }
      await sleep(delayMs);
    }
  }
}

/**
 * Log in to AWS via IAM Identity Center / SSO using the OIDC device-authorization
 * flow, then persist the session to the app-managed login cache.
 *
 * Steps: register an OIDC client (requesting the `refresh_token` grant so the
 * session can be refreshed later without re-login), start a device authorization,
 * show the user the URL + code to approve in their browser, poll until approved,
 * then resolve the first available account + role. The session (registration,
 * token, account, role) is written to `~/.s3cab/auth.json`; the short-lived role
 * credentials themselves are *not* stored — they're minted on demand later.
 *
 * Instructions and progress go to stderr (stream discipline); the returned value
 * is a non-secret summary that dispatch serializes to stdout — no credentials or
 * tokens are printed (security model).
 *
 * @param {object} [options]
 * @param {string} [options.startUrl] - IAM Identity Center start URL.
 * @param {string} [options.region] - SSO region.
 * @returns {Promise<{ startUrl: string, accountId: string, roleName: string, expiresAt: string, cache: string }>}
 */
export async function login(options = {}) {
  const startUrl = options.startUrl ?? DEFAULT_START_URL;
  const region = options.region ?? DEFAULT_REGION;

  const ssoOidcClient = new SSOOIDCClient({ region });
  const ssoClient = new SSOClient({ region });

  const { clientId, clientSecret, clientSecretExpiresAt } =
    await ssoOidcClient.send(
      new RegisterClientCommand({
        clientName: "s3cab",
        clientType: "public",
        scopes: ["sso:account:access"],
        // Request both grants up front: the device flow to log in now, and
        // refresh_token so `auth.mjs` can renew the session silently later.
        grantTypes: [DEVICE_CODE_GRANT, "refresh_token"],
      }),
    );

  const {
    deviceCode,
    verificationUriComplete,
    userCode,
    interval = 5,
    expiresIn: deviceCodeExpiresIn = 600,
  } = await ssoOidcClient.send(
    new StartDeviceAuthorizationCommand({ clientId, clientSecret, startUrl }),
  );

  // Instructions go to stderr. We don't auto-open a browser, so we don't claim to.
  console.warn(`To authorize s3cab, open this URL in your browser:

  ${verificationUriComplete}

and confirm the code shown is:

  ${userCode}

Waiting for authorization…`);

  const {
    accessToken,
    refreshToken,
    expiresIn: tokenExpiresIn,
  } = await pollForDeviceToken(
    ssoOidcClient,
    { clientId, clientSecret, deviceCode },
    { interval, expiresIn: deviceCodeExpiresIn },
  );

  const { accountList } = await ssoClient.send(
    new ListAccountsCommand({ accessToken }),
  );
  const { accountId } = accountList[0];

  const { roleList } = await ssoClient.send(
    new ListAccountRolesCommand({ accessToken, accountId }),
  );
  const { roleName } = roleList[0];

  // Verify the token actually mints role credentials before caching the session,
  // so a successful `login` guarantees a usable session (the creds are discarded).
  await ssoClient.send(
    new GetRoleCredentialsCommand({ accessToken, accountId, roleName }),
  );

  const tokenExpiresAt = expiryFromNow(tokenExpiresIn);

  const cache = await writeLoginCache({
    version: 1,
    startUrl,
    region,
    accountId,
    roleName,
    registration: {
      clientId,
      clientSecret,
      // RegisterClient returns the expiry as epoch *seconds*.
      expiresAt: new Date(clientSecretExpiresAt * 1000).toISOString(),
    },
    token: { accessToken, refreshToken, expiresAt: tokenExpiresAt },
  });

  // A confirmation is progress, not the result, so it goes to stderr.
  console.warn(`Logged in to ${startUrl} — session cached to ${loginCachePath}`);

  return {
    startUrl,
    accountId,
    roleName,
    expiresAt: tokenExpiresAt,
    cache,
  };
}
