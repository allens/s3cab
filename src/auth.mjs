import { GetRoleCredentialsCommand, SSOClient } from "@aws-sdk/client-sso";
import { CreateTokenCommand, SSOOIDCClient } from "@aws-sdk/client-sso-oidc";
import { fromNodeProviderChain } from "@aws-sdk/credential-providers";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

// AWS authentication / credential resolution. This is the single source of truth
// for *how* s3cab obtains AWS credentials; the S3 SDK boundary (`src/s3.mjs`)
// hands `resolveCredentials` to its client, and `credential-process` (and the
// `backup`/upload path) reuse `resolveAppManagedAwsCredentials`. The model is
// specified in specs/auth.md. Resolution order:
//
//   0. load `.env` if present (an explicit user signal — may carry AWS_* vars)
//   1. the standard AWS SDK credential chain (env, SSO/token cache, shared
//      config/credentials, web identity, instance metadata, …)
//   2. s3cab's own app-managed login cache, created by `s3cab login`
//   3. otherwise, stop with a clear, actionable error
//
// s3cab never writes ~/.aws/config or ~/.aws/credentials — that stays user-owned.

// ── App-managed login cache ────────────────────────────────────────────────
//
// `s3cab login` persists its IAM Identity Center / SSO session here — s3cab-owned
// and separate from `~/.aws` (which stays user-managed). It holds the SSO client
// registration + token (with expiries) and the resolved account/role, enough for
// `resolveAppManagedAwsCredentials` to mint (and silently refresh) temporary role
// credentials without another interactive login. This is *session state*, not the
// short-lived role credentials themselves, which are never written to disk.

/**
 * @typedef {object} LoginCache
 * @property {number} version - Cache schema version.
 * @property {string} startUrl - The IAM Identity Center start URL.
 * @property {string} region - The SSO region.
 * @property {string} accountId - The selected AWS account ID.
 * @property {string} roleName - The selected permission-set / role name.
 * @property {object} registration - The SSO OIDC client registration.
 * @property {string} registration.clientId
 * @property {string} registration.clientSecret
 * @property {string} registration.expiresAt - ISO-8601; when the registration expires.
 * @property {object} token - The SSO access token.
 * @property {string} token.accessToken
 * @property {string} [token.refreshToken] - Used to refresh without re-login, when present.
 * @property {string} token.expiresAt - ISO-8601; when the access token expires.
 */

/** The app-managed login cache file: `~/.s3cab/auth.json`. */
export const loginCachePath = join(homedir(), ".s3cab", "auth.json");

/**
 * Read the app-managed login cache, or `null` if no login has been performed.
 * @returns {Promise<LoginCache | null>}
 */
export async function readLoginCache() {
  try {
    return JSON.parse(await readFile(loginCachePath, "utf8"));
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

/**
 * Persist the app-managed login cache to `~/.s3cab/auth.json` with owner-only
 * permissions (it holds session secrets — an SSO token and client secret).
 * @param {LoginCache} cache
 * @returns {Promise<string>} The path written.
 */
export async function writeLoginCache(cache) {
  await mkdir(dirname(loginCachePath), { recursive: true, mode: 0o700 });
  await writeFile(loginCachePath, JSON.stringify(cache, null, 2), {
    mode: 0o600,
  });
  return loginCachePath;
}

let dotEnvLoaded = false;

/**
 * Load a `.env` file from the current directory into `process.env`, once, if one
 * exists. Uses Node's native `process.loadEnvFile` — no dotenv dependency (#5).
 *
 * The presence of `.env` is treated as a deliberate choice to supply credentials
 * or a profile via environment variables, so its values participate in (and may
 * win) the standard SDK chain in step 1. Must run before any AWS client is built.
 */
export function loadDotEnv() {
  if (dotEnvLoaded) return;
  dotEnvLoaded = true;
  try {
    process.loadEnvFile(); // loads ./.env from the cwd; throws ENOENT if absent
  } catch (error) {
    // No .env is the normal case; only a real read error is worth surfacing.
    if (/** @type {NodeJS.ErrnoException} */ (error).code !== "ENOENT") {
      throw error;
    }
  }
}

const NO_CREDENTIALS_MESSAGE = `No AWS credentials found.

s3cab tried:
  1. .env / environment variables
  2. Standard AWS SDK credential resolution
  3. Cached credentials from \`s3cab login\`

To continue, do one of the following:
  - create or update a .env file with AWS_* variables
  - use an existing AWS profile and set AWS_PROFILE
  - run: s3cab login

For advanced use, you can also configure an AWS profile manually
with: credential_process = s3cab credential-process`;

// The standard AWS SDK Node.js provider chain, built once. The SDK client caches
// the credentials it returns and re-invokes the provider near expiry, so a single
// chain instance is reused across refreshes.
const standardChain = fromNodeProviderChain();

/** `error.code` marking "no app-managed login cache exists" (vs. one that is unusable). */
const NO_LOGIN = "S3CAB_NO_LOGIN";

/** Refresh the SSO access token once within this window of expiry (matches the SDK). */
const TOKEN_EXPIRY_WINDOW_MS = 5 * 60 * 1000;

const SESSION_EXPIRED_MESSAGE =
  "s3cab login session has expired (run `s3cab login`)";

/**
 * The credential provider s3cab hands to its AWS clients. Implements the
 * resolution order above: try the standard chain first; if it yields nothing,
 * fall back to the app-managed login cache; if neither works, throw an
 * actionable error. Returning a provider (rather than resolving eagerly) lets the
 * SDK cache and refresh expiration-aware credentials itself.
 *
 * @type {import("@aws-sdk/types").AwsCredentialIdentityProvider}
 */
export const resolveCredentials = async (awsIdentityProperties) => {
  try {
    return await standardChain(awsIdentityProperties);
  } catch {
    // Standard chain found nothing — fall back to the app-managed login cache.
    try {
      return await resolveAppManagedAwsCredentials();
    } catch (error) {
      // No login at all → the full "here are your options" message. But if a
      // login exists and is merely unusable (expired, refresh failed), surface
      // that specific reason instead of pretending nothing is configured.
      if (/** @type {NodeJS.ErrnoException} */ (error).code === NO_LOGIN) {
        throw new Error(NO_CREDENTIALS_MESSAGE, { cause: error });
      }
      throw error;
    }
  }
};

/**
 * Resolve temporary AWS role credentials from s3cab's own app-managed login
 * cache (created by `s3cab login`), independent of `~/.aws`. The single source of
 * truth for the `resolveCredentials` fallback and `credential-process`:
 *
 *   1. read the cache (none → throw `NO_LOGIN`, the "run s3cab login" signal);
 *   2. ensure a valid SSO access token, silently refreshing it (and rewriting the
 *      cache) when it is near expiry and a refresh token is available;
 *   3. exchange the token for short-lived role credentials via `GetRoleCredentials`.
 *
 * Returns expiration-aware credentials so the SDK caches and refreshes them
 * correctly: when the role credentials expire it re-invokes this, which re-mints
 * from the still-valid SSO token (a much cheaper call than re-logging-in).
 *
 * @returns {Promise<import("@aws-sdk/types").AwsCredentialIdentity>}
 */
export async function resolveAppManagedAwsCredentials() {
  const cache = await readLoginCache();
  if (!cache) {
    throw Object.assign(new Error("No app-managed login (run `s3cab login`)"), {
      code: NO_LOGIN,
    });
  }

  const accessToken = await validSsoAccessToken(cache);

  const sso = new SSOClient({ region: cache.region });
  const { roleCredentials } = await sso.send(
    new GetRoleCredentialsCommand({
      accessToken,
      accountId: cache.accountId,
      roleName: cache.roleName,
    }),
  );

  if (!roleCredentials?.accessKeyId || !roleCredentials.secretAccessKey) {
    throw new Error("AWS SSO returned no role credentials");
  }

  return {
    accessKeyId: roleCredentials.accessKeyId,
    secretAccessKey: roleCredentials.secretAccessKey,
    sessionToken: roleCredentials.sessionToken,
    // GetRoleCredentials returns expiration as epoch milliseconds.
    expiration: roleCredentials.expiration
      ? new Date(roleCredentials.expiration)
      : undefined,
  };
}

/**
 * Return a currently-valid SSO access token for the cached session, refreshing it
 * via the SSO OIDC `refresh_token` grant (and persisting the new token) when it is
 * within the expiry window. Throws an actionable error if the session has lapsed
 * and cannot be refreshed — the user must run `s3cab login` again.
 * @param {LoginCache} cache
 * @returns {Promise<string>}
 */
async function validSsoAccessToken(cache) {
  const msUntilExpiry = new Date(cache.token.expiresAt).getTime() - Date.now();
  if (msUntilExpiry > TOKEN_EXPIRY_WINDOW_MS) {
    return cache.token.accessToken;
  }

  const { refreshToken } = cache.token;
  if (!refreshToken) {
    throw new Error(SESSION_EXPIRED_MESSAGE);
  }

  const oidc = new SSOOIDCClient({ region: cache.region });
  let refreshed;
  try {
    refreshed = await oidc.send(
      new CreateTokenCommand({
        clientId: cache.registration.clientId,
        clientSecret: cache.registration.clientSecret,
        grantType: "refresh_token",
        refreshToken,
      }),
    );
  } catch (error) {
    // Refresh token rejected/expired, or the client registration has lapsed.
    throw new Error(SESSION_EXPIRED_MESSAGE, { cause: error });
  }

  if (!refreshed.accessToken) {
    throw new Error(SESSION_EXPIRED_MESSAGE);
  }

  await writeLoginCache({
    ...cache,
    token: {
      accessToken: refreshed.accessToken,
      // A rotated refresh token replaces the old one; otherwise keep reusing it.
      refreshToken: refreshed.refreshToken ?? refreshToken,
      expiresAt: new Date(
        Date.now() + (refreshed.expiresIn ?? 0) * 1000,
      ).toISOString(),
    },
  });

  return refreshed.accessToken;
}
