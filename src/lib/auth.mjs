import { GetRoleCredentialsCommand, SSOClient } from "@aws-sdk/client-sso";
import { CreateTokenCommand, SSOOIDCClient } from "@aws-sdk/client-sso-oidc";
import { fromNodeProviderChain } from "@aws-sdk/credential-providers";
import { readFileSync } from "node:fs";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { parseEnv } from "node:util";

// AWS authentication / credential resolution. This is the single source of truth
// for *how* s3cab obtains AWS credentials; the S3 SDK boundary (`src/lib/s3.mjs`)
// hands `resolveCredentials` to its client, and `credential-process` (and the
// `backup`/upload path) reuse `resolveAppManagedAwsCredentials`. The model is
// specified in specs/auth.md. Resolution order:
//
//   0. load s3cab's layered env files if present (see `loadEnv`) — an explicit
//      user signal that may carry AWS_* vars, a profile, an endpoint, a bucket
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
  const dir = dirname(loginCachePath);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await writeFile(loginCachePath, JSON.stringify(cache, null, 2), {
    mode: 0o600,
  });
  // The `mode:` options above only apply when the dir/file are *created*; an
  // already-existing cache (e.g. from an earlier version) could carry looser
  // perms. chmod unconditionally so the owner-only guarantee holds across
  // re-logins and upgrades. (No-op on Windows, which ignores POSIX mode bits.)
  await chmod(dir, 0o700);
  await chmod(loginCachePath, 0o600);
  return loginCachePath;
}

// ── Environment-file loading ───────────────────────────────────────────────
//
// s3cab reads its own layered env files into process.env before any AWS client
// is built — never the cwd `.env`, and never `~/.aws/*`. This lets AWS_* vars, a
// profile, a custom endpoint, or a default bucket be configured per-user,
// per-bucket, or per-backup-folder. The layers, highest precedence first:
//
//   dir    <dir>/.s3cab/env       per-backup-folder — which bucket this folder
//                                  backs up to (S3CAB_BUCKET) + any local override
//   bucket ~/.s3cab/env.<bucket>  per-bucket — how to authenticate to a bucket
//                                  (AWS_PROFILE / region / endpoint / keys); the
//                                  bucket is the natural auth boundary
//   user   ~/.s3cab/env           per-user defaults
//   shell  process.env            the real environment (lowest — files win)
//
// Files are authoritative over the shell: a value you put in a file always wins.
// Parsed with the built-in `util.parseEnv` — no dotenv dep (#5) — so the per-key
// precedence above is enforced by *us*, independent of any one loader's fixed
// override semantics. The per-bucket file can't name its own bucket (circular):
// the bucket is resolved from an explicit name or the dir/user/shell layers
// first, then its env file is loaded.

/** s3cab's own config/state dir, `~/.s3cab` (never `~/.aws`, which stays user-owned). */
const s3cabDir = () => join(homedir(), ".s3cab");
const userEnvPath = () => join(s3cabDir(), "env");
/**
 * The per-bucket env file `~/.s3cab/env.<bucket>`. The bucket name must be a
 * single path segment — it is interpolated into the filename — so reject one
 * carrying a path separator: otherwise a hostile folder env's `S3CAB_BUCKET`
 * (e.g. `a/../../../etc/passwd`) could traverse out of `~/.s3cab` and make
 * `loadEnv` read an arbitrary file. `basename` uses the same platform path
 * semantics as the `join` below, so it catches exactly the separators that could
 * traverse here; a clean single-segment name is its own basename (dots are fine).
 * @param {string} bucket
 */
const bucketEnvPath = (bucket) => {
  if (basename(bucket) !== bucket) {
    throw new Error(
      `Invalid bucket name (contains a path separator): ${bucket}`,
    );
  }
  return join(s3cabDir(), `env.${bucket}`);
};

/**
 * Parse an env file into a plain object, or `{}` if it doesn't exist. Synchronous
 * because `loadEnv` runs on the synchronous client-construction path.
 * @param {string} path
 * @returns {NodeJS.Dict<string>}
 */
function parseEnvFile(path) {
  try {
    return parseEnv(readFileSync(path, "utf8"));
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code === "ENOENT") {
      return {};
    }
    throw error;
  }
}

/** Absolute paths of env files already merged into process.env this run. */
const appliedEnvFiles = new Set();

/**
 * Merge one parsed env layer into process.env, once. Skipping an already-applied
 * file is what keeps precedence correct across multiple `loadEnv` calls: a later
 * call must not re-apply a lower layer over a higher one set by an earlier call.
 *
 * A missing/empty file (`{}`) is *not* recorded as applied — there was nothing to
 * apply, so a file created later in the same process (e.g. by a future `setup`)
 * still loads on a subsequent call instead of being skipped forever.
 * @param {string} path
 * @param {NodeJS.Dict<string>} values
 */
function applyEnvLayer(path, values) {
  if (appliedEnvFiles.has(path)) return;
  if (Object.keys(values).length === 0) return;
  appliedEnvFiles.add(path);
  Object.assign(process.env, values);
}

/**
 * Load s3cab's layered env files into process.env (see the layer table above).
 * Must run before any AWS client is built so the resolved AWS_* / endpoint /
 * region values are in place. Idempotent per file.
 *
 * Called with no scope it applies only the per-user layer; the per-bucket file is
 * loaded only when there is an authoritative bucket — an explicit name, or one
 * resolved from a backup dir — so a no-scope call never pulls in some default
 * bucket's auth file by accident.
 *
 * @param {object} [scope]
 * @param {string} [scope.dir] - A backup directory, enabling its `<dir>/.s3cab/env`.
 * @param {string} [scope.bucket] - A known bucket name (e.g. a CLI `<bucket>` arg),
 *   used to load `~/.s3cab/env.<bucket>` directly instead of deriving it.
 * @returns {{ bucket: string | undefined }} The bucket this scope resolves to, if any.
 */
export function loadEnv({ dir, bucket } = {}) {
  const user = parseEnvFile(userEnvPath());
  // resolve() (not join()) so the guard key is canonical/absolute even when a
  // caller passes a relative dir — keeps the dedup robust and the comment honest.
  const folderPath = dir ? resolve(dir, ".s3cab", "env") : undefined;
  const folder = folderPath ? parseEnvFile(folderPath) : {};

  // Apply the user layer first so higher layers (bucket, then dir) overwrite it.
  applyEnvLayer(userEnvPath(), user);

  // Resolve the operation's bucket only from authoritative signals — an explicit
  // name or a backup dir. A bare user/shell S3CAB_BUCKET default is not enough to
  // justify loading a specific bucket's auth file from a no-scope safety call.
  let resolvedBucket = bucket;
  if (!resolvedBucket && dir) {
    resolvedBucket =
      folder.S3CAB_BUCKET ?? user.S3CAB_BUCKET ?? process.env.S3CAB_BUCKET;
  }

  if (resolvedBucket) {
    const path = bucketEnvPath(resolvedBucket);
    applyEnvLayer(path, parseEnvFile(path));
  }
  if (folderPath) applyEnvLayer(folderPath, folder);

  return { bucket: resolvedBucket };
}

const NO_CREDENTIALS_MESSAGE = `No AWS credentials found.

s3cab tried:
  1. s3cab env files / environment variables
  2. Standard AWS SDK credential resolution
  3. Cached credentials from \`s3cab login\`

To continue, do one of the following:
  - create ~/.s3cab/env with AWS_* variables (or AWS_PROFILE)
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
