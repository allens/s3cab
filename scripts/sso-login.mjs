#!/usr/bin/env node
// Standalone AWS SSO login — mirrors `aws sso login`
// Usage: node scripts/sso-login.mjs [--profile <name>]

import {
  CreateTokenCommand,
  RegisterClientCommand,
  SSOOIDCClient,
  StartDeviceAuthorizationCommand,
} from "@aws-sdk/client-sso-oidc";
import { createHash } from "node:crypto";
import { execSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: { profile: { type: "string", short: "p", default: "default" } },
  allowPositionals: false,
});

// Parse ~/.aws/config (INI format)
function readAwsConfig() {
  let text = "";
  try {
    text = readFileSync(join(homedir(), ".aws", "config"), "utf8");
  } catch (e) {
    throw new Error(
      `Unable to read AWS config (~/.aws/config): ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  const sections = {};
  let current = null;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    const section = line.match(/^\[(.+)\]$/);
    if (section) {
      current = section[1];
      sections[current] = {};
    } else if (current) {
      const eq = line.indexOf("=");
      if (eq > 0) sections[current][line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
    }
  }
  return sections;
}

const profileName = values.profile;
const config = readAwsConfig();
const sectionKey = profileName === "default" ? "default" : `profile ${profileName}`;
const profile = config[sectionKey];

if (!profile) throw new Error(`Profile "${profileName}" not found in ~/.aws/config`);

const startUrl = profile.sso_start_url;
const region = profile.sso_region;

if (!startUrl) throw new Error(`sso_start_url missing in profile "${profileName}"`);
if (!region) throw new Error(`sso_region missing in profile "${profileName}"`);

// Open URL in the default browser
function openBrowser(url) {
  const cmd =
    process.platform === "win32"
      ? `start "" "${url}"`
      : process.platform === "darwin"
        ? `open "${url}"`
        : `xdg-open "${url}"`;
  try {
    execSync(cmd, { stdio: "ignore" });
  } catch {}
}

// Write token to ~/.aws/sso/cache/<sha1(startUrl)>.json (same location as AWS CLI)
function cacheToken(accessToken, expiresIn) {
  const cacheDir = join(homedir(), ".aws", "sso", "cache");
  mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
  const key = createHash("sha1").update(startUrl).digest("hex");
  const expiresAt = new Date(Date.now() + expiresIn * 1000).toISOString();
  writeFileSync(
    join(cacheDir, `${key}.json`),
    JSON.stringify({ startUrl, region, accessToken, expiresAt }, null, 2),
    { mode: 0o600 },
  );
  return expiresAt;
}

const oidc = new SSOOIDCClient({ region });

const { clientId, clientSecret } = await oidc.send(
  new RegisterClientCommand({ clientName: "s3cab", clientType: "public", scopes: ["sso:account:access"] }),
);

const { deviceCode, verificationUriComplete, userCode, interval = 5 } = await oidc.send(
  new StartDeviceAuthorizationCommand({ clientId, clientSecret, startUrl }),
);

console.log(`\nOpening SSO authorization page in your browser.`);
console.log(`If it doesn't open, visit:\n\n  ${verificationUriComplete}\n`);
console.log(`Confirmation code: ${userCode}\n`);
openBrowser(verificationUriComplete);

// Poll until the user approves or an error other than "pending" occurs
let pollMs = interval * 1000;
for (;;) {
  await new Promise((r) => setTimeout(r, pollMs));
  try {
    const { accessToken, expiresIn } = await oidc.send(
      new CreateTokenCommand({
        clientId,
        clientSecret,
        deviceCode,
        grantType: "urn:ietf:params:oauth:grant-type:device_code",
      }),
    );
    const expiresAt = cacheToken(accessToken, expiresIn);
    console.log(`Successfully logged into: ${startUrl}`);
    console.log(`Token expires at: ${expiresAt}`);
    break;
  } catch (e) {
    if (e.name === "AuthorizationPendingException") continue;
    if (e.name === "SlowDownException") {
      pollMs += 5000;
      continue;
    }
    throw e;
  }
}
