#!/usr/bin/env node
// Standalone AWS login — mirrors `aws login` (requires AWS CLI ≥ 2.32.0)
// OAuth 2.0 Authorization Code + PKCE + DPoP flow against the AWS Sign-In
// service.  Writes temporary credentials to ~/.aws/login/cache/ and sets
// login_session in ~/.aws/config, exactly as the AWS CLI does.
//
// Usage:
//   node scripts/login.mjs [--profile <name>] [--region <region>] [--remote]
//
//   --profile  AWS profile to update (default: "default")
//   --region   AWS region (falls back to profile's region setting)
//   --remote   Cross-device flow: prints URL + prompts for browser code
//              instead of spinning up a local callback server

import { createServer } from "node:http";
import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
  sign as ecSign,
} from "node:crypto";
import { execSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    profile: { type: "string", short: "p", default: "default" },
    region: { type: "string" },
    remote: { type: "boolean", default: false },
  },
  allowPositionals: false,
});

// base64url without padding
function b64url(data) {
  return (Buffer.isBuffer(data) ? data : Buffer.from(data)).toString("base64url");
}

// Parse ~/.aws/config (INI format)
function readAwsConfig() {
  let text = "";
  try {
    text = readFileSync(join(homedir(), ".aws", "config"), "utf8");
  } catch {
    return {};
  }
  const sections = {};
  let cur = null;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    const m = line.match(/^\[(.+)\]$/);
    if (m) { cur = m[1]; sections[cur] = {}; }
    else if (cur) {
      const eq = line.indexOf("=");
      if (eq > 0) sections[cur][line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
    }
  }
  return sections;
}

// Set key = value in the named profile in ~/.aws/config
function setAwsConfigValue(profileName, key, value) {
  const configPath = join(homedir(), ".aws", "config");
  let text = "";
  try { text = readFileSync(configPath, "utf8"); } catch {}

  const header = profileName === "default" ? "[default]" : `[profile ${profileName}]`;
  const lines = text.split("\n");
  const secIdx = lines.findIndex((l) => l.trim() === header);

  if (secIdx === -1) {
    text = text.trimEnd() + `\n\n${header}\n${key} = ${value}\n`;
  } else {
    let found = false;
    for (let i = secIdx + 1; i < lines.length; i++) {
      if (lines[i].trim().startsWith("[")) break;
      if (lines[i].trim().startsWith(key)) { lines[i] = `${key} = ${value}`; found = true; break; }
    }
    if (!found) lines.splice(secIdx + 1, 0, `${key} = ${value}`);
    text = lines.join("\n");
  }

  mkdirSync(join(homedir(), ".aws"), { recursive: true });
  writeFileSync(configPath, text);
}

// Write token JSON to ~/.aws/login/cache/<sanitised-session-id>.json
function cacheToken(sessionId, token) {
  const dir = process.env.AWS_LOGIN_CACHE_DIRECTORY ?? join(homedir(), ".aws", "login", "cache");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  // Matches botocore JSONFileCache key sanitisation: colons and slashes → dashes
  const file = sessionId.replaceAll(":", "-").replaceAll("/", "-") + ".json";
  writeFileSync(join(dir, file), JSON.stringify(token, null, 2), { mode: 0o600 });
}

// Open URL in the default browser
function openBrowser(url) {
  const cmd =
    process.platform === "win32" ? `start "" "${url}"`
    : process.platform === "darwin" ? `open "${url}"`
    : `xdg-open "${url}"`;
  try { execSync(cmd, { stdio: "ignore" }); } catch {}
}

// Spin up a one-shot local HTTP server and return the port + a promise that
// resolves with { code, state } when the browser redirect arrives.
function startCallbackServer() {
  let resolve;
  const waitForCode = new Promise((r) => { resolve = r; });
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end("<h1>Login complete. You can close this tab.</h1>");
    server.close();
    resolve({ code: url.searchParams.get("code"), state: url.searchParams.get("state") });
  });
  server.listen(0, "127.0.0.1");
  const port = new Promise((r) => server.once("listening", () => r(server.address().port)));
  return { port, waitForCode };
}

// Build a DPoP proof JWT (ES256) for the token endpoint POST
function makeDpopJwt(privateKey, publicJwk, tokenEndpoint) {
  const hdr = b64url(JSON.stringify({ alg: "ES256", typ: "dpop+jwt", jwk: publicJwk }));
  const pay = b64url(JSON.stringify({
    jti: randomUUID(),
    htm: "POST",
    htu: tokenEndpoint,
    iat: Math.floor(Date.now() / 1000),
  }));
  // ieee-p1363 gives the raw r||s signature format required by ES256
  const sig = ecSign("SHA256", Buffer.from(`${hdr}.${pay}`), {
    key: privateKey,
    dsaEncoding: "ieee-p1363",
  });
  return `${hdr}.${pay}.${b64url(sig)}`;
}

// Decode the JWT payload section (no verification needed — we just issued it)
function jwtPayload(jwt) {
  return JSON.parse(Buffer.from(jwt.split(".")[1], "base64url").toString());
}

// Export EC private key as SEC1 PEM so it can be stored in the cache for
// subsequent refresh calls (same format as the AWS CLI stores it)
function toPem(privateKey) {
  const der = privateKey.export({ format: "der", type: "sec1" });
  return [
    "-----BEGIN EC PRIVATE KEY-----",
    ...der.toString("base64").match(/.{1,64}/g),
    "-----END EC PRIVATE KEY-----",
    "",
  ].join("\n");
}

// ── Resolve configuration ─────────────────────────────────────────────────────

const profileName = values.profile;
const isRemote = values.remote;

let region = values.region;
if (!region) {
  const cfg = readAwsConfig();
  const key = profileName === "default" ? "default" : `profile ${profileName}`;
  region = cfg[key]?.region;
}
if (!region) {
  throw new Error(
    "No AWS region found. Use --region <region> or set region in your AWS profile.",
  );
}

const baseEndpoint = `https://${region}.signin.aws.amazon.com`;
const tokenEndpoint = `${baseEndpoint}/v1/token`;
const clientId = isRemote
  ? "arn:aws:signin:::devtools/cross-device"
  : "arn:aws:signin:::devtools/same-device";

// ── PKCE ─────────────────────────────────────────────────────────────────────

const PKCE_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";
const codeVerifier = Array.from(randomBytes(64), (b) => PKCE_CHARS[b % PKCE_CHARS.length]).join("");
const codeChallenge = b64url(createHash("sha256").update(codeVerifier).digest());

// ── DPoP key pair ─────────────────────────────────────────────────────────────

const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
const { kty, crv, x, y } = publicKey.export({ format: "jwk" });
const publicJwk = { kty, crv, x, y }; // public fields only for DPoP header

// ── Authorization ─────────────────────────────────────────────────────────────

const state = randomUUID();
let redirectUri, authCode;

if (isRemote) {
  // Cross-device: user opens the URL on another device and pastes back a
  // base64-encoded "state=<uuid>&code=<code>" string.
  redirectUri = `${baseEndpoint}/v1/sessions/confirmation`;

  const authUrl =
    `${baseEndpoint}/v1/authorize?` +
    new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      state,
      code_challenge_method: "SHA-256",
      code_challenge: codeChallenge,
      scope: "openid",
      redirect_uri: redirectUri,
    });

  console.log(`\nOpen this URL in your browser:\n\n  ${authUrl}\n`);

  const rl = createInterface({ input, output });
  const raw = await rl.question("Paste the authorization code shown in your browser: ");
  rl.close();

  const decoded = Buffer.from(raw.trim(), "base64").toString();
  const params = Object.fromEntries(new URLSearchParams(decoded));
  if (params.state !== state) throw new Error(`State mismatch (expected ${state})`);
  authCode = params.code;
} else {
  // Same-device: spin up a local server to receive the browser redirect.
  const { port: portPromise, waitForCode } = startCallbackServer();
  const port = await portPromise;
  redirectUri = `http://127.0.0.1:${port}`;

  const authUrl =
    `${baseEndpoint}/v1/authorize?` +
    new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      state,
      code_challenge_method: "SHA-256",
      code_challenge: codeChallenge,
      scope: "openid",
      redirect_uri: redirectUri,
    });

  console.log(`\nOpening AWS sign-in page in your browser...`);
  console.log(`If it doesn't open, visit:\n\n  ${authUrl}\n`);
  openBrowser(authUrl);

  const { code, state: returnedState } = await waitForCode;
  if (!code) throw new Error("No authorization code received from browser redirect.");
  if (returnedState !== state) throw new Error(`State mismatch (expected ${state})`);
  authCode = code;
}

// ── Token exchange ────────────────────────────────────────────────────────────

const dpopJwt = makeDpopJwt(privateKey, publicJwk, tokenEndpoint);

const resp = await fetch(tokenEndpoint, {
  method: "POST",
  headers: { "Content-Type": "application/json", DPoP: dpopJwt },
  body: JSON.stringify({
    clientId,
    grantType: "authorization_code",
    code: authCode,
    codeVerifier,
    redirectUri,
  }),
});

if (!resp.ok) {
  const body = await resp.text();
  throw new Error(`Token exchange failed (HTTP ${resp.status}): ${body}`);
}

const data = await resp.json();

// ── Parse response & cache ────────────────────────────────────────────────────

// The idToken's "sub" claim is the login session ARN (used as cache key and
// written to ~/.aws/config as login_session).
const { sub: sessionId } = jwtPayload(data.idToken);
const accountId = sessionId.split(":")[4]; // account field of the ARN

const expiresAt = new Date(Date.now() + data.expiresIn * 1000)
  .toISOString()
  .replace(/\.\d{3}Z$/, "Z");

cacheToken(sessionId, {
  accessToken: {
    accessKeyId: data.accessToken.accessKeyId,
    secretAccessKey: data.accessToken.secretAccessKey,
    sessionToken: data.accessToken.sessionToken,
    accountId,
    expiresAt,
  },
  tokenType: data.tokenType,
  clientId,
  refreshToken: data.refreshToken,
  idToken: data.idToken,
  // Stored so the CLI can build DPoP proofs for subsequent refresh calls
  dpopKey: toPem(privateKey),
});

setAwsConfigValue(profileName, "login_session", sessionId);

console.log(`\nSuccessfully logged in.`);
console.log(`Profile "${profileName}" now uses session: ${sessionId}`);
console.log(`Credentials expire at: ${expiresAt}`);
if (profileName !== "default") {
  console.log(`\nUse --profile ${profileName} with AWS CLI/SDK commands.`);
}
